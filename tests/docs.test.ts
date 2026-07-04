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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

/** Extract the fenced/section block that holds the per-model results table. */
function perModelTableBlock(md: string): string {
  const idx = md.search(/per-model/i);
  assert.ok(idx >= 0, "README must have a per-model results table section");
  return md.slice(idx, idx + 1400);
}

test("per-model table lists the three models and every result cell is pending", () => {
  const md = read("README.md");
  const block = perModelTableBlock(md);
  assert.match(block, /fable-5/i, "model row: claude-fable-5");
  assert.match(block, /opus-4-8/i, "model row: claude-opus-4-8");
  assert.match(block, /sonnet-4-6/i, "model row: claude-sonnet-4-6");
  assert.match(block, /pending live run/i, "cells must read pending live run");

  // Honesty guard: no fabricated pass^k in the per-model results table body.
  // The ONLY percentage allowed to appear in the doc is the cited OSWorld 20.6%,
  // which lives outside this block. Inside the block, no bare percentage cell.
  const modelRows = block
    .split("\n")
    .filter((l) => /fable-5|opus-4-8|sonnet-4-6/i.test(l) && l.trimStart().startsWith("|"));
  assert.ok(modelRows.length >= 3, "expected three model rows");
  for (const r of modelRows) {
    assert.doesNotMatch(
      r,
      /\d+(\.\d+)?\s*%/,
      `model result row must not carry a fabricated percentage: ${r}`,
    );
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

test("README makes no 'nobody does evals' claim (it would be false)", () => {
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
// DISCOVERY — a template, explicitly pending
// ---------------------------------------------------------------------------

test("DISCOVERY is a template explicitly marked pending", () => {
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

// ---------------------------------------------------------------------------
// Doc content hygiene guard
// ---------------------------------------------------------------------------

test("docs contain no stray placeholder text", () => {
  // (doc content hygiene check)

  const forbidden =
    /\bLOREM_IPSUM_PLACEHOLDER\b/i;
  for (const f of [
    "README.md",
    "ARCHITECTURE.md",
    "SECURITY.md",
    "docs/VERIFICATION.md",
    "docs/DISCOVERY.md",
  ]) {
    assert.doesNotMatch(read(f), forbidden, `${f} must not contain placeholder text`);
  }
});
