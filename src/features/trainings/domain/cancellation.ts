/**
 * The optional note an organizer can attach when cancelling an event, and its display line.
 * Pure. The server enforces the same limit (cancellation_reason, 1..300 characters).
 */
import type { TrainingSession } from '@/lib/database.types';

export const MAX_CANCELLATION_REASON = 300;

export type CancellationReasonCheck =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/** Trims the typed note; blank means "no reason" (null). Too long is an error, never cut. */
export function checkCancellationReason(text: string): CancellationReasonCheck {
  const value = text.trim();
  if (value === '') return { ok: true, value: null };
  if (value.length > MAX_CANCELLATION_REASON) {
    return {
      ok: false,
      message: `Keep the reason to ${MAX_CANCELLATION_REASON} characters or fewer (now ${value.length}).`,
    };
  }
  return { ok: true, value };
}

/** "Reason: ..." for a cancelled event that has a note, otherwise null. */
export function cancellationReasonLine(
  session: Pick<TrainingSession, 'status' | 'cancellation_reason'>,
): string | null {
  if (session.status !== 'cancelled') return null;
  const reason = session.cancellation_reason?.trim();
  return reason ? `Reason: ${reason}` : null;
}
