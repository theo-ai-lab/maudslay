/**
 * Read/query/clear access to the mailbox the SMTP sink persists to.
 *
 * The mailbox is a directory of one-JSON-per-message files. This module never
 * mutates a captured message; it only reads them back as CapturedEmail and
 * offers a small query surface the verifier and MCP server use to locate the
 * confirmation email for a given booking reference.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CapturedEmail } from "../src/types.ts";
import { defaultMailDir, type StoredEmail } from "./smtp-sink.ts";

export { defaultMailDir };

export interface EmailQuery {
  ref?: string;
  kind?: string;
  to?: string;
  from?: string;
  subjectIncludes?: string;
}

/** All captured mail, oldest first. */
export function listMail(mailDir: string = defaultMailDir()): CapturedEmail[] {
  return readAll(mailDir)
    .sort(byArrival)
    .map(toCaptured);
}

export function getMail(id: string, mailDir: string = defaultMailDir()): CapturedEmail | undefined {
  const rec = readAll(mailDir).find((r) => r.id === id);
  return rec ? toCaptured(rec) : undefined;
}

export function queryMail(q: EmailQuery, mailDir: string = defaultMailDir()): CapturedEmail[] {
  return readAll(mailDir)
    .filter((r) => matches(r, q))
    .sort(byArrival)
    .map(toCaptured);
}

/** The most recent message whose parsed booking reference equals `ref`. */
export function findByRef(ref: string, mailDir: string = defaultMailDir()): CapturedEmail | undefined {
  const hits = readAll(mailDir)
    .filter((r) => r.parsed?.ref === ref)
    .sort(byArrival);
  const last = hits.at(-1);
  return last ? toCaptured(last) : undefined;
}

/** Delete every captured message. Returns the number removed. */
export function clearMail(mailDir: string = defaultMailDir()): number {
  if (!existsSync(mailDir)) return 0;
  let removed = 0;
  for (const name of readdirSync(mailDir)) {
    if (name.endsWith(".json")) {
      rmSync(join(mailDir, name));
      removed += 1;
    }
  }
  return removed;
}

function readAll(mailDir: string): StoredEmail[] {
  if (!existsSync(mailDir)) return [];
  const out: StoredEmail[] = [];
  for (const name of readdirSync(mailDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(mailDir, name), "utf8");
      out.push(JSON.parse(raw) as StoredEmail);
    } catch {
      // A half-written or malformed file is skipped rather than crashing a read.
    }
  }
  return out;
}

function byArrival(a: StoredEmail, b: StoredEmail): number {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

function matches(r: StoredEmail, q: EmailQuery): boolean {
  if (q.ref !== undefined && r.parsed?.ref !== q.ref) return false;
  if (q.kind !== undefined && r.parsed?.kind !== q.kind) return false;
  if (q.from !== undefined && !r.from.includes(q.from)) return false;
  if (q.to !== undefined && !r.to.some((addr) => addr.includes(q.to as string))) return false;
  if (q.subjectIncludes !== undefined && !r.subject.includes(q.subjectIncludes)) return false;
  return true;
}

function toCaptured(r: StoredEmail): CapturedEmail {
  const c: CapturedEmail = {
    id: r.id,
    from: r.from,
    to: r.to,
    subject: r.subject,
    bodyText: r.bodyText,
    receivedAt: r.receivedAt,
  };
  if (r.parsed !== undefined) c.parsed = r.parsed;
  return c;
}
