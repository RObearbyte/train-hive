import { describe, expect, it } from 'vitest';

import {
  cardAccessibilityLabel,
  groupParticipants,
  isProvisional,
  myRsvpText,
  participationLines,
  statusBadgeLabel,
  statusExplanation,
} from '@/features/trainings/domain/presentation';
import {
  participationSummary,
  type TrainingDisplayStatus,
} from '@/features/trainings/domain/status';

const ALL: TrainingDisplayStatus[] = [
  'awaiting_minimum',
  'minimum_reached',
  'finalizing',
  'confirmed',
  'cancelled_insufficient',
  'cancelled_organizer',
  'completed',
];
const DEADLINE = 'Sat 14 Nov, 07:00';

describe('isProvisional', () => {
  it('is true only for the undecided states', () => {
    expect(ALL.filter(isProvisional)).toEqual(['awaiting_minimum', 'minimum_reached', 'finalizing']);
  });
});

describe('statusExplanation', () => {
  it('has distinct text for every status', () => {
    const texts = ALL.map((status) => statusExplanation(status, { remainingToMin: 2 }, DEADLINE));
    expect(new Set(texts).size).toBe(ALL.length);
    for (const text of texts) expect(text.length).toBeGreaterThan(15);
  });

  it('says how many are needed and by when, with singular and plural', () => {
    expect(statusExplanation('awaiting_minimum', { remainingToMin: 3 }, DEADLINE)).toBe(
      'Not decided yet. 3 more people are needed by Sat 14 Nov, 07:00, or the training is cancelled.',
    );
    expect(statusExplanation('awaiting_minimum', { remainingToMin: 1 }, DEADLINE)).toContain(
      '1 more person is needed',
    );
  });

  it('never presents "minimum reached" as final, and says when it becomes final', () => {
    const text = statusExplanation('minimum_reached', { remainingToMin: 0 }, DEADLINE);
    expect(text).toContain('not final');
    expect(text).toContain(DEADLINE);
    expect(text.startsWith('Final')).toBe(false);
  });

  it('presents confirmed as final', () => {
    expect(statusExplanation('confirmed', { remainingToMin: 0 }, DEADLINE)).toBe(
      'Final: this training is happening.',
    );
  });

  it('gives the reason for each kind of cancellation', () => {
    expect(statusExplanation('cancelled_insufficient', { remainingToMin: 4 }, DEADLINE)).toContain(
      'too few people',
    );
    expect(statusExplanation('cancelled_organizer', { remainingToMin: 0 }, DEADLINE)).toContain(
      'organizer',
    );
  });
});

describe('statusBadgeLabel', () => {
  it('shows the number still needed while awaiting', () => {
    expect(statusBadgeLabel('awaiting_minimum', { remainingToMin: 3 })).toBe('3 more needed');
    expect(statusBadgeLabel('awaiting_minimum', { remainingToMin: 1 })).toBe('1 more needed');
  });

  it('keeps the default label otherwise', () => {
    for (const status of ALL.filter((s) => s !== 'awaiting_minimum')) {
      expect(statusBadgeLabel(status, { remainingToMin: 3 })).toBeUndefined();
    }
    expect(statusBadgeLabel('awaiting_minimum', { remainingToMin: 0 })).toBeUndefined();
  });
});

describe('myRsvpText', () => {
  it('covers every response and a missing one', () => {
    expect(myRsvpText('going')).toBe("You're going");
    expect(myRsvpText('not_going')).toBe("You're not going");
    expect(myRsvpText('no_response')).toBe('No answer yet');
    expect(myRsvpText(null)).toBe('No answer yet');
    expect(myRsvpText(undefined)).toBe('No answer yet');
  });
});

describe('cardAccessibilityLabel', () => {
  it('reads the five answers in one sentence list', () => {
    expect(
      cardAccessibilityLabel({
        title: 'Long run',
        when: 'Tomorrow, 09:00',
        location: 'Herastrau Park',
        participation: '8 / 10 confirmed, 2 more participants needed',
        statusLabel: '2 more needed',
        myRsvp: "You're going",
      }),
    ).toBe(
      "Long run. Tomorrow, 09:00. Herastrau Park. 8 / 10 confirmed, 2 more participants needed. Status: 2 more needed. You're going",
    );
  });
});

describe('groupParticipants', () => {
  const people = [
    { response: 'going' as const, displayName: 'mihai' },
    { response: 'not_going' as const, displayName: 'Zoe' },
    { response: 'going' as const, displayName: 'Ana' },
    { response: 'no_response' as const, displayName: 'Dan' },
    { response: 'going' as const, displayName: 'Ștefan' },
    { response: 'not_going' as const, displayName: 'Bogdan' },
  ];

  it('groups going and not going, sorted by name ignoring case, and drops cleared answers', () => {
    const { going, notGoing } = groupParticipants(people);
    expect(going.map((p) => p.displayName)).toEqual(['Ana', 'mihai', 'Ștefan']);
    expect(notGoing.map((p) => p.displayName)).toEqual(['Bogdan', 'Zoe']);
  });

  it('does not mutate its input and handles an empty list', () => {
    const before = people.map((p) => p.displayName);
    groupParticipants(people);
    expect(people.map((p) => p.displayName)).toEqual(before);
    expect(groupParticipants([])).toEqual({ going: [], notGoing: [] });
  });
});

describe('participationLines', () => {
  const summary = (going: number, min: number, max: number | null) =>
    participationSummary({ going_count: going, min_participants: min, max_participants: max });

  it('shows progress towards the minimum while it is not reached', () => {
    expect(participationLines(summary(8, 10, 12), 'awaiting_minimum')).toEqual({
      count: '8 / 10 confirmed',
      need: '2 more participants needed',
      spots: '4 spots left',
    });
  });

  it('switches to a plain count once the minimum is reached', () => {
    expect(participationLines(summary(10, 10, null), 'minimum_reached')).toEqual({
      count: '10 confirmed (minimum 10)',
      need: null,
      spots: null,
    });
    expect(participationLines(summary(11, 6, 11), 'minimum_reached')).toEqual({
      count: '11 confirmed (minimum 6)',
      need: null,
      spots: 'Full',
    });
  });

  it('drops calls to action once responses are closed or the session is decided', () => {
    for (const status of [
      'finalizing',
      'confirmed',
      'cancelled_insufficient',
      'cancelled_organizer',
      'completed',
    ] as const) {
      const lines = participationLines(summary(2, 10, 12), status);
      expect(lines).toEqual({ count: '2 / 10 confirmed', need: null, spots: null });
    }
    expect(participationLines(summary(9, 6, 12), 'confirmed').count).toBe(
      '9 confirmed (minimum 6)',
    );
  });
});
