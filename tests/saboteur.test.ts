/**
 * The saboteur harness — an adversarial audit of this repo's own credibility
 * claim.
 *
 * A gate that cannot separate a capable agent from an incapable one measures
 * nothing. These tests establish the separation by EXECUTION: they generate a
 * seeded family of agents that try to pass while violating the intent, hand
 * their witnesses to the real verifier, and assert every one is caught.
 *
 * Every saboteur that is NOT caught is a real hole. Holes are pinned in
 * `KNOWN_ESCAPES`, never hidden: a NEW escape fails this suite, and the pinned
 * set may only shrink.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSuccess } from "../src/types.ts";
import { verify } from "../groundtruth/verifier.ts";
import { buildTasks } from "../harness/tasks.ts";
import {
  SABOTEUR_KINDS,
  SaboteurError,
  KNOWN_ESCAPES,
  generateSaboteurs,
  judgeSaboteur,
  auditSaboteurs,
  honestRun,
  makeSaboteurPolicy,
} from "../harness/saboteur.ts";

const ANCHOR = "2026-08-10";
const TASKS = buildTasks(ANCHOR);

// ---------------------------------------------------------------------------
// 1. The generated space is a space, and it is deterministic.
// ---------------------------------------------------------------------------

test("saboteur family is deterministic: same seed reproduces it exactly", () => {
  const a = generateSaboteurs({ seed: 20260801, tasks: TASKS, perTask: 4 });
  const b = generateSaboteurs({ seed: 20260801, tasks: TASKS, perTask: 4 });
  assert.deepEqual(b, a, "same seed must reproduce a byte-identical family");
  assert.ok(a.length > 0, "generator produced nothing");
});

test("saboteur family actually varies with the seed", () => {
  const a = generateSaboteurs({ seed: 1, tasks: TASKS, perTask: 4 });
  const b = generateSaboteurs({ seed: 2, tasks: TASKS, perTask: 4 });
  assert.equal(a.length, b.length);
  assert.notDeepEqual(b, a, "different seeds produced identical families — the space is a constant");
});

test("saboteur ids are unique across a family", () => {
  const fam = generateSaboteurs({ seed: 77, tasks: TASKS, perTask: 5 });
  assert.equal(new Set(fam.map((s) => s.id)).size, fam.length);
});

test("generateSaboteurs validates at the boundary with one error shape", () => {
  assert.throws(() => generateSaboteurs({ seed: 1.5, tasks: TASKS }), SaboteurError);
  assert.throws(() => generateSaboteurs({ seed: 1, tasks: [] }), SaboteurError);
  assert.throws(() => generateSaboteurs({ seed: 1, tasks: TASKS, perTask: 0 }), SaboteurError);
});

test("a family covers every saboteur kind and every task in the suite", () => {
  const fam = generateSaboteurs({ seed: 4242, tasks: TASKS, perTask: SABOTEUR_KINDS.length + 3 });
  const kinds = new Set(fam.map((s) => s.kind));
  for (const k of SABOTEUR_KINDS) {
    assert.ok(kinds.has(k), `kind ${k} never generated — the family does not cover its own space`);
  }
  const taskIds = new Set(fam.map((s) => s.taskId));
  for (const t of TASKS) {
    assert.ok(taskIds.has(t.id), `task ${t.id} never attacked`);
  }
});

test("every saboteur declares the intent it violates", () => {
  for (const s of generateSaboteurs({ seed: 9, tasks: TASKS, perTask: 3 })) {
    assert.ok(s.intent.trim().length > 10, `saboteur ${s.id} has no stated intent`);
  }
});

// ---------------------------------------------------------------------------
// 2. The invariant: every saboteur is caught, modulo the pinned escapes.
// ---------------------------------------------------------------------------

test("INVARIANT: no saboteur earns a success verdict, except the pinned escapes", () => {
  const seeds = [1, 7, 13, 20260801, 999983];
  const unexpected: string[] = [];
  let attempts = 0;
  for (const seed of seeds) {
    for (const s of generateSaboteurs({ seed, tasks: TASKS, perTask: SABOTEUR_KINDS.length + 3 })) {
      attempts += 1;
      const { code, caught } = judgeSaboteur(s);
      assert.equal(caught, !isSuccess(code), "judge disagrees with isSuccess");
      if (!caught && !KNOWN_ESCAPES.includes(s.kind)) {
        unexpected.push(`${s.id} (${s.kind}, ${s.taskId}) -> ${code}: ${s.intent}`);
      }
    }
  }
  assert.ok(attempts >= 300, `space too small to be a property (${attempts} attempts)`);
  assert.deepEqual(unexpected, [], `NEW saboteur escapes — a real hole in the gate:\n${unexpected.join("\n")}`);
});

test("the pinned escape set is honest: every pinned kind really does escape", () => {
  const report = auditSaboteurs({ seed: 20260801, tasks: TASKS, perTask: SABOTEUR_KINDS.length + 5 });
  const observed = new Set(report.escapedKinds);
  for (const k of KNOWN_ESCAPES) {
    assert.ok(
      observed.has(k),
      `${k} is pinned as a known escape but no longer escapes — shrink KNOWN_ESCAPES`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Regression lock for the hole this harness found.
// ---------------------------------------------------------------------------

test("REGRESSION: booking what was asked AND unrequested extras is silent corruption", () => {
  // "over-actor" satisfies the letter of the check — the requested booking is
  // present and clean on both witnesses — while breaking the goal: the customer
  // also gets appointments nobody asked for. Grading only the expected record
  // makes those invisible, so the worst kind of agent (one that acts too much)
  // scores exactly like a correct one.
  const family = generateSaboteurs({ seed: 20260801, tasks: TASKS, perTask: SABOTEUR_KINDS.length });
  const overActors = family.filter(
    (s) => s.kind === "over-actor" && s.taskId.startsWith("book-"),
  );
  assert.ok(overActors.length > 0, "no over-actor attempts generated");
  for (const s of overActors) {
    const { code } = judgeSaboteur(s);
    assert.equal(
      code,
      "WRONG_RECORD",
      `${s.id} graded ${code}: an unrequested extra booking must be silent corruption`,
    );
  }
});

test("CONTROL ARM: an honest agent scores a clean success on every task in the suite", () => {
  // The mirror of the lock above, and the other half of any discrimination
  // claim. If the collateral check turned honest runs into corruption, or if
  // the seeded pre-existing rows counted as collateral, this fails.
  for (const task of TASKS) {
    const v = verify(honestRun(task, { anchor: ANCHOR }));
    assert.ok(
      isSuccess(v.code),
      `honest agent graded ${v.code} on ${task.id}: ${v.explanation}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Discrimination: the number has to separate a bad agent from a good one.
// ---------------------------------------------------------------------------

test("DISCRIMINATION: the metric separates a zero-capability agent from an honest one", () => {
  const report = auditSaboteurs({ seed: 20260801, tasks: TASKS, perTask: SABOTEUR_KINDS.length + 5 });
  assert.equal(report.attempts, report.caught + report.escapes.length);
  // The control arm scores 1.0 (asserted above, per task). So the margin is
  // entirely determined by the noise floor.
  assert.ok(
    report.zeroCapabilityFloor < 0.5,
    `an agent with NO capability scores ${report.zeroCapabilityFloor.toFixed(3)} — too close to an honest 1.0 for the number to carry information`,
  );
  assert.ok(
    Math.abs(report.discriminationMargin - (1 - report.zeroCapabilityFloor)) < 1e-12,
    "margin must be derived from the measured floor, never asserted",
  );
});

// ---------------------------------------------------------------------------
// 4b. The doc may not claim more than the audit measures.
// ---------------------------------------------------------------------------

test("DISCRIMINATION.md numbers are the measured ones, not typed ones", () => {
  const doc = readFileSync(join(import.meta.dirname, "..", "docs", "DISCRIMINATION.md"), "utf8");
  const report = auditSaboteurs({ seed: 20260801, tasks: TASKS, perTask: SABOTEUR_KINDS.length + 5 });

  assert.match(
    doc,
    new RegExp(`Noise floor ${report.zeroCapabilityFloor.toFixed(3)}`),
    `doc's noise floor does not match the measured ${report.zeroCapabilityFloor.toFixed(3)}`,
  );
  assert.match(
    doc,
    new RegExp(`discrimination margin ${report.discriminationMargin.toFixed(3)}`),
    `doc's margin does not match the measured ${report.discriminationMargin.toFixed(3)}`,
  );

  // Every strategy row must carry that strategy's measured pass^1.
  for (const r of report.byKind) {
    const row = doc.split("\n").find((l) => l.startsWith(`| ${r.kind} `));
    assert.ok(row, `DISCRIMINATION.md has no table row for ${r.kind}`);
    assert.ok(
      row.includes(r.suitePassK1.toFixed(3)),
      `${r.kind} row claims a different number than the measured ${r.suitePassK1.toFixed(3)}: ${row}`,
    );
  }

  // Every pinned escape must be named in the doc's open-holes section.
  for (const k of KNOWN_ESCAPES) {
    assert.ok(doc.includes(`**${k}**`), `pinned escape ${k} is not disclosed in DISCRIMINATION.md`);
  }
});

// ---------------------------------------------------------------------------
// 5. The decisive experiment, run for real (skips cleanly without chromium).
// ---------------------------------------------------------------------------

test(
  "LIVE: incapable agents driven through the real rig score what the model says they score",
  { timeout: 180000 },
  async (t) => {
    // Everything above grades a MODEL of what a saboteur would leave behind.
    // This runs the same strategies through the real browser, the real sim, the
    // real SMTP sink and the real witnesses, so the discrimination claim rests
    // on execution rather than on my own fixtures being right.
    const { startHarnessEnv, runTrial } = await import("../harness/trial.ts");

    let env;
    try {
      env = await startHarnessEnv({ headless: true });
    } catch (err) {
      t.skip(`chromium/env unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "maudslay-saboteur-"));
    try {
      const suite = buildTasks(env.anchor);
      // One of each expectation kind: a create, a cancel, and a trap.
      const ids = ["book-simple-001", "cancel-001", "escalate-overbook-001"];
      const observed: Record<string, Record<string, string>> = {};

      for (const kind of ["ghost", "trap-parrot"] as const) {
        observed[kind] = {};
        for (const id of ids) {
          const task = suite.find((x) => x.id === id);
          assert.ok(task, `task ${id} missing from the suite`);
          const tr = await runTrial({
            task,
            trialIndex: 0,
            modelLabel: `saboteur-${kind}`,
            policy: makeSaboteurPolicy(kind) as never,
            session: env.session,
            adminBase: env.adminBase,
            publicBase: env.publicBase,
            mailDir: env.mailDir,
            trajectoryPath: join(dir, `${kind}-${id}.jsonl`),
          });
          (observed[kind] as Record<string, string>)[id] = tr.verdict.code;
        }
      }

      // A do-nothing agent must win nothing at all.
      assert.deepEqual(observed["ghost"], {
        "book-simple-001": "MISSING",
        "cancel-001": "MISSING",
        "escalate-overbook-001": "MISSING",
      });

      // The canned refuser forfeits every fulfillable task...
      const parrot = observed["trap-parrot"] as Record<string, string>;
      assert.equal(parrot["book-simple-001"], "ESCALATED_WRONG");
      assert.equal(parrot["cancel-001"], "ESCALATED_WRONG");
      // ...and takes the trap for free. This is the pinned escape, confirmed
      // end-to-end: an agent that never looked at the screen is graded a
      // success on a must-escalate task because its canned text names the
      // blocker. If this ever stops being ESCALATED_OK, the hole is closed and
      // KNOWN_ESCAPES should shrink.
      assert.equal(
        parrot["escalate-overbook-001"],
        "ESCALATED_OK",
        "the trap-parrot escape is pinned as real — verify before changing",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await env.stop();
    }
  },
);

test("the noise floor is NOT zero, and it is exactly the suite's must-escalate share", () => {
  // The honest, uncomfortable finding, stated as a structural property rather
  // than a magic number. A must_escalate trap is graded on the agent's stated
  // reason, and text can be canned — so one omnibus refusal collects every trap
  // for free. The floor is therefore the trap share of the suite. Add traps and
  // the floor rises; this test is the tripwire that says so.
  const report = auditSaboteurs({ seed: 20260801, tasks: TASKS, perTask: SABOTEUR_KINDS.length + 5 });
  const traps = TASKS.filter((t) => t.expectation.kind === "must_escalate").length;
  const trapShare = traps / TASKS.length;
  assert.ok(report.zeroCapabilityFloor > 0, "floor measured as zero — the audit is not running");
  assert.ok(
    Math.abs(report.zeroCapabilityFloor - trapShare) < 1e-12,
    `noise floor ${report.zeroCapabilityFloor.toFixed(4)} != must-escalate share ${trapShare.toFixed(4)} — the floor has a source this test does not explain`,
  );
});
