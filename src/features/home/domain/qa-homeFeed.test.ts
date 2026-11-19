import { describe, expect, it } from 'vitest';

import type { TrainingSession } from '@/lib/database.types';

import { buildHomeFeed } from './homeFeed';

const NOW = new Date('2026-11-19T10:00:00.000Z');
const MIN = 60_000;
function ev(id: string, startMin: number, o: Partial<TrainingSession> = {}): TrainingSession {
  const start = new Date(NOW.getTime() + startMin * MIN);
  return {
    id, status: 'confirmed', event_kind: 'race', starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 60 * MIN).toISOString(), ...o,
  } as TrainingSession;
}

describe('Q8 Home feed builder', () => {
  it('an event that ended or is completed is never Next up; one in progress still is', () => {
    const feed = buildHomeFeed([ev('ended', -61), ev('done', 30, { status: 'completed' }), ev('now', -30), ev('later', 60)], [], NOW);
    expect(feed.nextUp?.id).toBe('now');
    expect(feed.comingUp.map((e) => e.id)).toEqual(['later']);
  });

  it('events without an end stay upcoming until start + 2 h, like the server', () => {
    const noEnd = (id: string, startMin: number) => ev(id, startMin, { ends_at: null });
    expect(buildHomeFeed([noEnd('a', -119)], [], NOW).nextUp?.id).toBe('a');
    expect(buildHomeFeed([noEnd('a', -120)], [], NOW).nextUp).toBeNull();
  });

  it('only cancelled upcoming events: no Next up, all stay visible', () => {
    const feed = buildHomeFeed([ev('x', 60, { status: 'cancelled' }), ev('y', 120, { status: 'cancelled' })], [], NOW);
    expect(feed.nextUp).toBeNull();
    expect(feed.comingUp.map((e) => e.id)).toEqual(['x', 'y']);
  });

  it('events at the same instant keep a stable order whatever the input order', () => {
    expect(buildHomeFeed([ev('b', 60), ev('a', 60), ev('c', 60)], [], NOW)).toEqual(buildHomeFeed([ev('c', 60), ev('a', 60), ev('b', 60)], [], NOW));
  });

  it('the 30-day window is measured in instants and topped up to 3 when fewer fall inside', () => {
    const edge = 30 * 24 * 60;
    const feed = buildHomeFeed([ev('n', 10), ev('in', edge), ev('out', edge + 1), ev('o2', edge + 2), ev('o3', edge + 3)], [], NOW);
    expect(feed.comingUp.map((e) => e.id)).toEqual(['in', 'out', 'o2']);
  });

  it('200 events build quickly, never mutate the input and keep Coming up at 10', () => {
    const list = Array.from({ length: 200 }, (_, i) => ev(`e${i}`, (200 - i) * 60));
    const copy = [...list];
    const start = performance.now();
    const feed = buildHomeFeed(list, [], NOW);
    expect(performance.now() - start).toBeLessThan(200);
    expect(list).toEqual(copy);
    expect(feed.comingUp).toHaveLength(10);
  });

  it('announcements: only published, newest first, at most 3, a missing date sorts last', () => {
    const a = (id: string, at: string | null, status = 'published') => ({ id, status, published_at: at }) as never;
    const feed = buildHomeFeed([], [a('1', '2026-11-01T00:00:00Z'), a('2', '2026-11-03T00:00:00Z'), a('3', null), a('4', '2026-11-02T00:00:00Z', 'scheduled'), a('5', '2026-11-04T00:00:00Z'), a('6', '2026-11-02T00:00:00Z')], NOW);
    expect(feed.latestAnnouncements.map((x) => x.id)).toEqual(['5', '2', '6']);
  });
});
