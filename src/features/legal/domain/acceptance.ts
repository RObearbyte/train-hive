/**
 * The acknowledgement collected on the first-launch screen, kept on the device
 * until the server can record it (an auth session only exists once someone
 * submits a code). Pure: storage lives in `api/acceptanceStorage.ts`.
 *
 * `acceptedAt` is a note for support and display only. No rule is decided from
 * the device clock: the server stamps the real consent record itself.
 */
import { BUNDLED_TERMS_PRIVACY_VERSION } from '../constants';

/** Stored next to the session, per device (not per user). */
export const ACCEPTANCE_STORAGE_KEY = 'trainhive.legal-acceptance';

export type LocalAcceptance = {
  /** The combined `terms:<v>|privacy:<v>` string of the texts the person saw. */
  version: string;
  /** The "I am at least 16" box was ticked. */
  age16: true;
  /** ISO time from the device (informational). */
  acceptedAt: string;
};

export function createLocalAcceptance(version: string, now: Date): LocalAcceptance {
  return { version, age16: true, acceptedAt: now.toISOString() };
}

export function serializeLocalAcceptance(acceptance: LocalAcceptance): string {
  return JSON.stringify(acceptance);
}

/** Parses what was stored; anything malformed counts as "not accepted". */
export function parseLocalAcceptance(raw: string | null | undefined): LocalAcceptance | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'string' || record.version === '') return null;
  if (record.age16 !== true) return null;
  if (typeof record.acceptedAt !== 'string' || Number.isNaN(Date.parse(record.acceptedAt))) return null;
  return { version: record.version, age16: true, acceptedAt: record.acceptedAt };
}

/** The stored acceptance covers the texts bundled in this build (a new version means asking again). */
export function isAcceptanceCurrent(
  acceptance: LocalAcceptance | null,
  bundledVersion: string = BUNDLED_TERMS_PRIVACY_VERSION,
): boolean {
  return acceptance !== null && acceptance.age16 && acceptance.version === bundledVersion;
}
