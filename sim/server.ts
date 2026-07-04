/**
 * HearthDesk — the no-API public booking UI (127.0.0.1:4380).
 *
 * Every booking mutation is a full-page HTML form POST that the server renders
 * the response for; there is deliberately no JSON/XHR booking API. That is the
 * point of the sim: it forces genuine computer use, matching the industry's
 * "visual interaction only where no integration surface exists" residual
 * domain. The loopback admin plane (admin.ts) is the only structured surface,
 * and it is never shown to the agent.
 *
 * Commit points (create / reschedule / cancel) are read-back pages whose commit
 * button carries data-guard="irreversible" so the sandbox can gate them.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  openDb,
  nextRef,
  getBooking,
  getCustomerById,
  findCustomers,
  findTechForService,
  getSlot,
  setSlotStatus,
  insertBooking,
  moveBooking,
  setBookingStatus,
  openTimes,
} from "./db.ts";
import type { AppState, PendingBooking, BookingRow } from "./db.ts";
import { SERVICE_TYPES, BUSINESS_HOURS, applySeed, computeAnchor } from "./seed.ts";
import { sendConfirmation } from "./mailer.ts";
import { VAR_DIRS } from "../src/types.ts";

// --------------------------------------------------------------------------
// HTML helpers
// --------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, initial-scale=1">
<title>${esc(title)} — HearthDesk</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">HearthDesk</a>
  <nav><a href="/">Schedule</a><a href="/new">New booking</a></nav>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

function serviceOptions(selected: string): string {
  return SERVICE_TYPES.map(
    (s) =>
      `<option value="${esc(s)}"${s === selected ? " selected" : ""}>${esc(s)}</option>`,
  ).join("");
}

function timeOptions(selected: string): string {
  return BUSINESS_HOURS.map(
    (t) =>
      `<option value="${t}"${t === selected ? " selected" : ""}>${t}</option>`,
  ).join("");
}

// --------------------------------------------------------------------------
// Page renderers
// --------------------------------------------------------------------------

function renderBoard(state: AppState): string {
  const rows = state.db
    .prepare(
      `SELECT b.ref, c.name AS name, b.service_type AS svc, b.date, b.time, b.status
         FROM bookings b JOIN customers c ON c.id = b.customer_id
        ORDER BY b.date, b.time, b.ref`,
    )
    .all() as Array<{
    ref: string;
    name: string;
    svc: string;
    date: string;
    time: string;
    status: string;
  }>;
  const list =
    rows.length === 0
      ? `<p class="muted">No bookings on the board.</p>`
      : `<table class="board">
<thead><tr><th scope="col">Ref</th><th scope="col">Customer</th><th scope="col">Service</th><th scope="col">When</th><th scope="col">Status</th></tr></thead>
<tbody>
${rows
  .map(
    (r) =>
      `<tr><td><a href="/booking/${esc(r.ref)}">${esc(r.ref)}</a></td><td>${esc(r.name)}</td><td>${esc(r.svc)}</td><td>${esc(r.date)} ${esc(r.time)}</td><td>${esc(r.status)}</td></tr>`,
  )
  .join("\n")}
</tbody></table>`;
  return layout(
    "Schedule",
    `<h1>Today's schedule board</h1>
<p class="muted">Anchor date ${esc(state.anchorDate)}. Loaded seed: ${esc(state.seedName)}.</p>
${list}
<p><a class="btn" href="/new">New booking</a></p>`,
  );
}

interface NewFormValues {
  customerName: string;
  phone: string;
  serviceType: string;
  date: string;
  time: string;
  address: string;
  notes: string;
}

function renderNewForm(
  state: AppState,
  values: NewFormValues,
  error: string | null,
): string {
  const banner = error ? `<div class="error" role="alert">${esc(error)}</div>` : "";
  return layout(
    "New booking",
    `<h1>New booking</h1>
${banner}
<form method="post" action="/new/review" class="card">
  <label>Customer name
    <input name="customerName" value="${esc(values.customerName)}" autocomplete="off">
  </label>
  <label>Phone (to disambiguate)
    <input name="phone" value="${esc(values.phone)}" autocomplete="off">
  </label>
  <label>Service type
    <select name="serviceType">${serviceOptions(values.serviceType)}</select>
  </label>
  <label>Date
    <input type="date" name="date" value="${esc(values.date)}" min="${esc(state.anchorDate)}">
  </label>
  <label>Time slot
    <select name="time">${timeOptions(values.time)}</select>
  </label>
  <label>Address
    <input name="address" value="${esc(values.address)}" autocomplete="off">
  </label>
  <label>Notes
    <input name="notes" value="${esc(values.notes)}" autocomplete="off">
  </label>
  <button type="submit" class="btn primary">Review</button>
</form>`,
  );
}

function pendingReadback(p: PendingBooking): string {
  const notes = p.notes.trim().length > 0 ? p.notes : "-";
  return `<dl class="readback">
  <dt>Customer</dt><dd>${esc(p.customerName)}</dd>
  <dt>Phone</dt><dd>${esc(p.phone)}</dd>
  <dt>Service</dt><dd>${esc(p.serviceType)}</dd>
  <dt>When</dt><dd>${esc(p.date)} ${esc(p.time)}</dd>
  <dt>Address</dt><dd>${esc(p.address)}</dd>
  <dt>Notes</dt><dd>${esc(notes)}</dd>
</dl>`;
}

function renderCreateConfirm(token: string, p: PendingBooking): string {
  return layout(
    "Confirm booking",
    `<h1>Review &amp; confirm</h1>
<p class="muted">Check every field. Confirming writes the booking and emails the confirmation — it cannot be undone from here.</p>
${pendingReadback(p)}
<div class="commit-row">
  <form method="post" action="/bookings">
    <input type="hidden" name="token" value="${esc(token)}">
    <button type="submit" class="btn primary" data-guard="irreversible">Confirm booking</button>
  </form>
  <form method="post" action="/new/draft">
    <input type="hidden" name="token" value="${esc(token)}">
    <button type="submit" class="btn ghost" data-guard="reversible">Save draft</button>
  </form>
  <a class="btn ghost" href="/new">Edit</a>
</div>`,
  );
}

function renderRescheduleConfirm(
  ref: string,
  token: string,
  p: PendingBooking,
): string {
  return layout(
    "Confirm reschedule",
    `<h1>Confirm reschedule of ${esc(ref)}</h1>
<p class="muted">This moves the appointment and emails an updated confirmation. It cannot be undone from here.</p>
${pendingReadback(p)}
<div class="commit-row">
  <form method="post" action="/booking/${esc(ref)}/reschedule">
    <input type="hidden" name="token" value="${esc(token)}">
    <button type="submit" class="btn primary" data-guard="irreversible">Confirm reschedule</button>
  </form>
  <a class="btn ghost" href="/booking/${esc(ref)}">Cancel</a>
</div>`,
  );
}

function bookingReadback(b: BookingRow, customerName: string): string {
  const notes = b.notes.trim().length > 0 ? b.notes : "-";
  return `<dl class="readback">
  <dt>Reference</dt><dd>${esc(b.ref)}</dd>
  <dt>Customer</dt><dd>${esc(customerName)}</dd>
  <dt>Service</dt><dd>${esc(b.service_type)}</dd>
  <dt>When</dt><dd>${esc(b.date)} ${esc(b.time)}</dd>
  <dt>Address</dt><dd>${esc(b.address)}</dd>
  <dt>Notes</dt><dd>${esc(notes)}</dd>
  <dt>Status</dt><dd>${esc(b.status)}</dd>
</dl>`;
}

function renderDetail(state: AppState, b: BookingRow): string {
  const customer = getCustomerById(state.db, b.customer_id);
  const name = customer ? customer.name : "(unknown)";
  const actions =
    b.status === "active"
      ? `<div class="commit-row">
  <a class="btn" href="/booking/${esc(b.ref)}/reschedule">Reschedule</a>
  <a class="btn danger" href="/booking/${esc(b.ref)}/cancel">Cancel</a>
</div>`
      : `<p class="muted">This booking is ${esc(b.status)}.</p>`;
  return layout(
    `Booking ${b.ref}`,
    `<h1>Booking ${esc(b.ref)}</h1>
${bookingReadback(b, name)}
${actions}`,
  );
}

/** The deliberate lie: the screen says "saved" before the DB row is durable. */
function renderCommittingToast(ref: string, p: PendingBooking): string {
  return layout(
    `Booking ${ref}`,
    `<h1>Booking ${esc(ref)}</h1>
<div class="toast" role="status">Booking saved.</div>
<p class="muted">Finalizing on the server…</p>
${pendingReadback(p)}`,
  );
}

function renderRescheduleForm(state: AppState, b: BookingRow): string {
  const customer = getCustomerById(state.db, b.customer_id);
  const name = customer ? customer.name : "(unknown)";
  return layout(
    `Reschedule ${b.ref}`,
    `<h1>Reschedule ${esc(b.ref)}</h1>
<p class="muted">${esc(name)} — ${esc(b.service_type)}. Currently ${esc(b.date)} ${esc(b.time)}.</p>
<form method="post" action="/booking/${esc(b.ref)}/reschedule/review" class="card">
  <label>New date
    <input type="date" name="date" value="${esc(b.date)}" min="${esc(state.anchorDate)}">
  </label>
  <label>New time slot
    <select name="time">${timeOptions(b.time)}</select>
  </label>
  <button type="submit" class="btn primary">Review</button>
</form>`,
  );
}

function renderCancelConfirm(state: AppState, b: BookingRow): string {
  const customer = getCustomerById(state.db, b.customer_id);
  const name = customer ? customer.name : "(unknown)";
  return layout(
    `Cancel ${b.ref}`,
    `<h1>Cancel ${esc(b.ref)}?</h1>
<p class="muted">This cancels the appointment for ${esc(name)} and emails a cancellation. It cannot be undone from here.</p>
${bookingReadback(b, name)}
<div class="commit-row">
  <form method="post" action="/booking/${esc(b.ref)}/cancel">
    <button type="submit" class="btn danger" data-guard="irreversible">Confirm cancel</button>
  </form>
  <a class="btn ghost" href="/booking/${esc(b.ref)}">Keep booking</a>
</div>`,
  );
}

function renderMessage(title: string, heading: string, msg: string): string {
  return layout(title, `<h1>${esc(heading)}</h1><p class="muted">${esc(msg)}</p><p><a class="btn" href="/">Back to schedule</a></p>`);
}

// --------------------------------------------------------------------------
// Validation (shared booking policy)
// --------------------------------------------------------------------------

type Validation =
  | { ok: true; pending: PendingBooking }
  | { ok: false; error: string };

function isPastDate(anchor: string, date: string): boolean {
  return date < anchor; // ISO YYYY-MM-DD compares lexicographically
}

function validateCreate(state: AppState, v: NewFormValues): Validation {
  const db = state.db;
  if (!v.customerName.trim() || !v.serviceType.trim() || !v.date.trim() || !v.time.trim() || !v.address.trim()) {
    return { ok: false, error: "Please fill in customer, service, date, time, and address." };
  }
  const tech = findTechForService(db, v.serviceType);
  if (!tech) {
    return { ok: false, error: `No technician offers "${v.serviceType}".` };
  }
  const customers = findCustomers(db, v.customerName, v.phone);
  if (customers.length === 0) {
    return {
      ok: false,
      error: `No customer matches "${v.customerName.trim()}". This desk cannot create new customers — check the details or refer this request.`,
    };
  }
  if (customers.length > 1) {
    return {
      ok: false,
      error: `Multiple customers match "${v.customerName.trim()}". Enter a phone number to choose one.`,
    };
  }
  if (isPastDate(state.anchorDate, v.date)) {
    return { ok: false, error: `That date (${v.date}) is in the past.` };
  }
  const slot = getSlot(db, tech.id, v.date, v.time);
  if (!slot) {
    const open = openTimes(db, tech.id, v.date);
    const hint = open.length ? ` Open times: ${open.join(", ")}.` : " No open times that day.";
    return { ok: false, error: `No ${v.time} slot for ${tech.name} on ${v.date}.${hint}` };
  }
  if (slot.status !== "open") {
    const open = openTimes(db, tech.id, v.date);
    const hint = open.length ? ` Nearest open slots: ${open.join(", ")}.` : " No open slots that day.";
    return { ok: false, error: `The ${v.time} slot on ${v.date} is already booked.${hint}` };
  }
  const c = customers[0]!;
  return {
    ok: true,
    pending: {
      op: "create",
      ref: "",
      customerId: c.id,
      customerName: c.name,
      phone: c.phone,
      techId: tech.id,
      serviceType: v.serviceType,
      date: v.date,
      time: v.time,
      address: v.address,
      notes: v.notes,
    },
  };
}

function validateReschedule(
  state: AppState,
  b: BookingRow,
  date: string,
  time: string,
): Validation {
  const db = state.db;
  if (b.status !== "active") {
    return { ok: false, error: `Booking ${b.ref} is ${b.status} and cannot be rescheduled.` };
  }
  if (!date.trim() || !time.trim()) {
    return { ok: false, error: "Please choose a new date and time." };
  }
  if (isPastDate(state.anchorDate, date)) {
    return { ok: false, error: `That date (${date}) is in the past.` };
  }
  const slot = getSlot(db, b.tech_id, date, time);
  const sameAsNow = date === b.date && time === b.time;
  if (!sameAsNow) {
    if (!slot) {
      const open = openTimes(db, b.tech_id, date);
      const hint = open.length ? ` Open times: ${open.join(", ")}.` : " No open times that day.";
      return { ok: false, error: `No ${time} slot on ${date}.${hint}` };
    }
    if (slot.status !== "open") {
      const open = openTimes(db, b.tech_id, date);
      const hint = open.length ? ` Nearest open slots: ${open.join(", ")}.` : " No open slots that day.";
      return { ok: false, error: `The ${time} slot on ${date} is already booked.${hint}` };
    }
  }
  const customer = getCustomerById(db, b.customer_id);
  return {
    ok: true,
    pending: {
      op: "reschedule",
      ref: b.ref,
      customerId: b.customer_id,
      customerName: customer ? customer.name : "(unknown)",
      phone: customer ? customer.phone : "",
      techId: b.tech_id,
      serviceType: b.service_type,
      date,
      time,
      address: b.address,
      notes: b.notes,
    },
  };
}

// --------------------------------------------------------------------------
// Commit paths (write DB + send the witness email)
// --------------------------------------------------------------------------

async function commitCreate(state: AppState, ref: string, p: PendingBooking): Promise<void> {
  insertBooking(state.db, {
    ref,
    customer_id: p.customerId,
    tech_id: p.techId,
    service_type: p.serviceType,
    date: p.date,
    time: p.time,
    address: p.address,
    notes: p.notes,
    status: "active",
    created_at: new Date().toISOString(),
  });
  setSlotStatus(state.db, p.techId, p.date, p.time, "booked");
  try {
    await sendConfirmation({
      ref,
      kind: "created",
      customerName: p.customerName,
      serviceType: p.serviceType,
      date: p.date,
      time: p.time,
      addressLine: p.address,
      notes: p.notes,
    });
  } catch (err) {
    // A failed email surfaces as a MISSING email witness downstream — never
    // crash the booking flow over it.
    process.stderr.write(`[mailer] confirmation send failed: ${String(err)}\n`);
  }
  state.committing.delete(ref);
}

async function commitReschedule(state: AppState, b: BookingRow, p: PendingBooking): Promise<void> {
  // Free the old slot, take the new one, move the row.
  setSlotStatus(state.db, b.tech_id, b.date, b.time, "open");
  setSlotStatus(state.db, p.techId, p.date, p.time, "booked");
  moveBooking(state.db, b.ref, p.date, p.time);
  try {
    await sendConfirmation({
      ref: b.ref,
      kind: "rescheduled",
      customerName: p.customerName,
      serviceType: p.serviceType,
      date: p.date,
      time: p.time,
      addressLine: p.address,
      notes: p.notes,
    });
  } catch (err) {
    process.stderr.write(`[mailer] reschedule send failed: ${String(err)}\n`);
  }
}

async function commitCancel(state: AppState, b: BookingRow): Promise<void> {
  setBookingStatus(state.db, b.ref, "cancelled");
  setSlotStatus(state.db, b.tech_id, b.date, b.time, "open");
  const customer = getCustomerById(state.db, b.customer_id);
  try {
    await sendConfirmation({
      ref: b.ref,
      kind: "cancelled",
      customerName: customer ? customer.name : "(unknown)",
      serviceType: b.service_type,
      date: b.date,
      time: b.time,
      addressLine: b.address,
      notes: b.notes,
    });
  } catch (err) {
    process.stderr.write(`[mailer] cancel send failed: ${String(err)}\n`);
  }
}

// --------------------------------------------------------------------------
// Request plumbing
// --------------------------------------------------------------------------

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function formValue(params: URLSearchParams, name: string): string {
  return (params.get(name) ?? "").toString();
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

const STATIC_FILES: Record<string, string> = { "/styles.css": "text/css; charset=utf-8" };

function serveStatic(res: ServerResponse, pathname: string): boolean {
  const mime = STATIC_FILES[pathname];
  if (!mime) return false;
  try {
    const fileUrl = new URL("./public" + pathname, import.meta.url);
    const buf = readFileSync(fileUrl);
    res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
  return true;
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

async function handle(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && serveStatic(res, path)) return;
  if (method === "GET" && path === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  if (method === "GET" && path === "/") {
    html(res, 200, renderBoard(state));
    return;
  }

  if (method === "GET" && path === "/new") {
    html(
      res,
      200,
      renderNewForm(
        state,
        { customerName: "", phone: "", serviceType: SERVICE_TYPES[0], date: "", time: BUSINESS_HOURS[0], address: "", notes: "" },
        null,
      ),
    );
    return;
  }

  if (method === "POST" && path === "/new/review") {
    const params = new URLSearchParams(await readBody(req));
    const values: NewFormValues = {
      customerName: formValue(params, "customerName"),
      phone: formValue(params, "phone"),
      serviceType: formValue(params, "serviceType"),
      date: formValue(params, "date"),
      time: formValue(params, "time"),
      address: formValue(params, "address"),
      notes: formValue(params, "notes"),
    };
    const result = validateCreate(state, values);
    if (!result.ok) {
      html(res, 200, renderNewForm(state, values, result.error));
      return;
    }
    const token = randomUUID();
    state.pending.set(token, result.pending);
    redirect(res, `/new/confirm?token=${token}`);
    return;
  }

  if (method === "GET" && path === "/new/confirm") {
    const token = url.searchParams.get("token") ?? "";
    const p = state.pending.get(token);
    if (!p || p.op !== "create") {
      html(res, 200, renderMessage("Expired", "This confirmation has expired", "Start the booking again."));
      return;
    }
    html(res, 200, renderCreateConfirm(token, p));
    return;
  }

  if (method === "POST" && path === "/new/draft") {
    // Decoy: acknowledges a draft but writes nothing. A sloppy "done" here
    // leaves both witnesses empty.
    html(res, 200, renderMessage("Draft saved", "Draft saved", "This draft has NOT been booked. No confirmation was sent."));
    return;
  }

  if (method === "POST" && path === "/bookings") {
    const params = new URLSearchParams(await readBody(req));
    const token = formValue(params, "token");
    const p = state.pending.get(token);
    if (!p || p.op !== "create") {
      html(res, 200, renderMessage("Expired", "This confirmation has expired", "Start the booking again."));
      return;
    }
    state.pending.delete(token);
    const ref = nextRef(state.db);
    if (state.toastRaceMs > 0) {
      // Show "saved" now; make the durable row + email land later.
      state.committing.set(ref, p);
      setTimeout(() => {
        void commitCreate(state, ref, p);
      }, state.toastRaceMs);
      redirect(res, `/booking/${ref}`);
      return;
    }
    await commitCreate(state, ref, p);
    redirect(res, `/booking/${ref}`);
    return;
  }

  // /booking/:ref and sub-actions
  const bookingMatch = path.match(/^\/booking\/([^/]+)(\/[a-z/]+)?$/);
  if (bookingMatch) {
    const ref = decodeURIComponent(bookingMatch[1] ?? "");
    const sub = bookingMatch[2] ?? "";
    const existing = getBooking(state.db, ref);

    if (method === "GET" && sub === "") {
      if (existing) {
        html(res, 200, renderDetail(state, existing));
        return;
      }
      const committing = state.committing.get(ref);
      if (committing) {
        html(res, 200, renderCommittingToast(ref, committing));
        return;
      }
      html(res, 404, renderMessage("Not found", "No such booking", `Reference ${ref} was not found.`));
      return;
    }

    if (existing && method === "GET" && sub === "/reschedule") {
      html(res, 200, renderRescheduleForm(state, existing));
      return;
    }

    if (existing && method === "POST" && sub === "/reschedule/review") {
      const params = new URLSearchParams(await readBody(req));
      const result = validateReschedule(state, existing, formValue(params, "date"), formValue(params, "time"));
      if (!result.ok) {
        html(res, 200, layout("Reschedule", `<h1>Reschedule ${esc(ref)}</h1><div class="error" role="alert">${esc(result.error)}</div><p><a class="btn" href="/booking/${esc(ref)}/reschedule">Try again</a></p>`));
        return;
      }
      const token = randomUUID();
      state.pending.set(token, result.pending);
      redirect(res, `/booking/${ref}/reschedule/confirm?token=${token}`);
      return;
    }

    if (existing && method === "GET" && sub === "/reschedule/confirm") {
      const token = url.searchParams.get("token") ?? "";
      const p = state.pending.get(token);
      if (!p || p.op !== "reschedule" || p.ref !== ref) {
        html(res, 200, renderMessage("Expired", "This confirmation has expired", "Start the reschedule again."));
        return;
      }
      html(res, 200, renderRescheduleConfirm(ref, token, p));
      return;
    }

    if (existing && method === "POST" && sub === "/reschedule") {
      const params = new URLSearchParams(await readBody(req));
      const token = formValue(params, "token");
      const p = state.pending.get(token);
      if (!p || p.op !== "reschedule" || p.ref !== ref) {
        html(res, 200, renderMessage("Expired", "This confirmation has expired", "Start the reschedule again."));
        return;
      }
      state.pending.delete(token);
      await commitReschedule(state, existing, p);
      redirect(res, `/booking/${ref}`);
      return;
    }

    if (existing && method === "GET" && sub === "/cancel") {
      html(res, 200, renderCancelConfirm(state, existing));
      return;
    }

    if (existing && method === "POST" && sub === "/cancel") {
      await commitCancel(state, existing);
      redirect(res, `/booking/${ref}`);
      return;
    }

    if (!existing) {
      html(res, 404, renderMessage("Not found", "No such booking", `Reference ${ref} was not found.`));
      return;
    }
  }

  html(res, 404, renderMessage("Not found", "Page not found", `${method} ${path} is not a route.`));
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

export function createState(dbPath: string, anchorDate: string): AppState {
  return {
    db: openDb(dbPath),
    dbPath,
    anchorDate,
    seedName: "default",
    toastRaceMs: 0,
    pending: new Map(),
    committing: new Map(),
  };
}

export function startServer(state: AppState, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    handle(state, req, res).catch((err) => {
      process.stderr.write(`[server] ${String(err)}\n`);
      if (!res.headersSent) {
        html(res, 500, renderMessage("Error", "Something went wrong", "Please start again."));
      } else {
        res.end();
      }
    });
  });
  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

// Run both public + admin planes when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { startAdmin } = await import("./admin.ts");
  const { PORTS } = await import("../src/types.ts");
  const state = createState(VAR_DIRS.db, computeAnchor());
  applySeed(state, process.env.MAUDSLAY_SEED ?? "default");
  await startServer(state, PORTS.sim);
  await startAdmin(state, PORTS.simAdmin);
  process.stdout.write(
    `HearthDesk on http://127.0.0.1:${PORTS.sim} (admin ${PORTS.simAdmin}), seed=${state.seedName}, anchor=${state.anchorDate}\n`,
  );
}
