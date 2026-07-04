/**
 * Maudslay ground-truth MCP server (stdio JSON-RPC 2.0).
 *
 * This is the Model Context Protocol surface onto the *independent witnesses*
 * that decide a trial: the confirmation email captured by the SMTP sink and the
 * backend-state snapshot exposed by the sim's admin endpoint. It never reads the
 * screen — the same principle the verifier enforces. A tool client (an operator
 * console, an approval reviewer) can ask this server "did the booking actually
 * happen?" and get an answer grounded in channels the agent under test does not
 * author.
 *
 * Framing: LSP-style `Content-Length` headers.
 *   Each message is `Content-Length: <bytes>\r\n\r\n<utf8 json>`.
 * The default MCP stdio transport is newline-delimited JSON; we deliberately use
 * Content-Length framing (as chosen for this build) because it is length-prefixed
 * and therefore unambiguous when a client streams several messages in one write,
 * with no reliance on the payload being newline-free. For interoperability the
 * reader ALSO accepts newline-delimited input, and every response is emitted in
 * the same framing the request arrived in — so both LSP-style and line-delimited
 * clients work without configuration.
 *
 * Tools:
 *   - verify_booking(ref, expectation?)   two-witness verdict / ground-truth report
 *   - await_confirmation(ref, timeoutMs)  block until the confirmation email lands
 *   - list_captured_mail()                every message the sink has captured
 *   - request_approval(actionSummary)     policy decision for an irreversible action
 *
 * Configuration (env):
 *   MAUDSLAY_MAIL_DIR       mailbox directory (default: var/mail under cwd)
 *   MAUDSLAY_ADMIN_URL      sim admin state URL (default: http://127.0.0.1:4381/state)
 *   MAUDSLAY_APPROVAL_MODE  approve | auto-log | deny  (default: deny, fail-closed)
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  defaultMailDir,
  findByRef,
  listMail,
  queryMail,
} from "../groundtruth/email-store.ts";
import { normalizeSnapshot, verify } from "../groundtruth/verifier.ts";
import type { AgentEndReason, DbStateSnapshot } from "../groundtruth/verifier.ts";
import type {
  ApprovalDecision,
  ApprovalRequest,
  CapturedEmail,
  TaskExpectation,
  Verdict,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Identity & configuration
// ---------------------------------------------------------------------------

const SERVER_NAME = "maudslay-groundtruth";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const AWAIT_TIMEOUT_CAP_MS = 60_000;
const DB_FETCH_TIMEOUT_MS = 2_000;

function mailDir(): string {
  return process.env.MAUDSLAY_MAIL_DIR ?? defaultMailDir();
}

function adminStateUrl(): string {
  return process.env.MAUDSLAY_ADMIN_URL ?? "http://127.0.0.1:4381/state";
}

function approvalMode(): string {
  return process.env.MAUDSLAY_APPROVAL_MODE ?? "deny";
}

// ---------------------------------------------------------------------------
// Tool catalogue (advertised via tools/list)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "verify_booking",
    description:
      "Two-witness ground-truth check for a booking reference. With an expectation, returns a graded Verdict (email + backend state); without one, returns the raw witnesses for the reference. Never reads the screen.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "booking reference, e.g. HD-XXXXXX" },
        expectation: {
          type: "object",
          description:
            "optional TaskExpectation to grade against (kind: booking_created | booking_rescheduled | booking_cancelled | must_escalate)",
        },
        endReason: {
          type: "string",
          description: "how the trial ended; defaults to 'done'",
          enum: ["done", "escalate", "budget_exhausted", "sandbox_blocked", "error"],
        },
        resetAt: {
          type: "string",
          description: "ISO reset timestamp so the db witness can date a mutation (must_escalate)",
        },
      },
      required: ["ref"],
    },
  },
  {
    name: "await_confirmation",
    description:
      "Block until a confirmation email for the reference is captured, or until timeoutMs elapses. Polls the SMTP-sink mailbox; returns the captured email or a timeout result.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "booking reference to wait for" },
        timeoutMs: {
          type: "number",
          description: "max wait in milliseconds (capped at 60000)",
        },
      },
      required: ["ref", "timeoutMs"],
    },
  },
  {
    name: "list_captured_mail",
    description:
      "Return every message the SMTP sink has captured, oldest first, with parsed booking fields where recognized.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "request_approval",
    description:
      "Request a decision for an irreversible action. Applies the server's approval policy (fail-closed 'deny' by default) and returns an ApprovalDecision.",
    inputSchema: {
      type: "object",
      properties: {
        actionSummary: {
          type: "string",
          description: "human-readable description of what is about to be committed",
        },
        taskId: { type: "string", description: "optional task identifier for the audit record" },
      },
      required: ["actionSummary"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

interface ToolOutcome {
  structuredContent: unknown;
  isError: boolean;
}

function toolError(message: string): ToolOutcome {
  return { structuredContent: { error: message }, isError: true };
}

const END_REASONS: AgentEndReason[] = [
  "done",
  "escalate",
  "budget_exhausted",
  "sandbox_blocked",
  "error",
];

function normalizeEndReason(v: unknown): AgentEndReason {
  if (typeof v === "string" && (END_REASONS as string[]).includes(v)) {
    return v as AgentEndReason;
  }
  return "done";
}

function summariseEmail(e: CapturedEmail): Record<string, unknown> {
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    subject: e.subject,
    receivedAt: e.receivedAt,
    parsed: e.parsed ?? null,
  };
}

interface DbFetch {
  snapshot: DbStateSnapshot;
  ok: boolean;
  detail: string;
}

/** Fetch the backend-state witness from the sim admin endpoint (GET /state). */
function fetchDbState(): Promise<DbFetch> {
  const url = adminStateUrl();
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (r: DbFetch): void => {
      if (settled) return;
      settled = true;
      resolvePromise(r);
    };
    const empty = (detail: string): DbFetch => ({ snapshot: { bookings: [] }, ok: false, detail });
    try {
      const req = http.get(url, { timeout: DB_FETCH_TIMEOUT_MS }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          data += c;
        });
        res.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(data);
            finish({
              snapshot: normalizeSnapshot(parsed),
              ok: true,
              detail: `backend-state witness fetched from ${url}`,
            });
          } catch {
            finish(empty(`backend-state at ${url} returned unparseable JSON`));
          }
        });
      });
      req.on("timeout", () => {
        req.destroy();
        finish(empty(`backend-state witness timed out at ${url}`));
      });
      req.on("error", (e: Error) => {
        finish(empty(`backend-state witness unavailable at ${url}: ${e.message}`));
      });
    } catch (e) {
      finish(empty(`backend-state request failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

async function toolVerifyBooking(args: Record<string, unknown>): Promise<ToolOutcome> {
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  if (ref === undefined || ref === "") {
    return toolError("verify_booking requires a non-empty string 'ref'");
  }

  const db = await fetchDbState();
  const expectationRaw = args.expectation;

  if (expectationRaw !== undefined && expectationRaw !== null) {
    if (
      typeof expectationRaw !== "object" ||
      typeof (expectationRaw as { kind?: unknown }).kind !== "string"
    ) {
      return toolError("'expectation' must be a TaskExpectation object with a string 'kind'");
    }
    const expectation = expectationRaw as TaskExpectation;
    const endReason = normalizeEndReason(args.endReason);
    const resetAt = typeof args.resetAt === "string" ? args.resetAt : undefined;
    // GRADED: hand the verifier the FULL post-reset mailbox — never a ref
    // pre-filter. The verifier matches the expectation itself; for must_escalate
    // ANY captured mail is a mutation (a ref filter would blind that check), and
    // for a fresh booking the sim-generated ref is unknown to the caller. `ref`
    // is only meaningful on the ungraded lookup path below.
    const gradedEmails = listMail(mailDir());
    const verdict: Verdict = verify({
      expectation,
      endReason,
      emails: gradedEmails,
      db: db.snapshot,
      ...(resetAt !== undefined ? { resetAt } : {}),
    });
    return {
      structuredContent: {
        ref,
        graded: true,
        verdict,
        emailWitness: { count: gradedEmails.length },
        dbWitness: { available: db.ok, rows: db.snapshot.bookings.length, detail: db.detail },
      },
      isError: false,
    };
  }

  // Ungraded: a lookup-by-ref surface — here filtering the mailbox by ref is
  // the intended behavior (surface just this reference's witnesses).
  const emails = queryMail({ ref }, mailDir());
  const row = db.snapshot.bookings.find((r) => r.ref === ref) ?? null;
  return {
    structuredContent: {
      ref,
      graded: false,
      email: emails.map(summariseEmail),
      db: row,
      dbWitness: { available: db.ok, detail: db.detail },
    },
    isError: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
}

async function toolAwaitConfirmation(args: Record<string, unknown>): Promise<ToolOutcome> {
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  if (ref === undefined || ref === "") {
    return toolError("await_confirmation requires a non-empty string 'ref'");
  }
  const raw = typeof args.timeoutMs === "number" ? args.timeoutMs : Number(args.timeoutMs);
  const timeoutMs = Number.isFinite(raw) ? Math.max(0, Math.min(raw, AWAIT_TIMEOUT_CAP_MS)) : 0;

  const started = Date.now();
  const deadline = started + timeoutMs;
  const dir = mailDir();
  let email = findByRef(ref, dir);
  while (email === undefined && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.max(10, Math.min(100, remaining)));
    email = findByRef(ref, dir);
  }
  const waitedMs = Date.now() - started;
  if (email !== undefined) {
    return { structuredContent: { ref, confirmed: true, waitedMs, email }, isError: false };
  }
  return {
    structuredContent: { ref, confirmed: false, timedOut: true, waitedMs },
    isError: false,
  };
}

function toolListCapturedMail(): ToolOutcome {
  const dir = mailDir();
  const emails = listMail(dir);
  return { structuredContent: { count: emails.length, mailDir: dir, emails }, isError: false };
}

function toolRequestApproval(args: Record<string, unknown>): ToolOutcome {
  const actionSummary = typeof args.actionSummary === "string" ? args.actionSummary : undefined;
  if (actionSummary === undefined || actionSummary === "") {
    return toolError("request_approval requires a non-empty string 'actionSummary'");
  }
  const taskId = typeof args.taskId === "string" ? args.taskId : "";
  const id = randomUUID();
  const requestedAt = new Date().toISOString();
  const request: ApprovalRequest = { id, actionSummary, requestedAt, taskId };

  const mode = approvalMode();
  const decidedAt = new Date().toISOString();
  let decision: ApprovalDecision;
  if (mode === "approve" || mode === "auto-log") {
    decision = { id, decision: "approve", decidedBy: `mcp:${mode}`, decidedAt };
  } else {
    decision = {
      id,
      decision: "deny",
      reason:
        "no interactive approver configured; fail-closed default (set MAUDSLAY_APPROVAL_MODE=approve to auto-approve)",
      decidedBy: `mcp:${mode}`,
      decidedAt,
    };
  }
  // The approval trail is auditable on stderr; stdout is reserved for framing.
  process.stderr.write(`${JSON.stringify({ approval: request, decision })}\n`);
  return { structuredContent: { request, decision }, isError: false };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  switch (name) {
    case "verify_booking":
      return toolVerifyBooking(args);
    case "await_confirmation":
      return toolAwaitConfirmation(args);
    case "list_captured_mail":
      return toolListCapturedMail();
    case "request_approval":
      return toolRequestApproval(args);
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatch
// ---------------------------------------------------------------------------

interface RpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function success(id: string | number | null, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: string | number | null, code: number, message: string, data?: unknown): object {
  const err: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}

function buildInitialize(params: unknown): object {
  let protocolVersion = DEFAULT_PROTOCOL_VERSION;
  if (params !== null && typeof params === "object") {
    const pv = (params as { protocolVersion?: unknown }).protocolVersion;
    if (typeof pv === "string" && pv.length > 0) protocolVersion = pv;
  }
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      "Independent ground-truth witnesses for a computer-use booking workflow. Use verify_booking / await_confirmation / list_captured_mail to read the confirmation email and backend-state channels; request_approval gates an irreversible action. These channels are never derived from the screen.",
  };
}

/**
 * Handle a single parsed JSON-RPC message. Returns the response object, or null
 * for notifications (a request without an `id`), which must not be answered.
 */
export async function handleRpc(msg: RpcMessage): Promise<object | null> {
  const isNotification = msg.id === undefined;
  const id: string | number | null = msg.id ?? null;

  if (isNotification) return null;

  if (typeof msg.method !== "string" || msg.method === "") {
    return failure(id, -32600, "invalid request: missing method");
  }
  const method = msg.method;

  try {
    switch (method) {
      case "initialize":
        return success(id, buildInitialize(msg.params));
      case "ping":
        return success(id, {});
      case "tools/list":
        return success(id, { tools: TOOLS });
      case "tools/call": {
        const p = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof p.name === "string" ? p.name : "";
        if (name === "") return failure(id, -32602, "tools/call requires string params.name");
        const args =
          p.arguments !== null && typeof p.arguments === "object"
            ? (p.arguments as Record<string, unknown>)
            : {};
        const outcome = await callTool(name, args);
        return success(id, {
          content: [{ type: "text", text: JSON.stringify(outcome.structuredContent) }],
          structuredContent: outcome.structuredContent,
          isError: outcome.isError,
        });
      }
      default:
        return failure(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    return failure(id, -32603, `internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// stdio transport: dual framing (Content-Length canonical, newline accepted)
// ---------------------------------------------------------------------------

type FrameMode = "content-length" | "line";

function encodeMessage(msg: object, mode: FrameMode): Buffer {
  const json = JSON.stringify(msg);
  if (mode === "line") return Buffer.from(`${json}\n`, "utf8");
  const body = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

function runStdio(): void {
  let inbuf: Buffer = Buffer.alloc(0);

  const onMessage = (raw: string, mode: FrameMode): void => {
    let parsed: RpcMessage;
    try {
      parsed = JSON.parse(raw) as RpcMessage;
    } catch {
      process.stdout.write(encodeMessage(failure(null, -32700, "parse error") as object, mode));
      return;
    }
    void handleRpc(parsed).then((resp) => {
      if (resp !== null) process.stdout.write(encodeMessage(resp, mode));
    });
  };

  const drain = (): void => {
    for (;;) {
      const head = inbuf.subarray(0, 40).toString("utf8");
      if (/^\s*content-length\s*:/i.test(head)) {
        const sep = inbuf.indexOf("\r\n\r\n");
        if (sep < 0) return; // header incomplete
        const headerBlock = inbuf.subarray(0, sep).toString("utf8");
        const m = /content-length\s*:\s*(\d+)/i.exec(headerBlock);
        if (m === null) {
          inbuf = inbuf.subarray(sep + 4); // unusable header; skip it
          continue;
        }
        const len = Number(m[1]);
        const start = sep + 4;
        if (inbuf.length < start + len) return; // body incomplete
        const body = inbuf.subarray(start, start + len).toString("utf8");
        inbuf = inbuf.subarray(start + len);
        onMessage(body, "content-length");
        continue;
      }
      const nl = inbuf.indexOf(0x0a);
      if (nl < 0) return; // line incomplete
      let line = inbuf.subarray(0, nl).toString("utf8");
      inbuf = inbuf.subarray(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      line = line.trim();
      if (line === "") continue; // blank separator
      onMessage(line, "line");
    }
  };

  process.stdin.on("data", (chunk: Buffer) => {
    inbuf = inbuf.length === 0 ? chunk : Buffer.concat([inbuf, chunk]);
    drain();
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
}

// Start the transport only when executed directly; stay a library otherwise.
const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (arg === undefined || arg === "") return false;
  try {
    return resolve(arg) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) runStdio();
