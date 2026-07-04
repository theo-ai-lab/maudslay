/**
 * T3 executor tests. The sandbox and executor logic is exercised with a fake
 * page (no browser). One guarded integration test drives real chromium through
 * a throwaway http server and SKIPS cleanly if a browser cannot launch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type {
  CUAction,
  ApprovalRequest,
  ApprovalDecision,
  TrajectoryLine,
} from '../src/types.ts';
import {
  Sandbox,
  defaultSandboxConfig,
  autoApproveCallback,
  denyAllCallback,
} from '../executor/sandbox.ts';
import type { ApprovalCallback } from '../executor/sandbox.ts';
import { Executor, createBrowserExecutor } from '../executor/tools.ts';
import type { ExecutorPage, GuardReader } from '../executor/tools.ts';
import { Recorder } from '../executor/recorder.ts';
import { launchBrowser } from '../executor/browser.ts';

// --- fakes -----------------------------------------------------------------

class FakePage implements ExecutorPage {
  currentUrl: string;
  readonly clicks: Array<[number, number]> = [];
  readonly dblclicks: Array<[number, number]> = [];
  readonly wheels: Array<[number, number]> = [];
  readonly typed: string[] = [];
  readonly keys: string[] = [];
  shotBytes: Uint8Array;
  shots = 0;

  constructor(url: string) {
    this.currentUrl = url;
    this.shotBytes = new Uint8Array([137, 80, 78, 71]); // "PNG" magic-ish
  }

  url(): string {
    return this.currentUrl;
  }

  mouse = {
    click: async (x: number, y: number): Promise<void> => {
      this.clicks.push([x, y]);
    },
    dblclick: async (x: number, y: number): Promise<void> => {
      this.dblclicks.push([x, y]);
    },
    wheel: async (dx: number, dy: number): Promise<void> => {
      this.wheels.push([dx, dy]);
    },
  };

  keyboard = {
    type: async (text: string): Promise<void> => {
      this.typed.push(text);
    },
    press: async (key: string): Promise<void> => {
      this.keys.push(key);
    },
  };

  async screenshot(): Promise<Uint8Array> {
    this.shots += 1;
    return this.shotBytes;
  }
}

const ALLOWED = 'http://127.0.0.1:4380';

function recordingApproval(log: ApprovalRequest[], decision: 'approve' | 'deny'): ApprovalCallback {
  return async (req) => {
    log.push(req);
    if (decision === 'approve') {
      return { id: req.id, decision: 'approve', decidedBy: 'test', decidedAt: 'now' };
    }
    return { id: req.id, decision: 'deny', reason: 'test-deny', decidedBy: 'test', decidedAt: 'now' };
  };
}

const noGuard: GuardReader = async () => null;
function guardReturning(value: string | null): GuardReader {
  return async () => value;
}

// --- sandbox: origin -------------------------------------------------------

test('checkOrigin allows the exact allowlisted origin', () => {
  const s = new Sandbox(defaultSandboxConfig(), denyAllCallback);
  assert.equal(s.checkOrigin('http://127.0.0.1:4380/new'), null);
  assert.equal(s.checkOrigin('http://127.0.0.1:4380/booking/HD-000001'), null);
});

test('checkOrigin denies other hosts, ports, schemes and junk', () => {
  const s = new Sandbox(defaultSandboxConfig(), denyAllCallback);
  for (const url of [
    'http://127.0.0.1:4381/state', // admin port is off-limits to the agent
    'http://localhost:4380/', // different host string, even if it resolves same
    'https://127.0.0.1:4380/',
    'http://evil.example/',
    'about:blank',
    'not a url',
  ]) {
    const block = s.checkOrigin(url);
    assert.ok(block, `expected block for ${url}`);
    assert.equal(block.rule, 'origin_denied');
  }
});

// --- sandbox: bounds -------------------------------------------------------

test('checkBounds accepts in-viewport coordinates', () => {
  const s = new Sandbox(defaultSandboxConfig(), denyAllCallback);
  assert.equal(s.checkBounds(0, 0), null);
  assert.equal(s.checkBounds(1279, 799), null);
  assert.equal(s.checkBounds(640, 400), null);
});

test('checkBounds rejects out-of-viewport, negative, and non-finite coords', () => {
  const s = new Sandbox(defaultSandboxConfig(), denyAllCallback);
  for (const [x, y] of [
    [1280, 400],
    [640, 800],
    [-1, 10],
    [10, -1],
    [Number.NaN, 10],
    [10, Number.POSITIVE_INFINITY],
  ] as Array<[number, number]>) {
    const block = s.checkBounds(x, y);
    assert.ok(block, `expected bounds block for (${x},${y})`);
    assert.equal(block.rule, 'viewport_bounds');
  }
});

// --- sandbox: budget -------------------------------------------------------

test('consumeBudget allows exactly actionBudget attempts then blocks', () => {
  const s = new Sandbox(defaultSandboxConfig({ actionBudget: 3 }), denyAllCallback);
  assert.equal(s.consumeBudget(), null);
  assert.equal(s.consumeBudget(), null);
  assert.equal(s.consumeBudget(), null);
  assert.equal(s.budgetRemaining(), 0);
  const block = s.consumeBudget();
  assert.ok(block);
  assert.equal(block.rule, 'action_budget_exhausted');
  assert.equal(s.budgetUsed(), 3);
});

// --- sandbox: guard classification & resolution ----------------------------

test('classifyGuard: irreversible requires approval, others allow by default', () => {
  const s = new Sandbox(defaultSandboxConfig(), denyAllCallback);
  assert.equal(s.classifyGuard('irreversible'), 'require_approval');
  assert.equal(s.classifyGuard('reversible'), 'allow');
  assert.equal(s.classifyGuard(null), 'allow');
  assert.equal(s.classifyGuard('unknown-marker'), 'allow');
});

test('classifyGuard is config-driven for live mode', () => {
  const s = new Sandbox(
    defaultSandboxConfig({ guardRules: { danger: 'require_approval', 'soft-confirm': 'allow' } }),
    denyAllCallback,
  );
  assert.equal(s.classifyGuard('danger'), 'require_approval');
  assert.equal(s.classifyGuard('soft-confirm'), 'allow');
  // irreversible is no longer in the map -> defaults to allow under this config
  assert.equal(s.classifyGuard('irreversible'), 'allow');
});

test('resolveGuard: allow disposition never calls approval', async () => {
  const log: ApprovalRequest[] = [];
  const s = new Sandbox(defaultSandboxConfig(), recordingApproval(log, 'deny'));
  const block = await s.resolveGuard('reversible', 'task-1', 'click');
  assert.equal(block, null);
  assert.equal(log.length, 0);
});

test('resolveGuard: approve lets the click through and records the decision', async () => {
  const log: ApprovalRequest[] = [];
  const s = new Sandbox(defaultSandboxConfig(), recordingApproval(log, 'approve'));
  const block = await s.resolveGuard('irreversible', 'task-1', 'confirm booking');
  assert.equal(block, null);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.taskId, 'task-1');
  assert.equal(s.approvals.length, 1);
  assert.equal(s.approvals[0]?.decision, 'approve');
});

test('resolveGuard: deny returns approval_required with a matching approvalId', async () => {
  const log: ApprovalRequest[] = [];
  const s = new Sandbox(defaultSandboxConfig(), recordingApproval(log, 'deny'));
  const block = await s.resolveGuard('irreversible', 'task-9', 'confirm booking');
  assert.ok(block);
  assert.equal(block.rule, 'approval_required');
  if (block.rule === 'approval_required') {
    assert.equal(block.approvalId, log[0]?.id);
  }
});

test('resolveGuard: forceApproval overrides an allow classification (fail-closed)', async () => {
  const log: ApprovalRequest[] = [];
  const s = new Sandbox(defaultSandboxConfig(), recordingApproval(log, 'deny'));
  const block = await s.resolveGuard(null, 'task-1', 'click (guard read failed)', true);
  assert.ok(block);
  assert.equal(block.rule, 'approval_required');
  assert.equal(log.length, 1);
});

// --- executor over the fake page -------------------------------------------

function mkExecutor(
  page: FakePage,
  approve: ApprovalCallback,
  guard: GuardReader,
  budget = 40,
): Executor {
  const sandbox = new Sandbox(defaultSandboxConfig({ actionBudget: budget }), approve);
  return new Executor({ page, sandbox, readGuardAt: guard, taskId: 'task-exec' });
}

test('execute: plain click on an unguarded coord performs and returns an obs', async () => {
  const page = new FakePage(`${ALLOWED}/new`);
  const ex = mkExecutor(page, denyAllCallback, noGuard);
  const action: CUAction = { kind: 'click', x: 100, y: 120 };
  const { result, obs } = await ex.execute(action);
  assert.equal(result.ok, true);
  assert.equal(result.blocked, undefined);
  assert.deepEqual(page.clicks, [[100, 120]]);
  assert.equal(obs.url, `${ALLOWED}/new`);
  assert.equal(obs.stepIndex, 1);
  assert.match(obs.screenshotSha256, /^[0-9a-f]{64}$/);
  assert.ok(obs.screenshotB64.length > 0);
  // base64 decodes back to the fake PNG bytes
  assert.deepEqual(Buffer.from(obs.screenshotB64, 'base64'), Buffer.from(page.shotBytes));
});

test('execute: irreversible click is blocked when approval is denied', async () => {
  const page = new FakePage(`${ALLOWED}/new/confirm`);
  const ex = mkExecutor(page, denyAllCallback, guardReturning('irreversible'));
  const { result } = await ex.execute({ kind: 'click', x: 300, y: 300 });
  assert.equal(result.ok, false);
  assert.ok(result.blocked);
  assert.equal(result.blocked?.rule, 'approval_required');
  // the one-way door was NOT opened
  assert.equal(page.clicks.length, 0);
});

test('execute: irreversible click proceeds when approval is granted', async () => {
  const page = new FakePage(`${ALLOWED}/new/confirm`);
  const ex = mkExecutor(page, autoApproveCallback, guardReturning('irreversible'));
  const { result } = await ex.execute({ kind: 'click', x: 300, y: 300 });
  assert.equal(result.ok, true);
  assert.deepEqual(page.clicks, [[300, 300]]);
});

test('execute: out-of-bounds click is blocked before touching the page', async () => {
  const page = new FakePage(`${ALLOWED}/`);
  const ex = mkExecutor(page, autoApproveCallback, noGuard);
  const { result } = await ex.execute({ kind: 'click', x: 5000, y: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.blocked?.rule, 'viewport_bounds');
  assert.equal(page.clicks.length, 0);
});

test('execute: interacting off-origin is denied', async () => {
  const page = new FakePage('http://127.0.0.1:4381/state'); // admin port
  const ex = mkExecutor(page, autoApproveCallback, noGuard);
  const { result } = await ex.execute({ kind: 'click', x: 10, y: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.blocked?.rule, 'origin_denied');
  assert.equal(page.clicks.length, 0);
});

test('execute: type and key reach the keyboard on the allowed origin', async () => {
  const page = new FakePage(`${ALLOWED}/new`);
  const ex = mkExecutor(page, denyAllCallback, noGuard);
  await ex.execute({ kind: 'type', text: 'Ada Lovelace' });
  await ex.execute({ kind: 'key', combo: 'Tab' });
  await ex.execute({ kind: 'scroll', dx: 0, dy: 240 });
  assert.deepEqual(page.typed, ['Ada Lovelace']);
  assert.deepEqual(page.keys, ['Tab']);
  assert.deepEqual(page.wheels, [[0, 240]]);
});

test('execute: budget exhaustion blocks further actions', async () => {
  const page = new FakePage(`${ALLOWED}/`);
  const ex = mkExecutor(page, denyAllCallback, noGuard, 2);
  const a = await ex.execute({ kind: 'screenshot' });
  const b = await ex.execute({ kind: 'screenshot' });
  const c = await ex.execute({ kind: 'screenshot' });
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.equal(c.result.ok, false);
  assert.equal(c.result.blocked?.rule, 'action_budget_exhausted');
});

test('execute: escalate and done end without page interaction or budget spend', async () => {
  const page = new FakePage('about:blank'); // deliberately off-origin
  const ex = mkExecutor(page, denyAllCallback, noGuard, 1);
  const esc = await ex.execute({ kind: 'escalate', reason: 'ambiguous customer' });
  assert.equal(esc.result.ok, true);
  assert.equal(esc.result.blocked, undefined);
  const done = await ex.execute({ kind: 'done', summary: 'booked HD-000123' });
  assert.equal(done.result.ok, true);
  assert.equal(page.clicks.length, 0);
});

test('execute: fail-closed forces approval when the guard read throws', async () => {
  const page = new FakePage(`${ALLOWED}/new/confirm`);
  const throwingGuard: GuardReader = async () => {
    throw new Error('evaluate failed');
  };
  const log: ApprovalRequest[] = [];
  const sandbox = new Sandbox(
    defaultSandboxConfig({ failClosedOnGuardError: true }),
    recordingApproval(log, 'deny'),
  );
  const ex = new Executor({ page, sandbox, readGuardAt: throwingGuard, taskId: 't' });
  const { result } = await ex.execute({ kind: 'click', x: 50, y: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.blocked?.rule, 'approval_required');
  assert.equal(log.length, 1);
  assert.equal(page.clicks.length, 0);
});

// --- recorder --------------------------------------------------------------

test('recorder writes one parseable TrajectoryLine per executed step', async () => {
  const path = join(tmpdir(), `maudslay-traj-${randomUUID()}.jsonl`);
  try {
    const rec = new Recorder(path);
    const page = new FakePage(`${ALLOWED}/new`);
    const sandbox = new Sandbox(defaultSandboxConfig(), denyAllCallback);
    const ex = new Executor({ page, sandbox, readGuardAt: noGuard, taskId: 'rec', recorder: rec });
    await ex.execute({ kind: 'type', text: 'hello' });
    await ex.execute({ kind: 'click', x: 10, y: 10 });

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const parsed = lines.map((l) => JSON.parse(l) as TrajectoryLine);
    for (const line of parsed) {
      assert.equal(line.t, 'step');
    }
    const first = parsed[0];
    assert.ok(first && first.t === 'step');
    if (first.t === 'step') {
      assert.equal(first.v.action.kind, 'type');
      assert.equal(first.v.i, 1);
      assert.match(first.v.obs.screenshotSha256, /^[0-9a-f]{64}$/);
      assert.equal(first.v.result.ok, true);
    }
  } finally {
    rmSync(path, { force: true });
  }
});

// --- real browser (skips cleanly without chromium) -------------------------

const GUARD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>
<body style="margin:0">
<button id="safe" style="position:absolute;left:20px;top:20px;width:120px;height:44px">Save draft</button>
<button id="commit" data-guard="irreversible"
  style="position:absolute;left:300px;top:300px;width:200px;height:60px">
  <span id="label">Confirm booking</span>
</button>
</body></html>`;

test('integration: real chromium reads data-guard via elementFromPoint', async (t) => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(GUARD_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  let session;
  try {
    session = await launchBrowser({ headless: true });
  } catch (err) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.skip(`chromium unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    await session.page.goto(`${origin}/`);

    // Deny approvals: the irreversible commit button must be blocked.
    const denyLog: ApprovalRequest[] = [];
    const denySandbox = new Sandbox(
      defaultSandboxConfig({ allowedOrigin: origin }),
      recordingApproval(denyLog, 'deny'),
    );
    const denyExec = createBrowserExecutor(session.page, denySandbox, 'integration');

    // A screenshot is a real 1280x800 PNG.
    const shot = await denyExec.execute({ kind: 'screenshot' });
    const bytes = Buffer.from(shot.obs.screenshotB64, 'base64');
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.match(shot.obs.screenshotSha256, /^[0-9a-f]{64}$/);

    // Click inside the commit button (its label span sits inside [data-guard]).
    const commitClick = await denyExec.execute({ kind: 'click', x: 400, y: 330 });
    assert.equal(commitClick.result.ok, false);
    assert.equal(commitClick.result.blocked?.rule, 'approval_required');
    assert.equal(denyLog.length, 1, 'approval must have been requested for the guarded click');

    // Click the safe (unguarded) button — allowed straight through.
    const approveSandbox = new Sandbox(
      defaultSandboxConfig({ allowedOrigin: origin }),
      autoApproveCallback,
    );
    const approveExec = createBrowserExecutor(session.page, approveSandbox, 'integration');
    const safeClick = await approveExec.execute({ kind: 'click', x: 80, y: 42 });
    assert.equal(safeClick.result.ok, true);

    // And an approved irreversible click goes through.
    const commitApproved = await approveExec.execute({ kind: 'click', x: 400, y: 330 });
    assert.equal(commitApproved.result.ok, true);
  } finally {
    await session.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
