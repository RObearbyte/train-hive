import { describe, expect, it } from 'vitest';

import {
  cancellationReasonLine,
  checkCancellationReason,
  MAX_CANCELLATION_REASON,
} from '@/features/trainings/domain/cancellation';

describe('checkCancellationReason', () => {
  it('blank and whitespace mean no reason', () => {
    expect(checkCancellationReason('')).toEqual({ ok: true, value: null });
    expect(checkCancellationReason('  \n ')).toEqual({ ok: true, value: null });
  });

  it('trims the note', () => {
    expect(checkCancellationReason('  Storm.  ')).toEqual({ ok: true, value: 'Storm.' });
  });

  it('accepts exactly the limit and refuses one more', () => {
    expect(checkCancellationReason('x'.repeat(MAX_CANCELLATION_REASON))).toMatchObject({ ok: true });
    const over = checkCancellationReason('x'.repeat(MAX_CANCELLATION_REASON + 1));
    expect(over).toMatchObject({ ok: false });
    expect(over.ok === false && over.message).toContain('301');
  });
});

describe('cancellationReasonLine', () => {
  it('shows the note only for a cancelled event', () => {
    expect(cancellationReasonLine({ status: 'cancelled', cancellation_reason: 'Storm.' })).toBe('Reason: Storm.');
    expect(cancellationReasonLine({ status: 'confirmed', cancellation_reason: 'Storm.' })).toBeNull();
  });

  it('is null without a note', () => {
    expect(cancellationReasonLine({ status: 'cancelled', cancellation_reason: null })).toBeNull();
    expect(cancellationReasonLine({ status: 'cancelled', cancellation_reason: '  ' })).toBeNull();
  });

  it('shows the pre-filled text of an auto-cancel', () => {
    expect(
      cancellationReasonLine({ status: 'cancelled', cancellation_reason: 'Not enough participants: 1 of 3 needed.' }),
    ).toBe('Reason: Not enough participants: 1 of 3 needed.');
  });
});
