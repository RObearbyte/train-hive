/**
 * The consent state machine, as pure functions over three inputs: what the
 * device remembers (`LocalAcceptance`), what the server says (`MyConsents`),
 * and the texts bundled in this build.
 *
 * Rules (docs/GDPR_PLAN.md section 2, docs/API_CONTRACT.md "GDPR G1"):
 * - Nothing is recorded without the person having acknowledged the texts.
 * - `terms_privacy` is recorded with the server's combined version string,
 *   exactly as `my_consents` returned it, and only when the texts this build
 *   shows ARE that version (otherwise the person never saw what the server
 *   demands: the app must be updated first).
 * - Anything the server already holds as current is not written again.
 */
import type { ConsentPurpose, MyConsents } from '@/lib/database.types';

import { BUNDLED_TERMS_PRIVACY_VERSION } from '../constants';
import { isAcceptanceCurrent, type LocalAcceptance } from './acceptance';

export type ConsentWrite =
  | { purpose: 'terms_privacy'; documentVersion: string }
  | { purpose: 'age_16' };

export type RecordPlan =
  /** The server already has everything it needs. */
  | { action: 'none' }
  /** The person must (re)acknowledge on the "Before you start" screen first. */
  | { action: 'ask_user' }
  /** The server wants a text version this build does not contain: update the app. */
  | { action: 'app_outdated' }
  /** Acknowledged locally and the versions agree: write these events. */
  | { action: 'record'; writes: ConsentWrite[] };

/** What has to be written so the server's `needs_terms_acceptance` becomes false. */
export function writesFor(server: MyConsents): ConsentWrite[] {
  const writes: ConsentWrite[] = [];
  if (!server.consents.terms_privacy.current) {
    writes.push({ purpose: 'terms_privacy', documentVersion: server.terms_privacy_version });
  }
  if (!server.consents.age_16.granted) writes.push({ purpose: 'age_16' });
  return writes;
}

/** This build's texts are exactly the versions the server currently requires. */
export function bundledMatchesServer(server: Pick<MyConsents, 'terms_privacy_version'>): boolean {
  return server.terms_privacy_version === BUNDLED_TERMS_PRIVACY_VERSION;
}

/**
 * Before a join: what to do given the device's acknowledgement and the
 * server's state.
 */
export function planRecording(input: {
  local: LocalAcceptance | null;
  server: MyConsents;
}): RecordPlan {
  const { local, server } = input;
  if (!server.needs_terms_acceptance) return { action: 'none' };
  if (!isAcceptanceCurrent(local)) return { action: 'ask_user' };
  // `local` is current for the bundled texts; the server must agree on which texts those are.
  if (local === null || local.version !== server.terms_privacy_version) {
    return { action: 'app_outdated' };
  }
  return { action: 'record', writes: writesFor(server) };
}

/**
 * The "We updated our terms" screen shows the bundled texts, so the person's
 * tap is an acknowledgement of exactly those: allowed only when they are the
 * server's versions.
 */
export function planGateAcceptance(server: MyConsents): RecordPlan {
  if (!server.needs_terms_acceptance) return { action: 'none' };
  if (!bundledMatchesServer(server)) return { action: 'app_outdated' };
  return { action: 'record', writes: writesFor(server) };
}

/**
 * Whether the first-launch "Before you start" screen must come before the
 * join / create screens. Unknown (still reading storage) is not "needed":
 * callers wait for the read.
 */
export function needsConsentStep(local: LocalAcceptance | null): boolean {
  return !isAcceptanceCurrent(local);
}

/** The "Continue" button is enabled only with both boxes ticked. */
export function canContinue(boxes: { acceptedTerms: boolean; confirmedAge: boolean }): boolean {
  return boxes.acceptedTerms && boxes.confirmedAge;
}

export type ConsentStartTarget = 'join' | 'create';

/** Parses the `next` route parameter of the consent screen (an allowlist, never a path). */
export function parseStartTarget(value: unknown): ConsentStartTarget {
  const text = Array.isArray(value) ? value[0] : value;
  return text === 'create' ? 'create' : 'join';
}

/** Purposes a person can switch on and off (the other two are required to use TrainHive). */
export const OPTIONAL_PURPOSES: readonly ConsentPurpose[] = [
  'push_notifications',
  'profile_demographics',
  'emergency_contact',
  'workout_logs',
];

export const REQUIRED_PURPOSES: readonly ConsentPurpose[] = ['terms_privacy', 'age_16'];
