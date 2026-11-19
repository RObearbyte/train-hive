/**
 * Pure updates of the cached `MyConsents` for optimistic switches. The server
 * stays the authority: every update is followed by a refetch, and a failure
 * restores the snapshot taken before.
 */
import type { ConsentEvent, ConsentPurpose, MyConsents } from '@/lib/database.types';

/** The cache after `event` (a grant or withdrawal of one purpose). Other purposes are untouched. */
export function applyConsentEvent(
  current: MyConsents,
  event: Pick<ConsentEvent, 'purpose' | 'granted' | 'document_version' | 'at'>,
): MyConsents {
  const previous = current.consents[event.purpose];
  const granted = event.granted;
  const next = {
    granted,
    // Optional purposes are current exactly when granted; terms_privacy is only ever set by the gate flows, which refetch.
    current: event.purpose === 'terms_privacy' ? previous.current && granted : granted,
    document_version: event.document_version ?? previous.document_version,
    at: event.at ?? previous.at,
  };
  return { ...current, consents: { ...current.consents, [event.purpose]: next } };
}

/** An optimistic grant/withdrawal that has no server timestamp yet: keeps the previous `at`. */
export function optimisticConsent(
  current: MyConsents,
  purpose: ConsentPurpose,
  granted: boolean,
): MyConsents {
  const state = current.consents[purpose];
  return applyConsentEvent(current, {
    purpose,
    granted,
    document_version: state.document_version,
    at: state.at,
  });
}

/** True when the purpose is currently granted according to the cache (null while unknown). */
export function isConsentCurrent(data: MyConsents | undefined, purpose: ConsentPurpose): boolean | null {
  if (data === undefined) return null;
  return data.consents[purpose].current;
}
