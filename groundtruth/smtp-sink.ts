/**
 * A zero-dependency SMTP capture server ("sink") built on node:net.
 *
 * It is not a real MTA — it never relays. It speaks just enough of the SMTP
 * happy path (HELO/EHLO, MAIL FROM, RCPT TO, DATA ... CRLF.CRLF) to accept a
 * message from the sim's minimal client and persist it, so that the verifier
 * has an independent side-channel witness of what the app actually sent.
 *
 * Each captured message is written as one JSON file to `var/mail/<id>.json`
 * containing the parsed headers, the raw DATA payload, and the booking fields
 * extracted from the confirmation body. The mailbox is a plain directory so any
 * process (store, verifier, tests) can read it without shared state.
 */

import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PORTS, VAR_DIRS, type CapturedEmail } from "../src/types.ts";
import { parseConfirmationBody } from "./email-parse.ts";

/** The on-disk record: a CapturedEmail plus provenance the store may use. */
export interface StoredEmail extends CapturedEmail {
  /** the raw DATA payload as received (headers + body), CRLF preserved. */
  raw: string;
  headers: Record<string, string>;
  /** monotonic capture order within a running sink, for stable sorting. */
  seq: number;
}

export interface SmtpSinkOptions {
  host?: string;
  port?: number;
  mailDir?: string;
}

export interface SmtpSinkHandle {
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
  port(): number;
  readonly mailDir: string;
}

let seqCounter = 0;

export function defaultMailDir(): string {
  return resolve(process.cwd(), VAR_DIRS.mail);
}

export function createSmtpSink(opts: SmtpSinkOptions = {}): SmtpSinkHandle {
  const host = opts.host ?? "127.0.0.1";
  const wantPort = opts.port ?? PORTS.smtpSink;
  const mailDir = opts.mailDir ?? defaultMailDir();
  let boundPort = wantPort;

  const server = net.createServer((socket) => handleConnection(socket, mailDir));
  // Do not keep the event loop alive purely for the sink when run embedded.
  server.on("error", () => {});

  return {
    mailDir,
    port: () => boundPort,
    start() {
      return new Promise((res, rej) => {
        mkdirSync(mailDir, { recursive: true });
        const onError = (err: Error) => rej(err);
        server.once("error", onError);
        server.listen(wantPort, host, () => {
          const addr = server.address();
          if (addr && typeof addr === "object") boundPort = addr.port;
          server.removeListener("error", onError);
          res({ host, port: boundPort });
        });
      });
    },
    stop() {
      return new Promise((res) => {
        server.close(() => res());
      });
    },
  };
}

function handleConnection(socket: net.Socket, mailDir: string): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let mode: "command" | "data" = "command";
  let dataBuf = "";
  let mailFrom = "";
  let rcpts: string[] = [];

  socket.write("220 maudslay SMTP sink ready\r\n");

  const resetTxn = () => {
    mailFrom = "";
    rcpts = [];
    dataBuf = "";
  };

  const finishData = () => {
    const record = buildRecord(dataBuf, mailFrom, rcpts);
    persist(record, mailDir);
    resetTxn();
    mode = "command";
    socket.write(`250 OK queued ${record.id}\r\n`);
  };

  const handleCommand = (line: string) => {
    const upper = line.trim().toUpperCase();
    if (upper.startsWith("HELO")) {
      socket.write("250 maudslay\r\n");
    } else if (upper.startsWith("EHLO")) {
      socket.write("250-maudslay\r\n250 OK\r\n");
    } else if (upper.startsWith("MAIL FROM")) {
      mailFrom = extractAngle(line);
      socket.write("250 OK\r\n");
    } else if (upper.startsWith("RCPT TO")) {
      rcpts.push(extractAngle(line));
      socket.write("250 OK\r\n");
    } else if (upper === "DATA") {
      mode = "data";
      dataBuf = "";
      socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
    } else if (upper === "RSET") {
      resetTxn();
      socket.write("250 OK\r\n");
    } else if (upper.startsWith("NOOP")) {
      socket.write("250 OK\r\n");
    } else if (upper === "QUIT") {
      socket.write("221 Bye\r\n");
      socket.end();
    } else {
      socket.write("502 command not implemented\r\n");
    }
  };

  const pump = () => {
    let progress = true;
    while (progress) {
      progress = false;
      if (mode === "command") {
        const idx = buffer.indexOf("\r\n");
        if (idx >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleCommand(line);
          progress = true;
        }
      } else {
        // Empty message: the terminating dot arrives with no preceding body.
        if (dataBuf === "" && buffer.startsWith(".\r\n")) {
          buffer = buffer.slice(3);
          finishData();
          progress = true;
          continue;
        }
        const term = buffer.indexOf("\r\n.\r\n");
        if (term >= 0) {
          dataBuf += buffer.slice(0, term);
          buffer = buffer.slice(term + 5);
          finishData();
          progress = true;
        } else if (buffer.length > 4) {
          // Keep the last 4 bytes: they may be a terminator split across chunks.
          dataBuf += buffer.slice(0, buffer.length - 4);
          buffer = buffer.slice(buffer.length - 4);
        }
      }
    }
  };

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    pump();
  });
  socket.on("error", () => {});
}

function buildRecord(raw: string, mailFrom: string, rcpts: string[]): StoredEmail {
  const { headers, bodyText } = splitMessage(raw);
  const from = headers["from"] ?? mailFrom;
  const toHeader = headers["to"];
  const to = toHeader !== undefined ? splitAddrs(toHeader) : [...rcpts];
  const subject = headers["subject"] ?? "";
  const parsed = parseConfirmationBody(bodyText, subject);

  const rec: StoredEmail = {
    id: randomUUID(),
    from,
    to,
    subject,
    bodyText,
    receivedAt: new Date().toISOString(),
    raw,
    headers,
    seq: ++seqCounter,
  };
  if (Object.keys(parsed).length > 0) rec.parsed = parsed;
  return rec;
}

function splitMessage(raw: string): { headers: Record<string, string>; bodyText: string } {
  const norm = raw.replace(/\r\n/g, "\n");
  const sep = norm.indexOf("\n\n");
  const headerPart = sep >= 0 ? norm.slice(0, sep) : norm;
  const bodyText = sep >= 0 ? norm.slice(sep + 2) : "";

  const headers: Record<string, string> = {};
  let lastKey: string | undefined;
  for (const line of headerPart.split("\n")) {
    if (/^\s/.test(line) && lastKey !== undefined) {
      // folded continuation of the previous header
      headers[lastKey] = `${headers[lastKey] ?? ""} ${line.trim()}`;
      continue;
    }
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    const key = m?.[1];
    const val = m?.[2];
    if (key !== undefined && val !== undefined) {
      const k = key.toLowerCase();
      headers[k] = val.trim();
      lastKey = k;
    }
  }
  return { headers, bodyText };
}

function extractAngle(line: string): string {
  const m = /<([^>]*)>/.exec(line);
  if (m?.[1] !== undefined) return m[1];
  const colon = line.indexOf(":");
  return colon >= 0 ? line.slice(colon + 1).trim() : line.trim();
}

function splitAddrs(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function persist(rec: StoredEmail, mailDir: string): void {
  mkdirSync(mailDir, { recursive: true });
  writeFileSync(join(mailDir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
}

// Auto-start when executed directly (npm run sink); stays a library otherwise.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) {
  const sink = createSmtpSink();
  sink.start().then(({ host, port }) => {
    process.stdout.write(`smtp sink listening on ${host}:${port} -> ${sink.mailDir}\n`);
  });
}
