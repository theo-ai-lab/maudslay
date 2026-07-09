/**
 * Seeded structured-garbage battery for the fail-closed parsers. Zero-dep and
 * deterministic (fixed seed, hand-rolled PRNG) so a failure is reproducible by
 * seed. The property under test is the fail-closed contract itself:
 *
 *   parseRatchet: never throws, and a silent accept (zero problems) implies
 *   every parsed floor is well-formed — garbage may be rejected loudly or
 *   normalized to documented defaults, but it must never pass as a floor that
 *   violates the documented ranges.
 *
 *   adapt(): every input either throws ImportValidationError or yields a report
 *   whose numbers are internally consistent — never a silent partial.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadRatchetAudit } from "../harness/gate.ts";
import { adapt, ImportValidationError } from "../examples/import/adapt.ts";

// mulberry32 — tiny deterministic PRNG; good enough for structured fuzz.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCALAR_POOL: unknown[] = [
  undefined, null, NaN, Infinity, -Infinity, -1, -0.5, 0, 0.5, 0.9, 1, 1.5, 2, 60, 1e9,
  "", "0.9", "x", "NaN", true, false, [], {},
];
const KEY_POOL = [
  "minPassK", "k", "minTasks", "maxSilentCorruptions", "pinnedArtifact",
  "generatedAt", "sha256", "models", "schema", "model", "trials",
  "taskId", "trialIndex", "outcome", "extra",
];

function randomValue(rnd: () => number, depth: number): unknown {
  if (depth <= 0 || rnd() < 0.6) return SCALAR_POOL[Math.floor(rnd() * SCALAR_POOL.length)];
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    obj[KEY_POOL[Math.floor(rnd() * KEY_POOL.length)] as string] = randomValue(rnd, depth - 1);
  }
  return obj;
}

test("fuzz: loadRatchetAudit is total and silent-accept implies well-formed floors", () => {
  const rnd = mulberry32(42);
  const dir = mkdtempSync(join(tmpdir(), "maudslay-fuzz-"));
  try {
    const path = join(dir, "ratchet.json");
    for (let i = 0; i < 400; i++) {
      // Random config: sometimes valid-ish shell, sometimes pure garbage.
      const cfg = rnd() < 0.5
        ? { models: { m: randomValue(rnd, 2) } }
        : randomValue(rnd, 3);
      let text: string;
      try {
        text = JSON.stringify(cfg) ?? "null";
      } catch {
        continue; // unencodable (cycles impossible here, but stay total)
      }
      writeFileSync(path, text);
      const { config, problems } = loadRatchetAudit(path); // must not throw
      if (problems.length === 0) {
        for (const [id, floor] of Object.entries(config.models)) {
          assert.ok(
            floor.minPassK >= 0 && floor.minPassK <= 1 && Number.isFinite(floor.minPassK),
            `iter ${i}: silent accept with out-of-range minPassK for ${id}: ${floor.minPassK}`,
          );
          assert.ok(floor.k >= 1, `iter ${i}: silent accept with k<1 for ${id}`);
          assert.ok(floor.minTasks >= 0, `iter ${i}: silent accept with negative minTasks for ${id}`);
          assert.equal(floor.maxSilentCorruptions, 0, `iter ${i}: nonzero tolerance accepted for ${id}`);
          if (floor.pinnedArtifact) {
            assert.equal(typeof floor.pinnedArtifact.generatedAt, "string");
            assert.ok(floor.minPassK > 0, `iter ${i}: pin accepted on a dormant floor for ${id}`);
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fuzz: adapt() throws the named error or returns a consistent report — never a partial", () => {
  const rnd = mulberry32(1337);
  const valid = () => ({
    schema: "maudslay.external-results/1",
    model: "m",
    k: 2,
    trials: [
      { taskId: "a", trialIndex: 0, outcome: "success" },
      { taskId: "a", trialIndex: 1, outcome: "failure" },
      { taskId: "b", trialIndex: 0, outcome: "success" },
      { taskId: "b", trialIndex: 1, outcome: "success" },
    ],
  });
  for (let i = 0; i < 400; i++) {
    // Mutate a valid document 1-3 times at random paths.
    const doc = JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;
    const mutations = 1 + Math.floor(rnd() * 3);
    for (let m = 0; m < mutations; m++) {
      const roll = rnd();
      if (roll < 0.3) {
        doc[KEY_POOL[Math.floor(rnd() * KEY_POOL.length)] as string] = randomValue(rnd, 1);
      } else if (roll < 0.6 && Array.isArray(doc.trials) && doc.trials.length > 0) {
        const t = doc.trials[Math.floor(rnd() * doc.trials.length)];
        if (t && typeof t === "object" && !Array.isArray(t)) {
          (t as Record<string, unknown>)[KEY_POOL[Math.floor(rnd() * KEY_POOL.length)] as string] =
            randomValue(rnd, 1);
        }
      } else if (Array.isArray(doc.trials)) {
        doc.trials.push(randomValue(rnd, 1));
      }
    }
    try {
      const { report, flat } = adapt(doc, "2026-07-09T00:00:00.000Z");
      // Accepted → the numbers must be internally consistent.
      assert.ok(report.passK >= 0 && report.passK <= 1, `iter ${i}: passK out of range`);
      assert.equal(report.trialsTotal, flat.length, `iter ${i}: trialsTotal disagrees with trials`);
      assert.equal(report.silentCorruptions, 0, `iter ${i}: imported data invented a corruption`);
      for (const t of flat) {
        assert.ok(t.verdict === "OK" || t.verdict === "MISSING", `iter ${i}: verdict ${t.verdict} out of the honest set`);
      }
      for (const pt of report.perTask) {
        assert.equal(pt.trials.length, 2, `iter ${i}: exactly-k violated on accept (${pt.taskId})`);
      }
    } catch (e) {
      assert.ok(e instanceof ImportValidationError, `iter ${i}: threw ${String(e)} — not the named error`);
    }
  }
});
