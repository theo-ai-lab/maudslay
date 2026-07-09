/**
 * Ratchet config loading — split from gate.ts so the gate file carries the
 * decision logic and this file carries the config's fail-closed parsing. Same
 * contract as always: a MISSING file is the bootstrap no-op; a file that exists
 * but is corrupt, mistyped, out of range, tolerance-weakening, or mis-pinned is
 * an attack surface and fails the gate (see decisions/D5).
 */

import { readFileSync } from "node:fs";
import type { RatchetConfig } from "../src/types.ts";

export function parseRatchet(raw: unknown): { config: RatchetConfig; problems: string[] } {
  const models: RatchetConfig["models"] = {};
  const problems: string[] = [];
  if (raw && typeof raw === "object") {
    const m = (raw as { models?: unknown }).models;
    if (m && typeof m === "object") {
      for (const [id, cfg] of Object.entries(m as Record<string, unknown>)) {
        if (!cfg || typeof cfg !== "object") {
          problems.push(`ratchet config: entry for ${id} is not an object — failing closed`);
          continue;
        }
        const c = cfg as Record<string, unknown>;
        // A field that is PRESENT but not a finite number is a floor being
        // erased without signal (e.g. minPassK: "0.9" silently coercing to 0).
        // Absent fields keep their documented defaults.
        for (const field of ["minPassK", "k", "minTasks"] as const) {
          if (field in c && !Number.isFinite(c[field])) {
            problems.push(
              `ratchet config: ${id}.${field} is present but not a number — a floor must never silently coerce to 0; failing closed`,
            );
          }
        }
        // Out-of-range values are the same attack with a valid type: a
        // negative minPassK skips every measured-floor branch, k below 1 or a
        // negative minTasks make their checks vacuous.
        if (typeof c.minPassK === "number" && (c.minPassK < 0 || c.minPassK > 1)) {
          problems.push(
            `ratchet config: ${id}.minPassK=${c.minPassK} is outside [0, 1] — failing closed`,
          );
        }
        if (typeof c.k === "number" && c.k < 1) {
          problems.push(`ratchet config: ${id}.k=${c.k} is below 1 — failing closed`);
        }
        if (typeof c.minTasks === "number" && c.minTasks < 0) {
          problems.push(
            `ratchet config: ${id}.minTasks=${c.minTasks} is negative — failing closed`,
          );
        }
        // The silent-corruption invariant is hard-zero for every model, by
        // design. A config that PRESENTS a nonzero maxSilentCorruptions is
        // trying to weaken that invariant — reject it loudly rather than
        // silently clamping to 0 (a clamp lets the config lie about its own
        // tolerance). Absent = the documented default of 0.
        if ("maxSilentCorruptions" in c && c.maxSilentCorruptions !== 0) {
          problems.push(
            `ratchet config: ${id}.maxSilentCorruptions=${JSON.stringify(c.maxSilentCorruptions)} — ` +
              `the corruption tolerance is hard-zero for every model and cannot be raised; failing closed`,
          );
        }
        // Optional rollback lock. A malformed pin (present but not { generatedAt: string })
        // is a floor being erased without signal — same treatment as a mistyped minPassK.
        let pin: { generatedAt: string; sha256?: string } | undefined;
        if ("pinnedArtifact" in c && c.pinnedArtifact !== undefined) {
          const p = c.pinnedArtifact as Record<string, unknown> | null;
          const shaOk = p && (p.sha256 === undefined || typeof p.sha256 === "string");
          if (p && typeof p === "object" && typeof p.generatedAt === "string" && shaOk) {
            pin = { generatedAt: p.generatedAt, ...(typeof p.sha256 === "string" ? { sha256: p.sha256 } : {}) };
            // A pin only means something on a MEASURED floor. Pinning a dormant
            // (minPassK = 0) entry is a config mistake — it locks an artifact
            // whose floor checks never run. Reject it.
            const mpk = typeof c.minPassK === "number" ? c.minPassK : 0;
            if (mpk <= 0) {
              problems.push(
                `ratchet config: ${id}.pinnedArtifact is set but minPassK=${mpk} (dormant) — ` +
                  `a pin only applies to a measured floor; failing closed`,
              );
            }
          } else {
            problems.push(
              `ratchet config: ${id}.pinnedArtifact is present but not { generatedAt: string, sha256?: string } — failing closed`,
            );
          }
        }
        models[id] = {
          minPassK: typeof c.minPassK === "number" ? c.minPassK : 0,
          k: typeof c.k === "number" ? c.k : 1,
          maxSilentCorruptions: 0,
          minTasks: typeof c.minTasks === "number" ? c.minTasks : 0,
          ...(pin ? { pinnedArtifact: pin } : {}),
        };
      }
    }
  }
  return { config: { models }, problems };
}

/**
 * Read the ratchet config, separating the bootstrap case from corruption. A
 * MISSING file made no promises (fork with no floors — the gate stays a
 * labelled no-op); a file that EXISTS but cannot be parsed, or that carries
 * mistyped floor fields, is the same attack surface as a corrupted run
 * artifact and must fail the gate rather than silently dropping every floor.
 */
export function loadRatchetAudit(path: string): { config: RatchetConfig; problems: string[] } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // Missing file = bootstrap (no promises). Any other read failure means a
    // config EXISTS but cannot be seen — fail closed like a corrupt one.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: { models: {} }, problems: [] };
    }
    return {
      config: { models: {} },
      problems: [
        `ratchet config at ${path} exists but is unreadable (${(e as NodeJS.ErrnoException).code ?? "error"}) — failing closed`,
      ],
    };
  }
  try {
    return parseRatchet(JSON.parse(raw));
  } catch {
    return {
      config: { models: {} },
      problems: [`ratchet config at ${path} is unreadable or malformed JSON — failing closed`],
    };
  }
}

export function loadRatchet(path: string): RatchetConfig {
  return loadRatchetAudit(path).config;
}
