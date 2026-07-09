/**
 * T8 docs acceptance tests.
 *
 * The docs are a deliverable with a contract (docs/decisions/D3-readme-shape.md
 * and CONTRACTS.md), so they get tested like code. These assertions encode that
 * contract: the honesty guardrails (no fabricated pass^k; "pending live run"
 * where live data is required), the required motivating citations with real
 * links, the precise five-column comparison table where Maudslay is the only
 * all-five row, the status matrix, the model-configurable table structure, the
 * quickstart, and the cross-links to the security / verification / discovery
 * docs. No browser, no network — pure file reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clopperPearsonLower } from "../harness/passk.ts";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// ---------------------------------------------------------------------------
// README — the hero, the literature, the wedge table, status, quickstart
// ---------------------------------------------------------------------------

test("README exists and leads with the outcome-verified gating thesis", () => {
  const md = read("README.md");
  assert.match(md, /outcome-verified/i, "thesis must name outcome-verification");
  assert.match(md, /pass\^k/, "thesis must reference pass^k");
  assert.match(
    md,
    /(confirmation email|independent ground truth)/i,
    "thesis must name the independent ground-truth channel",
  );
  assert.match(
    md,
    /never[\s\S]{0,40}(screen-scrape|screenshot)/i,
    "thesis must state verification is never a second screen-scrape",
  );
});

test("README banner shows an honest status word, never a fabricated pass^k", () => {
  const md = read("README.md");
  assert.match(
    md,
    /plumbing-green|awaiting live run|pending live run/i,
    "banner must carry an honest status word",
  );
});

test("README cites all three motivating sources with real links", () => {
  const md = read("README.md");
  // Anthropic eval guidance (Jan 2026).
  assert.match(
    md,
    /https:\/\/www\.anthropic\.com\/engineering\/demystifying-evals-for-ai-agents/,
    "must link Anthropic's Demystifying evals for AI agents",
  );
  // OSWorld 2.0 (Jun 2026) — the long-horizon reliability gap.
  assert.match(md, /osworld/i, "must name OSWorld 2.0");
  assert.match(
    md,
    /osworld-v2\.xlang\.ai|arxiv\.org\/abs\/2606\.29537/i,
    "must link an authoritative OSWorld 2.0 home",
  );
  assert.match(md, /20\.6%/, "must cite OSWorld 2.0's measured best-model number accurately");
  // AWS agent-desktops GA (Jun 2026) — residual-domain framing.
  assert.match(md, /workspaces/i, "must name the AWS Amazon WorkSpaces for AI agents GA");
  assert.match(
    md,
    /aws\.amazon\.com/,
    "must link the AWS announcement",
  );
  assert.match(
    md,
    /no\s+API\s+exists/i,
    "must quote the AWS 'visual interaction only where no API exists' framing",
  );
});

test("README comparison table names ASSERT and EvalView with their repos", () => {
  const md = read("README.md");
  assert.match(
    md,
    /https:\/\/github\.com\/responsibleai\/ASSERT/,
    "must link ASSERT's repo",
  );
  assert.match(
    md,
    /https:\/\/github\.com\/hidai25\/eval-view/,
    "must link EvalView's repo",
  );
});

/** Pull a markdown table row whose first cell contains `label`. */
function tableRow(md: string, label: string): string {
  const line = md
    .split("\n")
    .find((l) => l.trimStart().startsWith("|") && l.includes(label) && /\bYes\b|\bNo\b/.test(l));
  assert.ok(line, `no comparison-table row found for ${label}`);
  return line as string;
}

function countCell(row: string, word: "Yes" | "No"): number {
  const re = new RegExp(`\\b${word}\\b`, "g");
  return (row.match(re) ?? []).length;
}

test("comparison table: Maudslay is the ONLY all-five row", () => {
  const md = read("README.md");
  const maudslay = tableRow(md, "Maudslay");
  const assertRow = tableRow(md, "ASSERT");
  const evalview = tableRow(md, "EvalView");

  // Five capability columns; Maudslay satisfies all five.
  assert.equal(countCell(maudslay, "Yes"), 5, "Maudslay must be Yes on all five columns");
  assert.equal(countCell(maudslay, "No"), 0, "Maudslay must have no No cells");

  // The other tools each miss at least one column (the wedge is the conjunction).
  assert.ok(countCell(assertRow, "No") >= 1, "ASSERT must miss at least one column");
  assert.ok(countCell(evalview, "No") >= 1, "EvalView must miss at least one column");
  assert.ok(countCell(assertRow, "Yes") < 5, "ASSERT must not be all-five");
  assert.ok(countCell(evalview, "Yes") < 5, "EvalView must not be all-five");
});

test("README carries the five capability column names verbatim-enough", () => {
  const md = read("README.md").toLowerCase();
  assert.match(md, /outcome-graded/, "column: outcome-graded");
  assert.match(md, /ground[- ]truth/, "column: independent ground-truth channel");
  assert.match(md, /pass\^k/, "column: pass^k");
  assert.match(md, /merge-blocking/, "column: merge-blocking CI");
  assert.match(md, /computer-use/, "column: computer-use");
});

test("README has a status matrix separating measured from pending", () => {
  const md = read("README.md");
  assert.match(md, /\|\s*Component\s*\|\s*State\s*\|\s*Evidence\s*\|/i, "status matrix header");
  assert.match(md, /green \(tests\)/i, "measured components labelled green (tests)");
  assert.match(md, /pending live run/i, "model capability labelled pending live run");
});

// --- The honesty guard: README result numbers are pinned to the committed ---
// --- runs/ artifact, value-by-value — not merely to a file's existence.   ---

const KNOWN_MODELS = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"];

interface BackingReport {
  passK: number;
  perTrialPassRate: number;
  perTrialLowerBound95: number;
  trialsTotal: number;
  silentCorruptions: number;
  escalationRate: number;
  mode: string;
  generatedAt: string;
}

/**
 * The latest committed artifact that genuinely BACKS a claim for this model: it
 * must parse, carry per-trial verdicts, and hold finite report numbers. A
 * garbage file that merely bears the model's name legitimizes nothing.
 */
function latestArtifact(model: string): BackingReport | null {
  let names: string[];
  try {
    names = readdirSync(resolve(root, "runs"));
  } catch {
    return null;
  }
  let best: BackingReport | null = null;
  for (const f of names) {
    if (!f.startsWith(model) || !f.endsWith(".json")) continue;
    let parsed: {
      mode?: unknown;
      generatedAt?: unknown;
      trials?: unknown;
      report?: Record<string, number>;
    };
    try {
      parsed = JSON.parse(readFileSync(resolve(root, "runs", f), "utf8"));
    } catch {
      continue;
    }
    // The artifact's INNER model field must match — a renamed or copied file
    // whose contents describe a different model backs nothing.
    if (String((parsed as { model?: unknown }).model ?? "") !== model) continue;
    const r = parsed?.report;
    if (!Array.isArray(parsed?.trials) || parsed.trials.length === 0) continue;
    if (
      !r ||
      ![r.passK, r.perTrialPassRate, r.perTrialLowerBound95, r.escalationRate].every(
        Number.isFinite,
      ) ||
      !Number.isFinite(r.trialsTotal) ||
      !Number.isFinite(r.silentCorruptions)
    ) {
      continue;
    }
    const cand: BackingReport = {
      passK: r.passK!,
      perTrialPassRate: r.perTrialPassRate!,
      perTrialLowerBound95: r.perTrialLowerBound95!,
      trialsTotal: r.trialsTotal!,
      silentCorruptions: r.silentCorruptions!,
      escalationRate: r.escalationRate!,
      mode: String(parsed.mode ?? ""),
      generatedAt: String(parsed.generatedAt ?? ""),
    };
    if (best === null || cand.generatedAt > best.generatedAt) best = cand;
  }
  return best;
}

/** Format a fraction exactly the way harness/report.ts renders cells. */
function pctCell(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** EVERY contiguous pipe block whose header names a Model column — a second
 * results table added later must not escape the guard. */
function modelTables(md: string): string[][] {
  const lines = md.split("\n");
  const tables: string[][] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimStart().startsWith("|") && /^\|\s*Model\s*\|/.test(lines[i]!.trim())) {
      const rows: string[] = [];
      let j = i;
      while (j < lines.length && lines[j]!.trimStart().startsWith("|")) {
        rows.push(lines[j]!);
        j += 1;
      }
      tables.push(rows);
      i = j;
    } else {
      i += 1;
    }
  }
  return tables;
}

/** The % tokens a single artifact can honestly back: exact report cells plus
 * their integer-rounded badge forms. */
function allowedPcts(r: BackingReport): Set<string> {
  const vals = [r.passK, r.perTrialPassRate, r.perTrialLowerBound95, r.escalationRate];
  return new Set(vals.flatMap((v) => [pctCell(v), `${Math.round(v * 100)}%`]));
}

function modelsOnLine(line: string): string[] {
  const lower = line.toLowerCase();
  return KNOWN_MODELS.filter((m) => lower.includes(m));
}

function liveArtifactsFor(models: string[]): BackingReport[] {
  return models
    .map((m) => latestArtifact(m))
    .filter((r): r is BackingReport => r !== null && r.mode === "live");
}

test("per-model results tables: every percentage is its backing live artifact's value — in every table", () => {
  const md = read("README.md");
  const tables = modelTables(md);
  assert.ok(tables.length >= 1, "README must have a per-model results table");
  const rows = tables.flatMap((t) => t.slice(2)); // drop each header + separator
  assert.ok(rows.length >= 3, "expected at least the three wired model rows");
  // Every wired model must appear by name — dropping a row is also dishonest.
  for (const m of KNOWN_MODELS) {
    assert.ok(
      rows.some((r) => r.toLowerCase().includes(m)),
      `the results table must carry a row for ${m}`,
    );
  }
  let measuredRows = 0;
  for (const row of rows) {
    const ids = row.match(/claude-[a-z0-9.-]+/gi) ?? [];
    const hasPct = /\d+(\.\d+)?\s*%/.test(row);
    if (ids.length === 0) {
      assert.ok(!hasPct, `a row naming no model must not carry a percentage: ${row}`);
      continue;
    }
    const model = ids[0]!.toLowerCase();
    assert.ok(
      KNOWN_MODELS.includes(model),
      `unknown model row may not carry results (no artifact can back it): ${row}`,
    );
    const run = latestArtifact(model);
    if (!hasPct) {
      assert.match(row, /pending live run/i, `unmeasured model row must read pending: ${row}`);
      continue;
    }
    // Only a LIVE artifact backs a capability claim — a golden-replay stub is
    // trivially 100% and must never license a "measured" row.
    assert.ok(
      run !== null && run.mode === "live",
      `row for ${model} shows a percentage but no committed LIVE runs/ artifact backs it: ${row}`,
    );
    // Value-pinning: the row's numbers must BE the artifact's numbers — an
    // existing artifact does not license a different percentage next to it.
    const passed = Math.round(run!.perTrialPassRate * run!.trialsTotal);
    assert.ok(
      row.includes(pctCell(run!.passK)),
      `row must carry the measured pass^k ${pctCell(run!.passK)}: ${row}`,
    );
    assert.ok(
      row.includes(pctCell(run!.perTrialLowerBound95)),
      `row must carry the measured floor ${pctCell(run!.perTrialLowerBound95)}: ${row}`,
    );
    assert.ok(
      row.includes(`${passed}/${run!.trialsTotal}`),
      `row must carry the measured trials ${passed}/${run!.trialsTotal}: ${row}`,
    );
    assert.ok(
      row.includes(pctCell(run!.escalationRate)),
      `row must carry the measured escalation rate ${pctCell(run!.escalationRate)}: ${row}`,
    );
    assert.ok(
      new RegExp(`\\|\\s*\\*{0,2}${run!.silentCorruptions}\\*{0,2}\\s*\\|`).test(row),
      `row must carry the measured silent-corruption count ${run!.silentCorruptions}: ${row}`,
    );
    // And NOTHING ELSE: every % token in a measured row must be one the
    // artifact backs — extra fabricated percentages cannot ride along.
    const allowed = allowedPcts(run!);
    for (const tok of row.match(/\d+(?:\.\d+)?%/g) ?? []) {
      assert.ok(allowed.has(tok), `row carries ${tok}, which the backing artifact does not: ${row}`);
    }
    measuredRows += 1;
  }
  if (KNOWN_MODELS.some((m) => latestArtifact(m) !== null)) {
    assert.ok(measuredRows >= 1, "an artifact-backed model must show its measured row");
  }
  // At least one model must still be pending (sonnet/fable are unmeasured).
  assert.ok(
    rows.some((r) => /pending live run/i.test(r)),
    "unmeasured rows must read pending live run",
  );

  // Outside the results tables, ANY pipe-line that names a wired model (the
  // status matrix, a future second table without a Model header) may only
  // carry numbers its own named models' live artifacts back.
  const tableLines = new Set(tables.flat());
  for (const line of md.split("\n")) {
    if (!line.trimStart().startsWith("|") || tableLines.has(line)) continue;
    const named = modelsOnLine(line);
    if (named.length === 0) continue;
    const backed = liveArtifactsFor(named);
    const allowed = new Set(backed.flatMap((r) => [...allowedPcts(r)]));
    for (const tok of line.match(/\d+(?:\.\d+)?%/g) ?? []) {
      assert.ok(
        allowed.has(tok),
        `line names ${named.join(", ")} but claims ${tok}, which no backing artifact carries: ${line}`,
      );
    }
    const allowedFrac = new Set(
      backed.map((r) => `${Math.round(r.perTrialPassRate * r.trialsTotal)}/${r.trialsTotal}`),
    );
    for (const m of line.matchAll(/\((\d+\/\d+)[^)]*\)/g)) {
      assert.ok(
        allowedFrac.has(m[1]!),
        `line names a model but claims fraction (${m[1]}), which no artifact backs: ${line}`,
      );
    }
  }
});

test("README results badges carry only artifact-backed percentages — every badge line", () => {
  const md = read("README.md");
  const liveAll = KNOWN_MODELS.map((m) => ({ m, r: latestArtifact(m) })).filter(
    (x): x is { m: string; r: BackingReport } => x.r !== null && x.r.mode === "live",
  );
  const badgeLines = md.split("\n").filter((l) => l.includes("img.shields.io"));
  if (liveAll.length > 0) {
    assert.ok(
      badgeLines.some((l) => /pass/i.test(l)),
      "a live measurement exists, so a results badge must exist",
    );
  }
  let checkedAny = false;
  for (const badgeLine of badgeLines) {
    // Decode the shields.io URL-encoding first ('%25' -> '%', '%20' -> ' ') so
    // number extraction cannot swallow encoding bytes.
    let decoded: string;
    try {
      decoded = decodeURIComponent(badgeLine);
    } catch {
      decoded = badgeLine;
    }
    const claimed = decoded.match(/\d+(?:\.\d+)?%/g) ?? [];
    if (claimed.length === 0) continue; // plumbing badge with no numbers
    assert.ok(liveAll.length > 0, `a badge claims percentages but nothing is measured: ${badgeLine}`);
    // Associate the badge with the model(s) its label names (shields escapes
    // '-' as '--' and the label writes 'opus-4.8'), so one model's numbers
    // cannot ride under another model's name once more runs land.
    const norm = decoded.toLowerCase().replace(/--/g, "-").replace(/\./g, "-");
    const named = liveAll.filter(({ m }) => norm.includes(m.replace("claude-", "")));
    const pool = named.length > 0 ? named : liveAll;
    const allowed = new Set(pool.flatMap(({ r }) => [...allowedPcts(r)]));
    for (const c of claimed) {
      assert.ok(allowed.has(c), `badge claims ${c}, which no committed artifact backs: ${badgeLine}`);
    }
    assert.ok(
      pool.some(({ r }) => decoded.includes(`${r.silentCorruptions} corruption`)),
      `badge must carry the measured silent-corruption count: ${badgeLine}`,
    );
    checkedAny = true;
  }
  if (liveAll.length > 0) {
    assert.ok(checkedAny, "at least one results badge must carry the measured numbers");
  }
});

test("README prose result claims (floor, n/n trials, corruption counts) are artifact-backed", () => {
  // Join blockquote-wrapped lines ('0 silent\n> corruptions') so a claim
  // cannot escape the scan by sitting across a markdown line wrap, then scan
  // LINE BY LINE so a claim is checked against the model(s) that line names —
  // one model's numbers cannot ride under another model's name.
  const flat = read("README.md").replace(/\n>\s?/g, " ");
  const liveAll = KNOWN_MODELS.map((m) => latestArtifact(m)).filter(
    (r): r is BackingReport => r !== null && r.mode === "live",
  );
  if (liveAll.length === 0) return; // nothing measured, nothing to pin
  for (const line of flat.split("\n")) {
    const named = liveArtifactsFor(modelsOnLine(line));
    const pool = named.length > 0 ? named : liveAll;
    // Decimal floor claims: '94.0% floor', 'floor 94.0%', and the README's own
    // headline phrasing '94.0% Clopper–Pearson floor ...' (a short non-numeric
    // gap is allowed). Integer forms like the '95%' confidence level are the
    // badge/table tests' concern.
    const allowedFloor = new Set(pool.map((r) => pctCell(r.perTrialLowerBound95)));
    for (const m of line.matchAll(/(\d+\.\d+%)[^.%\n]{0,60}?floor|floor[^.%\n]{0,60}?(\d+\.\d+%)/gi)) {
      const val = (m[1] ?? m[2])!;
      assert.ok(
        allowedFloor.has(val),
        `floor claim ${val} is not backed by a named artifact: ${line}`,
      );
    }
    // Parenthesized trial fractions count as claims only on lines that name a
    // model — '(4/12) of the tasks' style prose elsewhere is not a trial claim.
    if (named.length > 0) {
      const allowedFrac = new Set(
        named.map((r) => `${Math.round(r.perTrialPassRate * r.trialsTotal)}/${r.trialsTotal}`),
      );
      for (const m of line.matchAll(/\((\d+\/\d+)[^)]*\)/g)) {
        assert.ok(
          allowedFrac.has(m[1]!),
          `trial fraction (${m[1]}) is not backed by a named artifact: ${line}`,
        );
      }
    }
    const allowedCorr = new Set(pool.map((r) => String(r.silentCorruptions)));
    for (const m of line.matchAll(/(\d+)\s+(?:silent\s+)?corruptions/gi)) {
      assert.ok(
        allowedCorr.has(m[1]!),
        `corruption count "${m[1]} corruptions" is not backed by a named artifact: ${line}`,
      );
    }
  }
});

test("README quickstart carries the exact plumbing-only commands", () => {
  const md = read("README.md");
  assert.match(md, /npm ci/, "quickstart: npm ci");
  assert.match(md, /playwright install chromium/, "quickstart: playwright install chromium");
  assert.match(md, /npm test/, "quickstart: npm test");
  assert.match(md, /npm run oracle/, "quickstart: npm run oracle");
  assert.match(md, /--model stub/, "quickstart: stub trials");
  assert.match(md, /npm run gate/, "quickstart: gate");
  assert.match(md, /ANTHROPIC_API_KEY/, "quickstart: key-gated live run");
});

test("README cross-links discovery, security, and verification docs", () => {
  const md = read("README.md");
  assert.match(md, /docs\/DISCOVERY\.md/, "link to docs/DISCOVERY.md");
  assert.match(md, /SECURITY\.md/, "link to SECURITY.md");
  assert.match(md, /docs\/VERIFICATION\.md/, "link to docs/VERIFICATION.md");
});

test("README makes no 'nobody does evals' claim", () => {
  const md = read("README.md").toLowerCase();
  assert.doesNotMatch(md, /nobody (does|runs) evals/, "must not claim nobody does evals");
  assert.doesNotMatch(md, /no one (does|runs) evals/, "must not claim no one does evals");
});

// ---------------------------------------------------------------------------
// ARCHITECTURE — track/dir map + the data-flow asymmetry
// ---------------------------------------------------------------------------

test("ARCHITECTURE maps every track directory", () => {
  const md = read("ARCHITECTURE.md");
  for (const dir of ["sim/", "groundtruth/", "executor/", "agent/", "harness/", "mcp/"]) {
    assert.ok(md.includes(dir), `ARCHITECTURE must map ${dir}`);
  }
});

test("ARCHITECTURE states the data-flow asymmetry: pixels out, email+db in", () => {
  const md = read("ARCHITECTURE.md");
  assert.match(md, /pixels/i, "agent sees pixels only");
  assert.match(md, /email/i, "verification reads email");
  assert.match(md, /(backend state|db witness|database)/i, "verification reads backend state");
  assert.match(md, /4380/, "public UI port");
  assert.match(md, /4381/, "loopback admin port for the db witness");
});

// ---------------------------------------------------------------------------
// SECURITY — hostile page content, the data-guard gate, guarantees & limits
// ---------------------------------------------------------------------------

test("SECURITY documents the prompt-injection surface and the guard gate", () => {
  const md = read("SECURITY.md");
  assert.match(md, /prompt injection/i, "must name the prompt-injection surface");
  assert.match(md, /hostile/i, "must name hostile page content");
  assert.match(md, /data-guard/, "must name the data-guard mechanism");
  assert.match(md, /approval/i, "must name the approval gate");
});

test("SECURITY states what the gate does NOT guarantee", () => {
  const md = read("SECURITY.md");
  assert.match(
    md,
    /does not (guarantee|protect|prevent|stop)|not guaranteed|does NOT/i,
    "must state the gate's non-guarantees explicitly",
  );
});

// ---------------------------------------------------------------------------
// VERIFICATION — circularity, two witnesses, the toast race
// ---------------------------------------------------------------------------

test("VERIFICATION explains circularity, two witnesses, and the toast race", () => {
  const md = read("docs/VERIFICATION.md");
  assert.match(md, /circular/i, "must explain why screen-scrape verification is circular");
  assert.match(md, /two[- ]witness/i, "must name the two-witness design");
  assert.match(md, /email/i, "witness: email");
  assert.match(md, /(backend|db)/i, "witness: backend state");
  assert.match(md, /toast/i, "must give the toast-race example");
});

// ---------------------------------------------------------------------------
// DISCOVERY — live-run findings filled; the first-user half explicitly pending
// ---------------------------------------------------------------------------

test("DISCOVERY keeps the first-user half explicitly marked pending", () => {
  const md = read("docs/DISCOVERY.md");
  assert.match(
    md,
    /pending (first real user|live run)/i,
    "DISCOVERY must be marked pending first real user + live run",
  );
  assert.match(md, /who .*user/i, "template prompt: who the user is");
  assert.match(md, /cut/i, "template prompt: what was cut");
  assert.match(md, /surprised|surprise/i, "template prompt: what surprised");
  assert.match(md, /measure next/i, "template prompt: what to measure next");
});


test("BENCHMARK's task-level floor derives from the committed artifact", () => {
  // The only results number without a pin until now. Recompute the task-level
  // CP bound straight from the committed opus artifact; when a re-pinned run
  // changes the task count, this goes red until the doc is re-derived.
  const artifactName = readdirSync("runs").find(
    (f) => f.startsWith("claude-opus-4-8-") && f.endsWith(".json"),
  );
  assert.ok(artifactName, "committed opus artifact must exist");
  const artifact = JSON.parse(read(join("runs", artifactName as string))) as {
    report: { perTask: Array<{ passAllK: boolean }> };
  };
  const n = artifact.report.perTask.length;
  const s = artifact.report.perTask.filter((t) => t.passAllK).length;
  const floor = clopperPearsonLower(s, n);
  const md = read("docs/BENCHMARK.md");
  assert.ok(
    md.includes(`0.025^(1/${n})`) || s !== n,
    `BENCHMARK must show the all-pass closed form for n=${n}`,
  );
  assert.ok(
    md.includes(floor.toFixed(4).replace(/0+$/, "")) || md.includes(floor.toFixed(4)),
    `BENCHMARK's task-level floor must be the artifact-derived ${floor.toFixed(4)}`,
  );
  assert.ok(
    md.includes(`${s}/${n} tasks passing all k`),
    `BENCHMARK must describe the artifact's actual ${s}/${n} task outcome`,
  );
});
