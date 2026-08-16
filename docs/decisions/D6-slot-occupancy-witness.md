# D6 — The backend witness carries slot occupancy (2026-08)

## What was found

The sim's loopback admin `GET /state` has always emitted the full slot table
alongside the booking table (`stateSnapshot` in `sim/db.ts`). The witness the
verifier is given did not: `DbStateSnapshot` was verbatim
`{ bookings: DbBookingRow[] }`, and `normalizeSnapshot` read the payload's
`bookings` array and dropped everything else. Slot occupancy was fetched over
the wire and thrown away on arrival, so nothing downstream — not the verdict,
not the persisted trajectory, not `npm run audit` — could see it.

**No defect followed from that, and this decision does not claim one.** The
harm you would look for — a booking row whose slot is not reserved, i.e. the
precondition for double-booking — could not be produced through the surface the
agent under test actually has:

- `commitCreate` writes the booking row and flips the slot to `booked` as
  adjacent synchronous statements with no `await` between them, so no HTTP
  snapshot can observe the intermediate state (`commitReschedule` and
  `commitCancel` have the same shape);
- `validateCreate` refuses a create on a taken slot *before* a commit token is
  ever issued. Driving the real form flow: after booking the open 10:00 slot,
  a follow-on create on the same slot answers
  `The 10:00 slot on 2026-08-03 is already booked.`, and the seed's pre-booked
  09:00 answers `The 09:00 slot on 2026-08-03 is already booked.`

So this is an **observability** gap, not a correctness one.

## Why it still matters

This repo's thesis is that the witness is the truth: a verdict must rest on
evidence the agent does not author, and `docs/VERIFICATION.md` argues at length
that checking a screen the agent controls is circular. A verifier that cannot
*see* slot occupancy is doing a milder version of the same thing — it is
**trusting the simulator to maintain an invariant** (bookings and slots agree)
rather than **witnessing that it does**. That trust is invisible: if the sim's
commit path were ever reordered, or a real backend adapter were wired in behind
the same `DbStateSnapshot` shape, the gate would go on passing and nothing would
say the evidence had stopped covering the claim.

## Decision

1. `DbStateSnapshot` gains `slots?: DbSlotRow[]`, and `DbBookingRow` gains
   `techId?: number` (slots are keyed by technician/date/time, so without the
   technician a row cannot be attributed to the slot it occupies).
   `normalizeSnapshot` carries both through, accepting `snake_case` and
   `camelCase` exactly as it already did for bookings.

2. **Absent is not empty.** A payload with no slot table yields a snapshot with
   no `slots` property at all — never `[]`. `undefined` means "occupancy was not
   witnessed"; `[]` means "the backend reported zero slots". Collapsing the two
   would let every trajectory recorded before this field existed read as
   "nothing is booked", which is a value nobody observed. This is the whole
   backward-compatibility story and it is tested directly
   (`tests/witness-slots.test.ts`): a pre-slots witness line still re-derives its
   verdict through `harness/audit.ts` and reports the absence honestly.

3. `slotOccupancyCheck(db)` in `groundtruth/verifier.ts` states the invariant as
   code: an **active** booking implies its slot is booked; a **cancelled**
   booking implies its slot is free, unless another active booking has since
   taken it. Rows it cannot compare (no technician; a cancelled row whose slot
   is not in the witnessed table) are returned as `unchecked` with a reason —
   never counted as passing.

4. The slot status is stored **raw**. A witness records what the backend said;
   deciding that `"booked"` means occupied is the checker's single
   interpretation, applied case-insensitively in one place.

## Deliberately NOT done

- **No verdict reads it.** `slotOccupancyCheck` reports; it does not grade. Every
  `VerdictCode` is computed exactly as before, from exactly the same inputs, and
  the full stub replay re-derives unchanged. Wiring a new failure axis into
  grading would change what published run artifacts mean, and there is no
  reachable defect to justify that. The invariant is enforced where a *change*
  would break it — the test suite, which drives the real sim.
- **The converse is not asserted.** "A booked slot implies a booking row" is
  false by design: the seed pre-books slots with no visible booking row, and
  that friction is what the conflict and must-escalate tasks are built on.
- **The saboteur's `backdater` escape is untouched.** Slot occupancy is plausibly
  a second signal against it (a backdated row still had to take a slot), but the
  saboteur synthesizes its own witnesses, so acting on that would mean changing
  the measured discrimination numbers in `docs/DISCRIMINATION.md` on the back of
  a new detector rather than a new measurement. Left as future work, stated here
  so it is not mistaken for an oversight.

## Evidence

- The invariant is asserted over a seeded random walk of the real sim (90
  operations of create/reschedule/cancel, valid and invalid, plus a second walk
  that samples straight through the 400 ms `book-toast-race-001` commit lag) —
  every state the walk witnesses, not three examples.
- The checker is proven non-vacuous over that same generated space: for every
  witnessed state, freeing an active booking's slot, deleting it, and leaving a
  cancelled booking's slot occupied are each injected and each must be caught. A
  detector that always returned "clean" would satisfy the invariant test and
  fails this one.
- Persistence is end-to-end: a freshly recorded stub trajectory's `witness` line
  now carries all 54 slots the sim emits alongside its booking rows, so a run's
  occupancy can be re-checked after the fact from the recorded evidence.
