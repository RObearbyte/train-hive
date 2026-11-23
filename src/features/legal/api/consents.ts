import type { ConsentEvent, ConsentPurpose, MyConsents } from '@/lib/database.types';
import { AppError, toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import {
  planGateAcceptance,
  planRecording,
  type ConsentWrite,
  type RecordPlan,
  documentVersionFor,
  mapConsentWriteError,
} from '../domain/consentState';
import { readLocalAcceptance } from './acceptanceStorage';

/** The server's view of the caller's consents. Throws AppError (`not_authenticated`, `network_error`, ...). */
export async function fetchMyConsents(): Promise<MyConsents> {
  const { data, error } = await getSupabase().rpc('my_consents');
  if (error) throw toAppError(error);
  return data as MyConsents;
}

/**
 * Appends a grant. For `terms_privacy`, `documentVersion` must be the
 * combined string `my_consents` returned, exactly as received; optional purposes are sent with the bundled privacy version. Throws
 * AppError (`app_update_required` when the server refuses the document version, `rate_limited`, ...).
 */
export async function recordConsent(
  purpose: ConsentPurpose,
  documentVersion?: string,
): Promise<ConsentEvent> {
  const { data, error } = await getSupabase().rpc('record_consent', {
    p_purpose: purpose,
    p_document_version: documentVersionFor(purpose, documentVersion),
  });
  if (error) throw mapConsentWriteError(error);
  return data as ConsentEvent;
}

/** Appends a withdrawal (the server also deletes what the consent covered). Throws AppError (`not_withdrawable`, ...). */
export async function withdrawConsent(purpose: ConsentPurpose): Promise<ConsentEvent> {
  const { data, error } = await getSupabase().rpc('withdraw_consent', { p_purpose: purpose });
  if (error) throw toAppError(error);
  return data as ConsentEvent;
}

async function performWrites(writes: readonly ConsentWrite[]): Promise<void> {
  for (const write of writes) {
    try {
      if (write.purpose === 'terms_privacy') await recordConsent('terms_privacy', write.documentVersion);
      else await recordConsent('age_16');
    } catch (error) {
      throw mapConsentWriteError(error);
    }
  }
}

function throwForPlan(plan: RecordPlan): asserts plan is Extract<RecordPlan, { action: 'none' | 'record' }> {
  if (plan.action === 'ask_user') {
    throw new AppError('consent_required', { message: 'The first-launch acknowledgement is missing.' });
  }
  if (plan.action === 'app_outdated') {
    throw new AppError('app_update_required', {
      message: 'The server requires legal text versions this build does not contain.',
    });
  }
}

/**
 * Called right after the anonymous session exists and BEFORE
 * `redeem_invitation` / `create_community_with_code`: when the server says
 * `needs_terms_acceptance`, writes the acknowledgement the person gave on the
 * first-launch screen. Throws `consent_required` when there is none on this
 * device (the caller sends the person back to that screen) and
 * `app_update_required` when this build cannot show the texts the server wants.
 */
export async function ensureConsentRecorded(): Promise<void> {
  const server = await fetchMyConsents();
  const plan = planRecording({ local: await readLocalAcceptance(), server });
  throwForPlan(plan);
  if (plan.action === 'record') await performWrites(plan.writes);
}

/**
 * The "We updated our terms" screen: the person's tap acknowledges the texts
 * this build shows, so it is allowed only when they are the server's current
 * versions. Reads the server state fresh (never from a stale cache).
 */
export async function acceptCurrentTerms(): Promise<void> {
  const server = await fetchMyConsents();
  const plan = planGateAcceptance(server);
  throwForPlan(plan);
  if (plan.action === 'record') await performWrites(plan.writes);
}
