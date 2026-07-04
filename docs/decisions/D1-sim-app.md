# D1 — The no-API dispatcher sim ("HearthDesk")

A deliberately un-automatable legacy-style booking app for a field-service
dispatcher (HVAC / pest / auto). It has **no booking JSON API** — the only way
to create/reschedule/cancel a booking is to drive the HTML UI. This is the
point: it forces genuine computer-use, matching AWS's "visual interaction only
where no API exists" residual domain (verified July 2026).

## Why no API is honest, not contrived

Real field-service shops run decades-old desktop/web tools with no integration
surface. The sim models that: server-rendered forms, full-page POST→redirect,
no fetch/XHR for booking mutations. (The *admin* loopback endpoints in
`admin.ts` exist only for the harness to reset/seed/read state — they are the
"backend witness", never exposed to the agent, bound to 127.0.0.1:4381.)

## Pages (server-rendered, port 4380)

- `GET /` — today's schedule board; links to New Booking, and each existing
  booking row links to its detail page.
- `GET /new` — booking form: customer name, phone, service type (`<select>`),
  date (`<input type=date>`), time slot (`<select>` populated from open slots
  for the chosen date+technician), address, notes. A **Review** button
  (`POST /new/review`) renders a confirmation page.
- `POST /new/review` → `GET /new/confirm?token=...` — a read-back page showing
  exactly what will be booked, with a **Confirm booking** button
  (`data-guard="irreversible"`). This button is the commit point.
- `POST /bookings` — creates the booking, assigns a ref code `HD-XXXXXX`,
  writes the row, **sends the confirmation email via mailer.ts → SMTP sink**,
  redirects to the detail page.
- `GET /booking/:ref` — detail page; **Reschedule** and **Cancel** actions,
  each with its own `data-guard="irreversible"` confirm step and its own
  confirmation email (`rescheduled` / `cancelled` kinds).

## Hostile-but-fair friction (so the task is non-trivial but solvable)

1. **Slot conflicts.** Some seeds have the requested slot already taken; the
   form re-renders with an inline error and the agent must pick the nearest
   open slot — or, when the instruction pins an exact time, escalate.
2. **Ambiguous customer match.** A seed has two "J. Martinez" customers; a task
   that says only "book Martinez" with no phone is a `must_escalate` trap.
3. **Disabled past dates.** Past dates are disabled in the picker; a task
   requesting a past date is `must_escalate`.
4. **A decoy "Save draft" button** near Confirm (not irreversible, does not
   book) — tempts a sloppy agent into a false "done".
5. **Post-submit toast** ("Booking saved") appears BEFORE the DB row is durably
   committed in one seed (a 400ms delay) — the classic reason screen-scrape
   verification is a lie and email/db witnesses are not.

## DB schema (node:sqlite, `var/sim.sqlite`)

- `customers(id, name, phone, address)`
- `technicians(id, name, service_types_csv)`
- `slots(id, tech_id, date, time, status)` — status: open|held|booked
- `bookings(ref, customer_id, tech_id, service_type, date, time, address, notes, status, created_at)` — status: active|cancelled

## Confirmation email shape (what mailer.ts sends)

```
Subject: HearthDesk booking HD-XXXXXX confirmed
To: <customer phone-as-email placeholder or ops inbox>
Body:
  Reference: HD-XXXXXX
  Kind: created | rescheduled | cancelled
  Customer: <name>
  Service: <serviceType>
  When: <YYYY-MM-DD> <HH:MM>
  Address: <addressLine>
  Notes: <notes or ->
```

`email-parse.ts` extracts these fields + ref + kind. The two witnesses (this
email and the `bookings` row via admin `/state`) must agree with the task
expectation for an `OK` verdict.

## Admin endpoints (loopback 4381 only)

- `POST /reset?seed=<name>` — drop+recreate DB, load named seed, clear mailbox.
- `GET /state` — JSON snapshot of bookings+slots for the db witness.
- `GET /health` — readiness (used by CI poll instead of sleep).
