/**
 * T7 (CI + ops) contract tests.
 *
 * These are pure file-content checks — no browser, no network, fast — that pin
 * the three deliverables (the gate workflow, .env.example, DEMO.md) to their
 * contract and, critically, cross-check every `npm run <script>` they reference
 * against package.json. That last check is what catches a renamed or typo'd
 * script before CI does, since this repo has no runnable "does the YAML lint"
 * dependency available.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

/** Extract the argument of every single-line `run:` step in a YAML fragment. */
function runCommands(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\s*run:\s*(.+?)\s*$/.exec(line);
    const cmd = m?.[1];
    if (cmd !== undefined) out.push(cmd);
  }
  return out;
}

/** Assert `needles` appear (as substrings) in `haystack` in the given order. */
function assertOrdered(haystack: string[], needles: string[]): void {
  let cursor = 0;
  for (const needle of needles) {
    let found = -1;
    for (let i = cursor; i < haystack.length; i++) {
      const h = haystack[i];
      if (h !== undefined && h.includes(needle)) {
        found = i;
        break;
      }
    }
    assert.ok(
      found >= 0,
      `expected a step containing "${needle}" at/after position ${cursor}; got ${JSON.stringify(haystack)}`,
    );
    cursor = found + 1;
  }
}

/** Every distinct `npm run <script>` name referenced in a text blob. */
function referencedScripts(text: string): string[] {
  const names = new Set<string>();
  const re = /npm run ([a-z][a-z0-9:_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

interface PackageJson {
  scripts: Record<string, string>;
}

function loadScripts(): Record<string, string> {
  const pkg = JSON.parse(read("package.json")) as PackageJson;
  return pkg.scripts ?? {};
}

// --- Workflow: file shape ---------------------------------------------------

const wf = read(".github/workflows/gate.yml");
const gateStart = wf.indexOf("\n  gate:");
const liveStart = wf.indexOf("\n  live:");
const gateSection = gateStart >= 0 ? wf.slice(gateStart, liveStart >= 0 ? liveStart : undefined) : "";
const liveSection = liveStart >= 0 ? wf.slice(liveStart) : "";

test("workflow is named gate and defines both jobs", () => {
  assert.match(wf, /^name:\s*gate\s*$/m);
  assert.ok(gateStart >= 0, "missing `gate` job");
  assert.ok(liveStart > gateStart, "missing `live` job (must follow `gate`)");
});

test("workflow triggers on push, pull_request, and workflow_dispatch", () => {
  const onStart = wf.indexOf("\non:");
  const jobsStart = wf.indexOf("\njobs:");
  assert.ok(onStart >= 0 && jobsStart > onStart, "missing on:/jobs: blocks");
  const onBlock = wf.slice(onStart, jobsStart);
  assert.match(onBlock, /\bpush:/);
  assert.match(onBlock, /\bpull_request:/);
  assert.match(onBlock, /\bworkflow_dispatch:/);
});

test("both jobs pin Node 24", () => {
  const versions = [...wf.matchAll(/node-version:\s*'?"?([\w.]+)'?"?/g)].map((m) => m[1]);
  assert.ok(versions.length >= 2, "expected node-version set on both jobs");
  for (const v of versions) assert.equal(v, "24");
});

// --- Workflow: the gate job (key-free, ordered) -----------------------------

test("gate job runs on push/PR only and is key-free", () => {
  const ifLine = /if:\s*(.+)/.exec(gateSection);
  assert.ok(ifLine?.[1], "gate job needs an `if` guard");
  const cond = ifLine[1] as string;
  assert.ok(cond.includes("push"), "gate should run on push");
  assert.ok(cond.includes("pull_request"), "gate should run on pull_request");
  assert.ok(!cond.includes("workflow_dispatch"), "gate must not run on manual dispatch");
  assert.ok(!gateSection.includes("secrets."), "gate job must be key-free (no secrets)");
  assert.ok(
    !gateSection.includes("ANTHROPIC_API_KEY"),
    "gate job must not need ANTHROPIC_API_KEY",
  );
});

test("gate job runs the full pipeline in contract order", () => {
  assertOrdered(runCommands(gateSection), [
    "npm ci",
    "npm audit --omit=dev --audit-level=high",
    "npx playwright install --with-deps chromium",
    "npm run typecheck",
    "npm test",
    "npm run oracle",
    "npm run trials -- --model stub",
    "npm run gate",
  ]);
});

// --- Workflow: the live job (key-gated, uploads artifacts) -------------------

test("live job is workflow_dispatch-only, keyed, opus, uploads runs/", () => {
  assert.match(liveSection, /if:\s*[^\n]*workflow_dispatch/);
  assert.ok(
    liveSection.includes("secrets.ANTHROPIC_API_KEY"),
    "live job must wire the ANTHROPIC_API_KEY secret",
  );
  const liveRuns = runCommands(liveSection);
  assert.ok(
    liveRuns.some((c) => c.includes("--model claude-opus-4-8")),
    "live job must run trials on claude-opus-4-8",
  );
  assert.match(liveSection, /uses:\s*actions\/upload-artifact/);
  assert.match(liveSection, /path:[\s\S]*runs\//);
});

// --- Workflow: notes + script integrity -------------------------------------

test("workflow documents the macOS->Linux lockfile regen", () => {
  assert.ok(
    wf.includes("npx npm@latest --package-lock-only"),
    "missing the lockfile regeneration note",
  );
});

test("every npm-run script the workflow references exists in package.json", () => {
  const scripts = loadScripts();
  for (const name of referencedScripts(wf)) {
    assert.ok(scripts[name], `gate.yml references \`npm run ${name}\` but package.json has no such script`);
  }
});

// --- .env.example -----------------------------------------------------------

test(".env.example carries the required keys and no committed secret", () => {
  const env = read(".env.example");
  for (const key of ["ANTHROPIC_API_KEY", "IMAP_HOST", "IMAP_USER", "IMAP_PASS", "MAUDSLAY_MODEL"]) {
    assert.match(env, new RegExp(`^${key}=`, "m"), `.env.example missing \`${key}=\``);
  }
  assert.match(env, /^MAUDSLAY_MODEL=claude-opus-4-8\s*$/m);
  // The template must never carry a live-looking key value.
  assert.ok(!/ANTHROPIC_API_KEY=sk-[A-Za-z0-9]/.test(env), ".env.example must not contain a real key");
  assert.match(env, /^ANTHROPIC_API_KEY=\s*$/m, "ANTHROPIC_API_KEY must be blank in the template");
});

// --- DEMO.md ----------------------------------------------------------------

test("DEMO.md is a runnable 5-step runbook ending in a live-run section", () => {
  const demo = read("DEMO.md");
  for (const cmd of [
    "npm ci",
    "npm test",
    "npm run oracle",
    "npm run trials -- --model stub",
    "npm run gate",
  ]) {
    assert.ok(demo.includes(cmd), `DEMO.md missing runbook command: ${cmd}`);
  }
  assert.ok(demo.includes("--model claude-opus-4-8"), "DEMO.md must document a live run");
  assert.ok(demo.includes("ANTHROPIC_API_KEY"), "DEMO.md must reference the API key for live runs");
});

test("every npm-run script DEMO.md references exists in package.json", () => {
  const scripts = loadScripts();
  const demo = read("DEMO.md");
  for (const name of referencedScripts(demo)) {
    assert.ok(scripts[name], `DEMO.md references \`npm run ${name}\` but package.json has no such script`);
  }
});

test("no fabricated passing badge is committed in the runbook", () => {
  const demo = read("DEMO.md");
  assert.ok(!/!\[[^\]]*\]\([^)]*badge[^)]*\)/i.test(demo), "no static badge image in DEMO.md");
  assert.ok(!/shields\.io[^\s)]*passing/i.test(demo), "no hardcoded passing badge");
});
