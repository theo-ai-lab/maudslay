/**
 * T4 (agent) tests — all deterministic, no network, no browser.
 *  - D4 action translation (model action JSON -> CUAction), exhaustive.
 *  - stub-policy replay against a hand-built golden with a fake executor.
 *  - approval policies (auto-log fully; cli/mcp via injected I/O).
 *  - request-body construction + response parsing (pure, no API call).
 *  - the observe->act loop over a fake model + fake executor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  translateComputerAction,
  translateToolCall,
  runLoop,
  SCROLL_PX_PER_UNIT,
} from '../agent/loop.ts';
import type { ExecutorLike } from '../agent/loop.ts';
import { replayTrajectory } from '../agent/stub-policy.ts';
import type { ReplayStep } from '../agent/stub-policy.ts';
import { createApprovalHandler } from '../agent/approval.ts';
import {
  buildRequestBody,
  mapEffort,
  parseResponse,
  COMPUTER_TOOL,
  ESCALATE_TOOL,
  DONE_TOOL,
  COMPUTER_USE_BETA,
  SERVER_SIDE_FALLBACK_BETA,
} from '../agent/model.ts';
import type {
  AgentModel,
  ModelTurn,
  ModelToolCall,
  ToolResultInput,
  RawModelResponse,
} from '../agent/model.ts';
import type {
  CUAction,
  Observation,
  ActionResult,
  SandboxBlock,
  ModelConfig,
  ApprovalRequest,
  ApprovalDecision,
} from '../src/types.ts';

// --------------------------------------------------------------------------
// Fakes
// --------------------------------------------------------------------------

function makeObs(hash: string, url = 'http://127.0.0.1:4380/'): Observation {
  return { screenshotB64: `png:${hash}`, screenshotSha256: hash, url, stepIndex: 0 };
}

class FakeExecutor implements ExecutorLike {
  calls: CUAction[] = [];
  private hashes: string[];
  private budget: number;

  constructor(hashes: string[] = [], budget = 100) {
    this.hashes = [...hashes];
    this.budget = budget;
  }

  async execute(action: CUAction): Promise<{ result: ActionResult; obs: Observation }> {
    this.calls.push(action);
    if (this.calls.length > this.budget) {
      const blocked: SandboxBlock = {
        rule: 'action_budget_exhausted',
        detail: `budget ${this.budget} exhausted`,
      };
      return { result: { ok: false, blocked }, obs: makeObs('BUDGET') };
    }
    const next = this.hashes.shift();
    const hash = next ?? `h${this.calls.length}`;
    return { result: { ok: true }, obs: makeObs(hash) };
  }
}

/** Executor whose interacting actions are always blocked by a recoverable rule. */
class BoundsBlockingExecutor implements ExecutorLike {
  calls: CUAction[] = [];
  async execute(action: CUAction): Promise<{ result: ActionResult; obs: Observation }> {
    this.calls.push(action);
    if (action.kind === 'click') {
      const blocked: SandboxBlock = { rule: 'viewport_bounds', detail: 'out of bounds' };
      return { result: { ok: false, blocked }, obs: makeObs('same') };
    }
    return { result: { ok: true }, obs: makeObs(`h${this.calls.length}`) };
  }
}

function turn(calls: ModelToolCall[], opts: { refused?: boolean; text?: string } = {}): ModelTurn {
  const refused = opts.refused ?? false;
  const base: ModelTurn = {
    stopReason: refused ? 'refusal' : calls.length ? 'tool_use' : 'end_turn',
    refused,
    text: opts.text ?? '',
    toolCalls: calls,
    assistantContent: [],
  };
  if (refused) base.refusalDetail = 'policy';
  return base;
}

function computerCall(id: string, input: unknown): ModelToolCall {
  return { id, name: 'computer', input };
}

class ScriptedModel implements AgentModel {
  private turns: ModelTurn[];
  beginCalls = 0;
  nextCalls = 0;
  lastInstruction: string | null = null;
  lastResults: ToolResultInput[] | null = null;

  constructor(turns: ModelTurn[]) {
    this.turns = [...turns];
  }

  private pop(): ModelTurn {
    const t = this.turns.shift();
    if (!t) throw new Error('ScriptedModel ran out of turns');
    return t;
  }

  async begin(instruction: string, _firstObs: Observation): Promise<ModelTurn> {
    this.beginCalls += 1;
    this.lastInstruction = instruction;
    return this.pop();
  }

  async next(results: ToolResultInput[]): Promise<ModelTurn> {
    this.nextCalls += 1;
    this.lastResults = results;
    return this.pop();
  }
}

// Never terminates on its own — always proposes an unsupported action.
class AlwaysUnsupportedModel implements AgentModel {
  private n = 0;
  private mk(): ModelTurn {
    this.n += 1;
    return turn([computerCall(`c${this.n}`, { action: 'right_click', coordinate: [1, 1] })]);
  }
  async begin(): Promise<ModelTurn> {
    return this.mk();
  }
  async next(): Promise<ModelTurn> {
    return this.mk();
  }
}

class ThrowingModel implements AgentModel {
  async begin(): Promise<ModelTurn> {
    throw new Error('api down');
  }
  async next(): Promise<ModelTurn> {
    throw new Error('api down');
  }
}

function cfg(
  model: ModelConfig['model'],
  effort: ModelConfig['effort'],
  fallbackToOpus = false,
  maxTokensPerTurn = 4096,
): ModelConfig {
  return { model, effort, fallbackToOpus, maxTokensPerTurn };
}

// --------------------------------------------------------------------------
// D4 translation — directly-mapped actions
// --------------------------------------------------------------------------

test('translate: screenshot', () => {
  const r = translateComputerAction({ action: 'screenshot' });
  assert.deepEqual(r, { ok: true, action: { kind: 'screenshot' } });
});

test('translate: left_click -> click with coordinate', () => {
  const r = translateComputerAction({ action: 'left_click', coordinate: [640, 400] });
  assert.deepEqual(r, { ok: true, action: { kind: 'click', x: 640, y: 400 } });
});

test('translate: double_click -> double_click with coordinate', () => {
  const r = translateComputerAction({ action: 'double_click', coordinate: [12, 34] });
  assert.deepEqual(r, { ok: true, action: { kind: 'double_click', x: 12, y: 34 } });
});

test('translate: type -> type with text', () => {
  const r = translateComputerAction({ action: 'type', text: 'Jane Doe' });
  assert.deepEqual(r, { ok: true, action: { kind: 'type', text: 'Jane Doe' } });
});

test('translate: key -> key with combo (literal, no remapping)', () => {
  const r = translateComputerAction({ action: 'key', text: 'ctrl+a' });
  assert.deepEqual(r, { ok: true, action: { kind: 'key', combo: 'ctrl+a' } });
});

test('translate: wait -> wait, duration seconds -> ms', () => {
  const r = translateComputerAction({ action: 'wait', duration: 2 });
  assert.deepEqual(r, { ok: true, action: { kind: 'wait', ms: 2000 } });
});

test('translate: wait rounds fractional seconds', () => {
  const r = translateComputerAction({ action: 'wait', duration: 0.25 });
  assert.deepEqual(r, { ok: true, action: { kind: 'wait', ms: 250 } });
});

test('translate: scroll maps direction + amount to wheel deltas', () => {
  const down = translateComputerAction({
    action: 'scroll',
    coordinate: [100, 100],
    scroll_direction: 'down',
    scroll_amount: 3,
  });
  assert.deepEqual(down, {
    ok: true,
    action: { kind: 'scroll', dx: 0, dy: 3 * SCROLL_PX_PER_UNIT },
  });

  const up = translateComputerAction({
    action: 'scroll',
    scroll_direction: 'up',
    scroll_amount: 2,
  });
  assert.deepEqual(up, { ok: true, action: { kind: 'scroll', dx: 0, dy: -2 * SCROLL_PX_PER_UNIT } });

  const left = translateComputerAction({
    action: 'scroll',
    scroll_direction: 'left',
    scroll_amount: 1,
  });
  assert.deepEqual(left, {
    ok: true,
    action: { kind: 'scroll', dx: -SCROLL_PX_PER_UNIT, dy: 0 },
  });

  const right = translateComputerAction({
    action: 'scroll',
    scroll_direction: 'right',
    scroll_amount: 1,
  });
  assert.deepEqual(right, {
    ok: true,
    action: { kind: 'scroll', dx: SCROLL_PX_PER_UNIT, dy: 0 },
  });
});

test('translate: hold_key -> best-effort key press', () => {
  const r = translateComputerAction({ action: 'hold_key', text: 'shift', duration: 1 });
  assert.deepEqual(r, { ok: true, action: { kind: 'key', combo: 'shift' }, bestEffort: true });
});

// --------------------------------------------------------------------------
// D4 translation — unmapped actions reported as unsupported (continue)
// --------------------------------------------------------------------------

test('translate: unmapped actions are unsupported, not thrown', () => {
  const unmapped = [
    'right_click',
    'middle_click',
    'triple_click',
    'mouse_move',
    'left_click_drag',
    'left_mouse_down',
    'left_mouse_up',
    'cursor_position',
    'zoom',
  ];
  for (const action of unmapped) {
    const r = translateComputerAction({ action, coordinate: [1, 2] });
    assert.equal(r.ok, false, `${action} should not map`);
    if (!r.ok) assert.equal(r.reason, 'unsupported', `${action} reason`);
  }
});

test('translate: unknown action name is unsupported', () => {
  const r = translateComputerAction({ action: 'teleport' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'unsupported');
});

// --------------------------------------------------------------------------
// D4 translation — invalid inputs
// --------------------------------------------------------------------------

test('translate: non-object input is invalid', () => {
  for (const bad of [null, 42, 'x', undefined]) {
    const r = translateComputerAction(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid');
  }
});

test('translate: missing action name is invalid', () => {
  const r = translateComputerAction({ coordinate: [1, 2] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'invalid');
});

test('translate: click without valid coordinate is invalid', () => {
  for (const coord of [undefined, [1], ['a', 'b'], [Number.NaN, 2], 'x']) {
    const r = translateComputerAction({ action: 'left_click', coordinate: coord });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid');
  }
});

test('translate: type without string text is invalid', () => {
  const r = translateComputerAction({ action: 'type', text: 123 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'invalid');
});

test('translate: scroll with bad direction or amount is invalid', () => {
  const badDir = translateComputerAction({
    action: 'scroll',
    scroll_direction: 'diagonal',
    scroll_amount: 1,
  });
  assert.equal(badDir.ok, false);

  const badAmt = translateComputerAction({ action: 'scroll', scroll_direction: 'down' });
  assert.equal(badAmt.ok, false);
});

test('translate: wait without numeric duration is invalid', () => {
  const r = translateComputerAction({ action: 'wait', duration: 'soon' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'invalid');
});

// --------------------------------------------------------------------------
// translateToolCall dispatch (computer / escalate / done / unknown)
// --------------------------------------------------------------------------

test('translateToolCall: computer routes through action mapping', () => {
  const r = translateToolCall('computer', { action: 'left_click', coordinate: [5, 6] });
  assert.deepEqual(r, { ok: true, action: { kind: 'click', x: 5, y: 6 } });
});

test('translateToolCall: escalate becomes escalate action', () => {
  const r = translateToolCall('escalate', { reason: 'ambiguous date' });
  assert.deepEqual(r, { ok: true, action: { kind: 'escalate', reason: 'ambiguous date' } });
});

test('translateToolCall: done becomes done action', () => {
  const r = translateToolCall('done', { summary: 'created booking' });
  assert.deepEqual(r, { ok: true, action: { kind: 'done', summary: 'created booking' } });
});

test('translateToolCall: escalate/done tolerate missing fields (empty string)', () => {
  assert.deepEqual(translateToolCall('escalate', {}), {
    ok: true,
    action: { kind: 'escalate', reason: '' },
  });
  assert.deepEqual(translateToolCall('done', null), {
    ok: true,
    action: { kind: 'done', summary: '' },
  });
});

test('translateToolCall: unknown tool name is unsupported', () => {
  const r = translateToolCall('delete_everything', {});
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'unsupported');
});

// --------------------------------------------------------------------------
// stub-policy replay
// --------------------------------------------------------------------------

test('replay: executes the golden action sequence in order and ends done', async () => {
  const steps: ReplayStep[] = [
    { action: { kind: 'click', x: 10, y: 20 }, beforeSha256: 'H0' },
    { action: { kind: 'type', text: 'hi' }, beforeSha256: 'H1' },
    { action: { kind: 'done', summary: 'ok' } },
  ];
  const exec = new FakeExecutor(['H1', 'H2']);
  const out = await replayTrajectory({ executor: exec, steps });

  assert.equal(out.endReason, 'done');
  assert.equal(out.summary, 'ok');
  assert.deepEqual(
    out.actions.map((a) => a.kind),
    ['click', 'type', 'done'],
  );
  assert.deepEqual(
    exec.calls.map((a) => a.kind),
    ['click', 'type'],
  );
  assert.equal(out.steps, 2);
  assert.equal(out.drift.length, 0);
});

test('replay: hash drift is recorded, not fatal', async () => {
  const steps: ReplayStep[] = [
    { action: { kind: 'click', x: 1, y: 1 } },
    { action: { kind: 'type', text: 'x' }, beforeSha256: 'EXPECTED' },
    { action: { kind: 'done', summary: 'done' } },
  ];
  // first click yields 'ACTUAL'; step 2 expects 'EXPECTED' before it -> drift.
  const exec = new FakeExecutor(['ACTUAL', 'H2']);
  const out = await replayTrajectory({ executor: exec, steps });

  assert.equal(out.endReason, 'done', 'drift does not fail the replay');
  assert.equal(out.drift.length, 1);
  assert.deepEqual(out.drift[0], { stepIndex: 1, expected: 'EXPECTED', actual: 'ACTUAL' });
});

test('replay: captureInitial seeds a baseline observation for drift', async () => {
  const steps: ReplayStep[] = [{ action: { kind: 'click', x: 2, y: 2 }, beforeSha256: 'INIT' }];
  const exec = new FakeExecutor(['INIT', 'AFTER']);
  const out = await replayTrajectory({ executor: exec, steps, captureInitial: true });

  assert.deepEqual(
    out.actions.map((a) => a.kind),
    ['screenshot', 'click'],
  );
  assert.equal(out.drift.length, 0, 'baseline matches -> no drift');
  assert.equal(out.endReason, 'done');
});

test('replay: escalate action ends with escalate', async () => {
  const steps: ReplayStep[] = [
    { action: { kind: 'click', x: 1, y: 1 } },
    { action: { kind: 'escalate', reason: 'cannot fulfill' } },
  ];
  const out = await replayTrajectory({ executor: new FakeExecutor(), steps });
  assert.equal(out.endReason, 'escalate');
  assert.equal(out.reason, 'cannot fulfill');
});

test('replay: budget exhaustion ends the replay', async () => {
  const steps: ReplayStep[] = [
    { action: { kind: 'click', x: 1, y: 1 } },
    { action: { kind: 'click', x: 2, y: 2 } },
  ];
  const out = await replayTrajectory({ executor: new FakeExecutor([], 1), steps });
  assert.equal(out.endReason, 'budget_exhausted');
  // first click succeeds; the second is attempted and trips the budget block.
  assert.equal(out.steps, 2);
});

test('replay: fallbackEndReason used when no in-band terminal', async () => {
  const steps: ReplayStep[] = [{ action: { kind: 'click', x: 1, y: 1 } }];
  const out = await replayTrajectory({
    executor: new FakeExecutor(),
    steps,
    fallbackEndReason: 'budget_exhausted',
  });
  assert.equal(out.endReason, 'budget_exhausted');
});

// --------------------------------------------------------------------------
// approval policies
// --------------------------------------------------------------------------

function makeReq(id = 'req-1'): ApprovalRequest {
  return {
    id,
    actionSummary: 'click Confirm booking',
    requestedAt: new Date().toISOString(),
    taskId: 'book-simple-001',
  };
}

test('approval auto-log: approves and records the decision', async () => {
  const handler = createApprovalHandler({ mode: 'auto-log' });
  const req = makeReq();
  const decision = await handler.decide(req);

  assert.equal(decision.decision, 'approve');
  assert.equal(decision.id, req.id);
  assert.equal(decision.decidedBy, 'auto-log');
  assert.equal(handler.log.length, 1);
  assert.equal(handler.log[0]?.request, req);
  assert.equal(handler.log[0]?.decision, decision);
});

test('approval auto-log: callback() drives the sandbox and keeps logging', async () => {
  const handler = createApprovalHandler({ mode: 'auto-log' });
  const cb = handler.callback();
  const d1 = await cb(makeReq('a'));
  const d2 = await cb(makeReq('b'));
  assert.equal(d1.decision, 'approve');
  assert.equal(d2.decision, 'approve');
  assert.equal(handler.log.length, 2);
});

test('approval cli: affirmative answers approve, others deny', async () => {
  for (const yes of ['y', 'Y', 'yes', ' Yes ']) {
    const handler = createApprovalHandler({ mode: 'cli' }, { prompt: async () => yes });
    const d = await handler.decide(makeReq());
    assert.equal(d.decision, 'approve', `"${yes}" should approve`);
    assert.equal(d.decidedBy, 'cli-operator');
  }
  for (const no of ['n', 'no', '', 'nope']) {
    const handler = createApprovalHandler({ mode: 'cli' }, { prompt: async () => no });
    const d = await handler.decide(makeReq());
    assert.equal(d.decision, 'deny', `"${no}" should deny`);
    if (d.decision === 'deny') assert.match(d.reason, /declined/);
  }
});

test('approval mcp: delegates the decision and logs it', async () => {
  const delegate = async (req: ApprovalRequest): Promise<ApprovalDecision> => ({
    id: req.id,
    decision: 'deny',
    reason: 'blocked by remote policy',
    decidedBy: 'mcp:reviewer',
    decidedAt: new Date().toISOString(),
  });
  const handler = createApprovalHandler({ mode: 'mcp' }, { delegate });
  const d = await handler.decide(makeReq());
  assert.equal(d.decision, 'deny');
  assert.equal(d.decidedBy, 'mcp:reviewer');
  assert.equal(handler.log.length, 1);
});

test('approval mcp: throws when no delegate is provided', () => {
  assert.throws(() => createApprovalHandler({ mode: 'mcp' }), /delegate/);
});

test('approval: actor override is honored', async () => {
  const handler = createApprovalHandler({ mode: 'auto-log' }, { actor: 'ci-bot' });
  const d = await handler.decide(makeReq());
  assert.equal(d.decidedBy, 'ci-bot');
});

// --------------------------------------------------------------------------
// request-body construction + response parsing (pure, no network)
// --------------------------------------------------------------------------

test('mapEffort: every tier passes through unchanged (xhigh IS an API tier)', () => {
  assert.equal(mapEffort('low'), 'low');
  assert.equal(mapEffort('medium'), 'medium');
  assert.equal(mapEffort('high'), 'high');
  // xhigh is a real output_config.effort value on the CUA models (and the
  // recommended tier for agentic work) — mapping it to "max" silently bought
  // a more expensive, overthinking-prone tier than the caller asked for.
  assert.equal(mapEffort('xhigh'), 'xhigh');
});

test('buildRequestBody: opus-4-8 default surface', () => {
  const body = buildRequestBody(cfg('claude-opus-4-8', 'high'), 'SYS', []);
  assert.equal(body.model, 'claude-opus-4-8');
  assert.deepEqual(body.betas, [COMPUTER_USE_BETA]);
  assert.equal(body.fallbacks, undefined);
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.system, 'SYS');

  // computer tool exact surface, plus the two custom tools.
  assert.equal(body.tools.length, 3);
  assert.deepEqual(body.tools[0], COMPUTER_TOOL);
  assert.equal(COMPUTER_TOOL.type, 'computer_20251124');
  assert.equal(COMPUTER_TOOL.display_width_px, 1280);
  assert.equal(COMPUTER_TOOL.display_height_px, 800);
  assert.equal(body.tools[1], ESCALATE_TOOL);
  assert.equal(body.tools[2], DONE_TOOL);

  // no sampling knobs anywhere.
  assert.ok(!('temperature' in body));
  assert.ok(!('top_p' in body));
  assert.ok(!('top_k' in body));
  assert.ok(!('thinking' in body));
});

test('buildRequestBody: fable-5 with fallback adds the server-side fallback', () => {
  const body = buildRequestBody(cfg('claude-fable-5', 'xhigh', true), 'SYS', []);
  assert.deepEqual(body.betas, [COMPUTER_USE_BETA, SERVER_SIDE_FALLBACK_BETA]);
  assert.deepEqual(body.fallbacks, [{ model: 'claude-opus-4-8' }]);
  assert.deepEqual(body.output_config, { effort: 'xhigh' });
});

test('buildRequestBody: fable-5 without fallback omits fallback surface', () => {
  const body = buildRequestBody(cfg('claude-fable-5', 'medium', false), 'SYS', []);
  assert.deepEqual(body.betas, [COMPUTER_USE_BETA]);
  assert.equal(body.fallbacks, undefined);
});

test('buildRequestBody: sonnet is a plain computer-use request', () => {
  const body = buildRequestBody(cfg('claude-sonnet-4-6', 'low'), 'SYS', []);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.deepEqual(body.betas, [COMPUTER_USE_BETA]);
  assert.equal(body.fallbacks, undefined);
});

test('buildRequestBody: rejects non-API model ids', () => {
  assert.throws(() => buildRequestBody(cfg('stub', 'low'), 'SYS', []), /not an API model/);
  assert.throws(() => buildRequestBody(cfg('oracle', 'low'), 'SYS', []), /not an API model/);
});

test('parseResponse: extracts tool calls and text; not refused', () => {
  const raw: RawModelResponse = {
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'I will click Confirm.' },
      { type: 'tool_use', id: 'tu_1', name: 'computer', input: { action: 'left_click', coordinate: [1, 2] } },
    ],
  };
  const t = parseResponse(raw);
  assert.equal(t.refused, false);
  assert.equal(t.text, 'I will click Confirm.');
  assert.equal(t.toolCalls.length, 1);
  assert.equal(t.toolCalls[0]?.name, 'computer');
  // assistant content echoes both blocks for the next turn.
  assert.equal(t.assistantContent.length, 2);
  assert.equal(t.assistantContent[0]?.type, 'text');
  assert.equal(t.assistantContent[1]?.type, 'tool_use');
});

test('parseResponse: refusal is surfaced with detail', () => {
  const raw: RawModelResponse = {
    stop_reason: 'refusal',
    content: [],
    stop_details: { category: 'reasoning_extraction', explanation: 'declined' },
  };
  const t = parseResponse(raw);
  assert.equal(t.refused, true);
  assert.equal(t.refusalDetail, 'declined');
  assert.equal(t.toolCalls.length, 0);
});

// --------------------------------------------------------------------------
// observe -> act loop
// --------------------------------------------------------------------------

test('loop: click then done', async () => {
  const model = new ScriptedModel([
    turn([computerCall('c1', { action: 'left_click', coordinate: [10, 20] })]),
    turn([{ id: 'd1', name: 'done', input: { summary: 'booked' } }]),
  ]);
  const exec = new FakeExecutor();
  const out = await runLoop({ model, executor: exec, instruction: 'Book it' });

  assert.equal(out.endReason, 'done');
  assert.equal(out.summary, 'booked');
  assert.deepEqual(
    out.actions.map((a) => a.kind),
    ['screenshot', 'click'],
  );
  assert.equal(out.turns, 2);
  assert.equal(model.beginCalls, 1);
  assert.equal(model.nextCalls, 1);
  assert.equal(model.lastInstruction, 'Book it');
  // the tool result fed back was the post-click screenshot image.
  assert.ok(model.lastResults?.[0]?.image);
});

test('loop: escalate ends immediately without acting', async () => {
  const model = new ScriptedModel([
    turn([{ id: 'e1', name: 'escalate', input: { reason: 'two customers share a name' } }]),
  ]);
  const exec = new FakeExecutor();
  const out = await runLoop({ model, executor: exec, instruction: 'Book it' });

  assert.equal(out.endReason, 'escalate');
  assert.equal(out.reason, 'two customers share a name');
  // only the seed screenshot ran.
  assert.deepEqual(
    out.actions.map((a) => a.kind),
    ['screenshot'],
  );
});

test('loop: unsupported action is noted (not executed) and the model adapts', async () => {
  const model = new ScriptedModel([
    turn([computerCall('c1', { action: 'right_click', coordinate: [1, 1] })]),
    turn([{ id: 'd1', name: 'done', input: { summary: 'ok' } }]),
  ]);
  const exec = new FakeExecutor();
  const out = await runLoop({ model, executor: exec, instruction: 'x' });

  assert.equal(out.endReason, 'done');
  // right_click never reached the executor.
  assert.deepEqual(exec.calls.map((a) => a.kind), ['screenshot']);
  assert.equal(model.lastResults?.[0]?.isError, true);
  assert.match(model.lastResults?.[0]?.text ?? '', /not performed/);
});

test('loop: recoverable sandbox block becomes a note, run continues', async () => {
  const model = new ScriptedModel([
    turn([computerCall('c1', { action: 'left_click', coordinate: [9999, 9999] })]),
    turn([{ id: 'd1', name: 'done', input: { summary: 'done' } }]),
  ]);
  const exec = new BoundsBlockingExecutor();
  const out = await runLoop({ model, executor: exec, instruction: 'x' });

  assert.equal(out.endReason, 'done');
  // the block was reported back to the model as a (non-error) note.
  assert.equal(model.lastResults?.[0]?.image, undefined);
  assert.match(model.lastResults?.[0]?.text ?? '', /viewport_bounds/);
});

test('loop: budget exhaustion ends as budget_exhausted', async () => {
  const model = new ScriptedModel([
    turn([computerCall('c1', { action: 'left_click', coordinate: [5, 5] })]),
  ]);
  // budget 1 -> seed screenshot ok, the click trips the budget.
  const exec = new FakeExecutor([], 1);
  const out = await runLoop({ model, executor: exec, instruction: 'x' });
  assert.equal(out.endReason, 'budget_exhausted');
});

test('loop: refusal turn ends as error', async () => {
  const model = new ScriptedModel([turn([], { refused: true })]);
  const out = await runLoop({ model, executor: new FakeExecutor(), instruction: 'x' });
  assert.equal(out.endReason, 'error');
  assert.match(out.error ?? '', /refused/);
});

test('loop: a turn with no tool call ends as error', async () => {
  const model = new ScriptedModel([turn([])]);
  const out = await runLoop({ model, executor: new FakeExecutor(), instruction: 'x' });
  assert.equal(out.endReason, 'error');
  assert.match(out.error ?? '', /no tool call/);
});

test('loop: a thrown model error is caught and reported', async () => {
  const out = await runLoop({
    model: new ThrowingModel(),
    executor: new FakeExecutor(),
    instruction: 'x',
  });
  assert.equal(out.endReason, 'error');
  assert.match(out.error ?? '', /api down/);
});

test('loop: maxTurns caps a model that never terminates', async () => {
  const out = await runLoop({
    model: new AlwaysUnsupportedModel(),
    executor: new FakeExecutor(),
    instruction: 'x',
    maxTurns: 3,
  });
  assert.equal(out.endReason, 'budget_exhausted');
  assert.equal(out.turns, 3);
});
