/**
 * Minimal SMTP client → the local capture sink (127.0.0.1:4325).
 *
 * HearthDesk sends one confirmation message per committed mutation (created /
 * rescheduled / cancelled). That message is one of the two independent
 * verification witnesses, so the on-wire body is a fixed, machine-parseable
 * shape (see D1). We speak only the happy-path HELO/MAIL/RCPT/DATA subset — the
 * sink implements the matching server half.
 */

import { connect } from "node:net";
import type { Socket } from "node:net";

export type ConfirmationKind = "created" | "rescheduled" | "cancelled";

export interface ConfirmationEmail {
  ref: string;
  kind: ConfirmationKind;
  customerName: string;
  serviceType: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  addressLine: string;
  notes: string; // "" renders as "-"
}

export interface MailerOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4325;
const FROM = "dispatch@hearthdesk.local";
const TO = "ops@hearthdesk.local";

/**
 * Collapse any CR/LF and other control characters to single spaces. The
 * confirmation email is a verification witness whose body is line-oriented, and
 * some fields (address, notes) carry agent-authored free text. Without this, a
 * value like "123 Main St\r\nReference: HD-FORGED" would inject a second
 * Reference line and let the actor forge the witness it is graded against. Every
 * interpolated field is neutralized, not just the free-text ones.
 */
function oneLine(value: string): string {
  // Strip C0 control chars (incl. CR, LF, tab) and DEL, collapsing each
  // run to one space. Hyphens and printables are preserved (phones, ISO
  // dates). This is the witness-integrity boundary: without it, agent
  // free-text could inject extra body lines and forge a graded field.
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Build the RFC5322-ish message. Body field order is fixed for the parser. */
export function buildMessage(e: ConfirmationEmail): {
  from: string;
  to: string;
  subject: string;
  body: string;
} {
  const verb = e.kind === "created" ? "confirmed" : e.kind;
  const subject = oneLine(`HearthDesk booking ${e.ref} ${verb}`);
  const notesRaw = oneLine(e.notes);
  const notes = notesRaw.length > 0 ? notesRaw : "-";
  const bodyLines = [
    `Reference: ${oneLine(e.ref)}`,
    `Kind: ${oneLine(e.kind)}`,
    `Customer: ${oneLine(e.customerName)}`,
    `Service: ${oneLine(e.serviceType)}`,
    `When: ${oneLine(e.date)} ${oneLine(e.time)}`,
    `Address: ${oneLine(e.addressLine)}`,
    `Notes: ${notes}`,
  ];
  return { from: FROM, to: TO, subject, body: bodyLines.join("\r\n") };
}

function fullPayload(m: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): string {
  const now = new Date().toUTCString();
  const headers = [
    `From: HearthDesk Dispatch <${m.from}>`,
    `To: <${m.to}>`,
    `Subject: ${m.subject}`,
    `Date: ${now}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ].join("\r\n");
  // Dot-stuffing: any body line starting with '.' is doubled so it is not read
  // as the DATA terminator.
  const body = m.body.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
  return `${headers}\r\n\r\n${body}`;
}

/**
 * A tiny reader that resolves once a complete SMTP reply line arrives. SMTP
 * replies are "<3-digit code><SP or -><text>"; a space after the code marks the
 * final line of a (possibly multi-line) reply.
 */
function makeReader(sock: Socket): () => Promise<number> {
  let buffer = "";
  const waiters: Array<{
    resolve: (code: number) => void;
    reject: (err: Error) => void;
  }> = [];
  let failed: Error | null = null;

  const tryDeliver = () => {
    while (waiters.length > 0) {
      const idx = findCompleteReply(buffer);
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx);
      const code = Number.parseInt(line.slice(0, 3), 10);
      const w = waiters.shift();
      if (w) w.resolve(Number.isNaN(code) ? -1 : code);
    }
  };

  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    tryDeliver();
  });
  sock.on("error", (err) => {
    failed = err instanceof Error ? err : new Error(String(err));
    while (waiters.length > 0) waiters.shift()?.reject(failed);
  });
  sock.on("close", () => {
    if (!failed) failed = new Error("smtp connection closed");
    while (waiters.length > 0) waiters.shift()?.reject(failed);
  });

  return () =>
    new Promise<number>((resolve, reject) => {
      if (failed) {
        reject(failed);
        return;
      }
      waiters.push({ resolve, reject });
      tryDeliver();
    });
}

/** Index just past the final reply line, or -1 if not yet complete. */
function findCompleteReply(buf: string): number {
  let searchFrom = 0;
  for (;;) {
    const nl = buf.indexOf("\r\n", searchFrom);
    if (nl < 0) return -1;
    const line = buf.slice(searchFrom, nl);
    // A space (not '-') in position 3 marks the last line of the reply.
    if (line.length >= 4 && line[3] === " ") return nl + 2;
    if (line.length === 3) return nl + 2; // bare code, also terminal
    searchFrom = nl + 2;
  }
}

function expect(code: number, ...allowed: number[]): void {
  if (!allowed.includes(code)) {
    throw new Error(`unexpected SMTP reply ${code} (wanted ${allowed.join("/")})`);
  }
}

export async function sendConfirmation(
  email: ConfirmationEmail,
  opts: MailerOptions = {},
): Promise<void> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const m = buildMessage(email);
  const payload = fullPayload(m);

  await new Promise<void>((resolve, reject) => {
    const sock = connect({ host, port });
    sock.setTimeout(timeoutMs);
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    sock.on("timeout", () => done(new Error("smtp timeout")));

    const read = makeReader(sock);
    const write = (line: string) => sock.write(line + "\r\n");

    sock.on("connect", () => {
      (async () => {
        expect(await read(), 220);
        write(`HELO hearthdesk.local`);
        expect(await read(), 250);
        write(`MAIL FROM:<${m.from}>`);
        expect(await read(), 250);
        write(`RCPT TO:<${m.to}>`);
        expect(await read(), 250, 251);
        write("DATA");
        expect(await read(), 354);
        sock.write(payload + "\r\n.\r\n");
        expect(await read(), 250);
        write("QUIT");
        // Some sinks close immediately after QUIT; treat close-before-221 as ok.
        try {
          expect(await read(), 221);
        } catch {
          /* connection may already be closing after accepting the message */
        }
        done();
      })().catch((err) => done(err instanceof Error ? err : new Error(String(err))));
    });
  });
}
