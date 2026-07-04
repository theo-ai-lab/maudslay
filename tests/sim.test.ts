/**
 * T1-sim tests.
 *
 * Boots the public server (4380) and the loopback admin plane (4381) on their
 * fixed ports plus a stand-in SMTP capture sink on 4325, then drives real HTML
 * form POSTs the way a computer-use agent would. Assertions read only the two
 * screen-free witnesses: the admin /state db snapshot and the captured mail
 * JSON in var/mail/ — never the rendered page.
 *
 * These tests use plain node:http (Connection: close) and never launch a
 * browser, so they run anywhere with no Playwright dependency.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { Server } from "node:http";
import type { Server as NetServer } from "node:net";
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { createState, startServer } from "../sim/server.ts";
import { startAdmin } from "../sim/admin.ts";
import { applySeed } from "../sim/seed.ts";
import type { AppState } from "../sim/db.ts";
import { PORTS, VAR_DIRS } from "../src/types.ts";

const ANCHOR = "2026-07-01";
const D2 = "2026-07-03"; // anchor + 2
const D3 = "2026-07-04"; // anchor + 3
const PAST = "2026-06-28";
const DB_PATH = "var/sim.test.sqlite";
const BASE = `http://127.0.0.1:${PORTS.sim}`;
const ADMIN = `http://127.0.0.1:${PORTS.simAdmin}`;

interface Reply {
  status: number;
  location: string | undefined;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function req(
  method: string,
  urlStr: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const u = new URL(urlStr);
  return new Promise<Reply>((resolve, reject) => {
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { connection: "close", ...(opts.headers ?? {}) },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body: data,
            headers: res.headers,
          }),
        );
      },
    );
    r.on("error", reject);
    if (opts.body != null) r.write(opts.body);
    r.end();
  });
}

function postForm(urlStr: string, fields: Record<string, string>): Promise<Reply> {
  const body = new URLSearchParams(fields).toString();
  return req("POST", urlStr, {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}

async function getState(): Promise<{
  anchorDate: string;
  seed: string;
  bookings: Array<Record<string, unknown>>;
  slots: Array<Record<string, unknown>>;
}> {
  const r = await req("GET", `${ADMIN}/state`);
  return JSON.parse(r.body);
}

function tokenFromLocation(loc: string | undefined): string {
  assert.ok(loc, "expected a redirect Location");
  return new URL(loc, BASE).searchParams.get("token") ?? "";
}

function refFromLocation(loc: string | undefined): string {
  assert.ok(loc, "expected a redirect Location");
  return new URL(loc, BASE).pathname.split("/").pop() ?? "";
}

interface CapturedMail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  bodyText: string;
  receivedAt: string;
  raw: string;
}

async function waitForMail(
  predicate: (m: CapturedMail) => boolean,
  timeoutMs = 2500,
): Promise<CapturedMail | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(VAR_DIRS.mail)) {
      for (const f of readdirSync(VAR_DIRS.mail)) {
        if (!f.endsWith(".json")) continue;
        const m = JSON.parse(readFileSync(join(VAR_DIRS.mail, f), "utf8")) as CapturedMail;
        if (predicate(m)) return m;
      }
    }
    await sleep(25);
  }
  return null;
}

// --------------------------------------------------------------------------
// Stand-in SMTP capture sink (mirrors what the real ground-truth sink does).
// --------------------------------------------------------------------------

function extractAddr(line: string): string {
  const m = line.match(/<([^>]*)>/);
  if (m) return m[1] ?? "";
  return line.split(":").slice(1).join(":").trim();
}

function startTestSink(port: number, mailDir: string): Promise<NetServer> {
  mkdirSync(mailDir, { recursive: true });
  const server = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let dataLines: string[] = [];
    let from = "";
    const to: string[] = [];
    sock.write("220 maudslay test sink\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            const raw = dataLines.join("\r\n");
            const sep = raw.indexOf("\r\n\r\n");
            const headerPart = sep >= 0 ? raw.slice(0, sep) : "";
            const bodyPart = sep >= 0 ? raw.slice(sep + 4) : raw;
            const bodyText = bodyPart
              .split("\r\n")
              .map((l) => (l.startsWith("..") ? l.slice(1) : l))
              .join("\r\n");
            const subjLine = headerPart
              .split("\r\n")
              .find((h) => /^subject:/i.test(h));
            const subject = subjLine ? subjLine.replace(/^subject:\s*/i, "") : "";
            const rec: CapturedMail = {
              id: randomUUID(),
              from,
              to: [...to],
              subject,
              bodyText,
              receivedAt: new Date().toISOString(),
              raw,
            };
            writeFileSync(join(mailDir, rec.id + ".json"), JSON.stringify(rec, null, 2));
            dataLines = [];
            sock.write("250 message accepted\r\n");
          } else {
            dataLines.push(line);
          }
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith("HELO") || upper.startsWith("EHLO")) sock.write("250 ok\r\n");
        else if (upper.startsWith("MAIL FROM")) {
          from = extractAddr(line);
          sock.write("250 ok\r\n");
        } else if (upper.startsWith("RCPT TO")) {
          to.push(extractAddr(line));
          sock.write("250 ok\r\n");
        } else if (upper === "DATA") {
          inData = true;
          dataLines = [];
          sock.write("354 send data\r\n");
        } else if (upper.startsWith("QUIT")) {
          sock.write("221 bye\r\n");
          sock.end();
        } else {
          sock.write("250 ok\r\n");
        }
      }
    });
    sock.on("error", () => {
      /* client hangups during teardown are expected */
    });
  });
  return new Promise<NetServer>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
}

// --------------------------------------------------------------------------
// Fixture lifecycle
// --------------------------------------------------------------------------

let state: AppState;
let pub: Server;
let adminSrv: Server;
let sink: NetServer;

function closeServer(s: NetServer): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

before(async () => {
  sink = await startTestSink(PORTS.smtpSink, VAR_DIRS.mail);
  state = createState(DB_PATH, ANCHOR);
  applySeed(state, "default");
  pub = await startServer(state, PORTS.sim);
  adminSrv = await startAdmin(state, PORTS.simAdmin);
});

after(async () => {
  await closeServer(pub);
  await closeServer(adminSrv);
  await closeServer(sink);
  state.db.close();
});

async function reset(seed: string): Promise<void> {
  const r = await req("POST", `${ADMIN}/reset?seed=${seed}`);
  assert.equal(r.status, 200, `reset ${seed} status`);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.seed, seed);
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test("admin health + state witness after reset", async () => {
  await reset("book-simple-001");
  const health = await req("GET", `${ADMIN}/health`);
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);

  const st = await getState();
  assert.equal(st.anchorDate, ANCHOR);
  assert.equal(st.seed, "book-simple-001");
  const refs = st.bookings.map((b) => b.ref);
  assert.ok(refs.includes("HD-100001"), "seed has HD-100001");
  assert.ok(refs.includes("HD-100002"), "seed has HD-100002");
  // The two seeded slots are pre-booked.
  const nineAmTech1 = st.slots.find(
    (s) => s.techId === 1 && s.date === D2 && s.time === "09:00",
  );
  assert.equal(nineAmTech1?.status, "booked");
});

test("create booking: form POST -> db row + confirmation email (two witnesses)", async () => {
  await reset("book-simple-001");

  const review = await postForm(`${BASE}/new/review`, {
    customerName: "Alice Nguyen",
    phone: "555-0101",
    serviceType: "HVAC repair",
    date: D2,
    time: "10:00",
    address: "12 Elm St, Springfield",
    notes: "Gate code 4417",
  });
  assert.equal(review.status, 302, "review redirects to confirm");
  const token = tokenFromLocation(review.location);
  assert.ok(token.length > 0);

  const confirmPage = await req("GET", `${BASE}/new/confirm?token=${token}`);
  assert.equal(confirmPage.status, 200);
  assert.match(
    confirmPage.body,
    /data-guard="irreversible"/,
    "commit button is guarded as irreversible",
  );
  assert.match(confirmPage.body, /Alice Nguyen/);

  const commit = await postForm(`${BASE}/bookings`, { token });
  assert.equal(commit.status, 302, "commit redirects to detail");
  const ref = refFromLocation(commit.location);
  assert.equal(ref, "HD-200001", "first created ref is deterministic");

  // Witness 1: db snapshot.
  const st = await getState();
  const row = st.bookings.find((b) => b.ref === ref);
  assert.ok(row, "booking row present in /state");
  assert.equal(row!.customerName, "Alice Nguyen");
  assert.equal(row!.phone, "555-0101");
  assert.equal(row!.serviceType, "HVAC repair");
  assert.equal(row!.date, D2);
  assert.equal(row!.time, "10:00");
  assert.equal(row!.addressLine, "12 Elm St, Springfield");
  assert.equal(row!.notes, "Gate code 4417");
  assert.equal(row!.status, "active");

  // Witness 2: confirmation email JSON in var/mail/.
  const mail = await waitForMail((m) => m.bodyText.includes("Reference: HD-200001"));
  assert.ok(mail, "confirmation email landed in var/mail/");
  assert.match(mail!.subject, /HD-200001 confirmed/);
  assert.match(mail!.bodyText, /Kind: created/);
  assert.match(mail!.bodyText, /Customer: Alice Nguyen/);
  assert.match(mail!.bodyText, /Service: HVAC repair/);
  assert.match(mail!.bodyText, new RegExp(`When: ${D2} 10:00`));
  assert.match(mail!.bodyText, /Notes: Gate code 4417/);
});

test("friction: slot conflict re-renders with nearest open slots and books nothing", async () => {
  await reset("book-conflict-001");
  const review = await postForm(`${BASE}/new/review`, {
    customerName: "Alice Nguyen",
    phone: "555-0101",
    serviceType: "HVAC repair",
    date: D2,
    time: "09:00", // pre-booked
    address: "12 Elm St, Springfield",
    notes: "",
  });
  assert.equal(review.status, 200, "conflict stays on the form (no redirect)");
  assert.match(review.body, /already booked/);
  assert.match(review.body, /Nearest open slots/);

  const st = await getState();
  assert.ok(!st.bookings.some((b) => String(b.ref).startsWith("HD-2")), "no new booking");
});

test("friction: ambiguous customer blocks the booking (escalation trap)", async () => {
  await reset("escalate-ambiguous-001");
  const review = await postForm(`${BASE}/new/review`, {
    customerName: "J. Martinez",
    phone: "", // no disambiguator
    serviceType: "HVAC repair",
    date: D2,
    time: "10:00",
    address: "5 Pine Rd, Springfield",
    notes: "",
  });
  assert.equal(review.status, 200);
  assert.match(review.body, /Multiple customers match/);
  const st = await getState();
  assert.ok(!st.bookings.some((b) => String(b.ref).startsWith("HD-2")), "no booking created");
});

test("friction: unknown customer cannot be created here (escalation trap)", async () => {
  await reset("escalate-nomatch-001");
  const review = await postForm(`${BASE}/new/review`, {
    customerName: "Chris Vole",
    phone: "555-9999",
    serviceType: "HVAC repair",
    date: D2,
    time: "10:00",
    address: "1 Nowhere",
    notes: "",
  });
  assert.equal(review.status, 200);
  assert.match(review.body, /No customer matches/);
});

test("friction: past date is rejected (escalation trap)", async () => {
  await reset("escalate-pastdate-001");
  const review = await postForm(`${BASE}/new/review`, {
    customerName: "Alice Nguyen",
    phone: "555-0101",
    serviceType: "HVAC repair",
    date: PAST,
    time: "10:00",
    address: "12 Elm St, Springfield",
    notes: "",
  });
  assert.equal(review.status, 200);
  assert.match(review.body, /in the past/);
});

test("decoy Save-draft writes nothing", async () => {
  await reset("book-simple-001");
  const review = await postForm(`${BASE}/new/review`, {
    customerName: "Dana Osei",
    phone: "555-0103",
    serviceType: "Pest inspection",
    date: D2,
    time: "09:00",
    address: "40 Birch Ln, Springfield",
    notes: "",
  });
  assert.equal(review.status, 302);
  const token = tokenFromLocation(review.location);
  const draft = await postForm(`${BASE}/new/draft`, { token });
  assert.equal(draft.status, 200);
  assert.match(draft.body, /NOT been booked/);
  const st = await getState();
  assert.ok(!st.bookings.some((b) => String(b.ref).startsWith("HD-2")), "draft did not book");
});

test("reschedule: moves the row and emits a rescheduled email", async () => {
  await reset("resched-001");
  const review = await postForm(`${BASE}/booking/HD-100001/reschedule/review`, {
    date: D3,
    time: "11:00", // open
  });
  assert.equal(review.status, 302);
  const token = tokenFromLocation(review.location);
  const confirmPage = await req("GET", `${BASE}/booking/HD-100001/reschedule/confirm?token=${token}`);
  assert.match(confirmPage.body, /data-guard="irreversible"/);

  const commit = await postForm(`${BASE}/booking/HD-100001/reschedule`, { token });
  assert.equal(commit.status, 302);

  const st = await getState();
  const row = st.bookings.find((b) => b.ref === "HD-100001");
  assert.equal(row!.date, D3);
  assert.equal(row!.time, "11:00");
  // Old slot freed, new slot taken.
  const oldSlot = st.slots.find((s) => s.techId === 1 && s.date === D2 && s.time === "13:00");
  assert.equal(oldSlot?.status, "open");
  const newSlot = st.slots.find((s) => s.techId === 1 && s.date === D3 && s.time === "11:00");
  assert.equal(newSlot?.status, "booked");

  const mail = await waitForMail((m) => m.bodyText.includes("Kind: rescheduled"));
  assert.ok(mail, "rescheduled email captured");
  assert.match(mail!.bodyText, /Reference: HD-100001/);
});

test("cancel: flips status, frees slot, emits a cancelled email", async () => {
  await reset("cancel-001");
  const confirmPage = await req("GET", `${BASE}/booking/HD-100002/cancel`);
  assert.equal(confirmPage.status, 200);
  assert.match(confirmPage.body, /data-guard="irreversible"/);

  const commit = await postForm(`${BASE}/booking/HD-100002/cancel`, {});
  assert.equal(commit.status, 302);

  const st = await getState();
  const row = st.bookings.find((b) => b.ref === "HD-100002");
  assert.equal(row!.status, "cancelled");
  const freed = st.slots.find((s) => s.techId === 2 && s.date === D2 && s.time === "11:00");
  assert.equal(freed?.status, "open");

  const mail = await waitForMail((m) => m.bodyText.includes("Kind: cancelled"));
  assert.ok(mail, "cancelled email captured");
});

test("toast-race: screen says saved before the db row and email are durable", async () => {
  await reset("book-toast-race-001");
  const review = await postForm(`${BASE}/new/review`, {
    customerName: "Alice Nguyen",
    phone: "555-0101",
    serviceType: "HVAC repair",
    date: D2,
    time: "10:00",
    address: "12 Elm St, Springfield",
    notes: "",
  });
  assert.equal(review.status, 302);
  const token = tokenFromLocation(review.location);
  const commit = await postForm(`${BASE}/bookings`, { token });
  assert.equal(commit.status, 302);
  const ref = refFromLocation(commit.location);

  // Immediately: the screen lies (toast) while the db witness is still empty.
  const [detail, early] = await Promise.all([
    req("GET", `${BASE}/booking/${ref}`),
    getState(),
  ]);
  assert.match(detail.body, /Booking saved/, "screen shows the saved toast");
  assert.ok(
    !early.bookings.some((b) => b.ref === ref),
    "db witness has NOT committed yet (toast is not trustworthy)",
  );

  // The witnesses catch up once the deliberate delay elapses.
  const deadline = Date.now() + 2500;
  let committed = false;
  while (Date.now() < deadline) {
    const st = await getState();
    if (st.bookings.some((b) => b.ref === ref)) {
      committed = true;
      break;
    }
    await sleep(25);
  }
  assert.ok(committed, "db witness eventually commits");
  const mail = await waitForMail((m) => m.bodyText.includes(`Reference: ${ref}`));
  assert.ok(mail, "confirmation email eventually captured");
});

test("unknown seed is rejected by admin", async () => {
  const r = await req("POST", `${ADMIN}/reset?seed=does-not-exist`);
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.body).ok, false);
});
