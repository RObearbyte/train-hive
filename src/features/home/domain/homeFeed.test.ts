import { describe, expect, it } from 'vitest';

import { announcement } from '@/features/notifications/domain/testFixtures';
import type { TrainingSession } from '@/lib/database.types';

import { buildHomeFeed, COMING_UP_MAX } from './homeFeed';

const NOW = new Date('2026-11-19T10:00:00.000Z');
const DAY = 24 * 60 * 60_000;

function event(id: string, startsInDays: number, overrides: Partial<TrainingSession> = {}): TrainingSession {
  const start = new Date(NOW.getTime() + startsInDays * DAY);
  return {
    id,
    status: 'scheduled',
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 60 * 60_000).toISOString(),
    ...overrides,
  } as TrainingSession;
}

describe('buildHomeFeed: events', () => {
  it('is empty with nothing at all', () => {
    const feed = buildHomeFeed([], [], NOW);
    expect(feed).toEqual({ nextUp: null, comingUp: [], latestAnnouncements: [] });
  });

  it('puts the nearest upcoming event in Next up and the rest, nearest first, in Coming up', () => {
    const feed = buildHomeFeed([event('c', 9), event('a', 1), event('b', 3)], [], NOW);
    expect(feed.nextUp?.id).toBe('a');
    expect(feed.comingUp.map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('skips past events and a cancelled first event for Next up', () => {
    const feed = buildHomeFeed(
      [event('old', -3), event('x', 1, { status: 'cancelled' }), event('y', 2)],
      [],
      NOW,
    );
    expect(feed.nextUp?.id).toBe('y');
    // The past event is gone; the cancelled one stays visible so members see the cancellation.
    expect(feed.comingUp.map((e) => e.id)).toEqual(['x']);
  });

  it('shows a cancelled event that comes after the next one', () => {
    const feed = buildHomeFeed([event('y', 1), event('x', 2, { status: 'cancelled' })], [], NOW);
    expect(feed.nextUp?.id).toBe('y');
    expect(feed.comingUp.map((e) => e.id)).toEqual(['x']);
  });

  it('limits Coming up to the next 30 days and to 10 events', () => {
    const many = Array.from({ length: 15 }, (_, i) => event(`e${String(i).padStart(2, '0')}`, i + 1));
    const feed = buildHomeFeed(many, [], NOW);
    expect(feed.nextUp?.id).toBe('e00');
    expect(feed.comingUp).toHaveLength(COMING_UP_MAX);
    expect(feed.comingUp[0]?.id).toBe('e01');

    const far = buildHomeFeed(
      [event('n', 1), event('in', 20), event('out1', 45), event('out2', 50)],
      [],
      NOW,
    );
    // Fewer than 3 in the window: topped up with the following ones.
    expect(far.comingUp.map((e) => e.id)).toEqual(['in', 'out1', 'out2']);
  });

  it('does not top up when the window already has 3', () => {
    const feed = buildHomeFeed(
      [event('n', 1), event('a', 2), event('b', 3), event('c', 4), event('far', 90)],
      [],
      NOW,
    );
    expect(feed.comingUp.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties by id and does not mutate the input', () => {
    const input = [event('b', 2), event('a', 2), event('n', 1)];
    const copy = [...input];
    const feed = buildHomeFeed(input, [], NOW);
    expect(feed.comingUp.map((e) => e.id)).toEqual(['a', 'b']);
    expect(input).toEqual(copy);
  });
});

describe('buildHomeFeed: announcements', () => {
  it('takes the 3 most recently published, newest first, and says when there are more', () => {
    const list = [
      announcement({ id: 'a1', published_at: '2026-11-01T10:00:00Z' }),
      announcement({ id: 'a2', published_at: '2026-11-05T10:00:00Z' }),
      announcement({ id: 'a3', published_at: '2026-11-03T10:00:00Z' }),
      announcement({ id: 'a4', published_at: '2026-11-07T10:00:00Z' }),
    ];
    const feed = buildHomeFeed([], list, NOW);
    expect(feed.latestAnnouncements.map((a) => a.id)).toEqual(['a4', 'a2', 'a3']);
  });

  it('ignores scheduled and cancelled announcements', () => {
    const feed = buildHomeFeed(
      [],
      [
        announcement({ id: 's', status: 'scheduled', published_at: null }),
        announcement({ id: 'c', status: 'cancelled' }),
        announcement({ id: 'p' }),
      ],
      NOW,
    );
    expect(feed.latestAnnouncements.map((a) => a.id)).toEqual(['p']);
  });

  it('works with announcements only (no events)', () => {
    const feed = buildHomeFeed([], [announcement()], NOW);
    expect(feed.nextUp).toBeNull();
    expect(feed.latestAnnouncements).toHaveLength(1);
  });
});
