/**
 * Parse a HearthDesk confirmation email body into structured booking fields.
 *
 * The confirmation shape is fixed by the sim (docs/decisions/D1-sim-app.md):
 *
 *   Reference: HD-XXXXXX
 *   Kind: created | rescheduled | cancelled
 *   Customer: <name>
 *   Service: <serviceType>
 *   When: <YYYY-MM-DD> <HH:MM>
 *   Address: <addressLine>
 *   Notes: <notes or ->
 *
 * The parser is line-oriented and label-driven so that header wrapping, extra
 * whitespace, or reordered fields do not defeat it. It never guesses: an absent
 * label leaves the corresponding field undefined so the verifier can tell the
 * difference between "a witness does not carry this field" and "this field is
 * wrong".
 */

import type { ExpectedBooking } from "../src/types.ts";

/** Matches the shape of `CapturedEmail.parsed` in src/types.ts. */
export type ParsedEmail = Partial<ExpectedBooking> & { ref?: string; kind?: string };

const REF_PATTERN = /HD-[A-Za-z0-9]+/;
const WHEN_PATTERN = /(\d{4}-\d{2}-\d{2})[ T]+(\d{2}:\d{2})/;
const DATE_ONLY_PATTERN = /(\d{4}-\d{2}-\d{2})/;

export function parseConfirmationBody(bodyText: string, subject?: string): ParsedEmail {
  const out: ParsedEmail = {};
  const labels = new Map<string, string>();

  for (const rawLine of bodyText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line);
    const key = m?.[1];
    const val = m?.[2];
    if (key !== undefined && val !== undefined) {
      labels.set(key.toLowerCase(), val.trim());
    }
  }

  const ref = labels.get("reference") ?? extractRef(subject) ?? extractRef(bodyText);
  if (ref !== undefined) out.ref = ref;

  const kind = labels.get("kind");
  if (kind !== undefined && kind !== "") out.kind = kind.toLowerCase();

  const customer = labels.get("customer");
  if (customer !== undefined && customer !== "") out.customerName = customer;

  const service = labels.get("service");
  if (service !== undefined && service !== "") out.serviceType = service;

  const when = labels.get("when");
  if (when !== undefined) {
    const wm = WHEN_PATTERN.exec(when);
    if (wm?.[1] !== undefined && wm[2] !== undefined) {
      out.date = wm[1];
      out.time = wm[2];
    } else {
      const dm = DATE_ONLY_PATTERN.exec(when);
      if (dm?.[1] !== undefined) out.date = dm[1];
    }
  }

  const address = labels.get("address");
  if (address !== undefined && address !== "") out.addressLine = address;

  // "-" is the sim's explicit "no notes" placeholder; treat it as absent.
  const notes = labels.get("notes");
  if (notes !== undefined && notes !== "" && notes !== "-") out.notes = notes;

  return out;
}

function extractRef(source?: string): string | undefined {
  if (source === undefined) return undefined;
  const m = REF_PATTERN.exec(source);
  return m ? m[0] : undefined;
}
