/**
 * Live IMAP witness — a documented, credential-gated INTERFACE.
 *
 * In CI the email witness is the local SMTP sink, which is fully offline and
 * key-free. The exact same verifier can instead read a real mailbox over IMAP
 * when running against a live deployment: the confirmation email is a witness
 * the agent under test does not author, whether captured locally or fetched
 * from a real inbox.
 *
 * This file is intentionally NOT a working IMAP client. The project's
 * dependency policy (see CONTRACTS.md) permits no IMAP library, so an
 * implementation cannot be bundled here. Rather than fake one, this module
 * defines the contract a live adapter must satisfy and fails loudly, with
 * configuration guidance, if used without credentials. Wire a real IMAP client
 * here (behind the env-gated config below) to enable live mode.
 */

import type { CapturedEmail } from "../src/types.ts";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** default true; IMAPS on 993. */
  tls: boolean;
  /** mailbox to poll, default "INBOX". */
  mailbox?: string;
}

export interface ImapFetchOptions {
  /** restrict to messages received at/after this ISO timestamp. */
  sinceIso?: string;
  /** cap the number of messages returned. */
  limit?: number;
}

/**
 * A live email witness. Implementations return CapturedEmail records shaped
 * identically to the SMTP sink's, so `verifier.ts` is source-agnostic.
 */
export interface ImapWitness {
  fetchRecent(opts?: ImapFetchOptions): Promise<CapturedEmail[]>;
  close(): Promise<void>;
}

const ENV_HELP =
  "configure IMAP_* env to enable live IMAP mode: IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD (IMAP_TLS optional, default true; IMAP_MAILBOX optional, default INBOX)";

/**
 * Build an ImapConfig from IMAP_* environment variables, or undefined if the
 * required variables are not all present.
 */
export function imapConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ImapConfig | undefined {
  const host = env.IMAP_HOST;
  const user = env.IMAP_USER;
  const password = env.IMAP_PASSWORD;
  if (!host || !user || !password) return undefined;

  const config: ImapConfig = {
    host,
    port: env.IMAP_PORT ? Number(env.IMAP_PORT) : 993,
    user,
    password,
    tls: env.IMAP_TLS ? env.IMAP_TLS !== "false" : true,
  };
  if (env.IMAP_MAILBOX) config.mailbox = env.IMAP_MAILBOX;
  return config;
}

/**
 * Create a live IMAP witness. Throws immediately with configuration guidance if
 * no complete config is supplied (either directly or via IMAP_* env), so a
 * mis-run never silently degrades to "no emails found".
 */
export function createImapWitness(config?: ImapConfig): ImapWitness {
  const resolved = config ?? imapConfigFromEnv();
  if (!resolved || !resolved.host || !resolved.user || !resolved.password) {
    throw new Error(ENV_HELP);
  }
  // A real adapter is wired here. Until one is, live mode is not available in
  // this build; fail with a precise, non-silent error rather than fabricate.
  throw new Error(
    `live IMAP witness is a documented interface stub in this build; wire an IMAP client for ${resolved.user}@${resolved.host}:${resolved.port} to enable it`,
  );
}
