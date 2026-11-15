import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCoalescer,
  resubscribeDelayMs,
  topicsForTable,
} from '@/features/trainings/domain/coalesce';

describe('createCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const flushes: string[][] = [];
    const coalescer = createCoalescer<string>((keys) => flushes.push(keys), {
      delayMs: 300,
      maxWaitMs: 2000,
    });
    return { flushes, coalescer };
  }

  it('turns a burst of events into one flush with each key once', () => {
    const { flushes, coalescer } = setup();
    for (let i = 0; i < 10; i += 1) {
      coalescer.add('rsvps');
      coalescer.add('sessions');
      vi.advanceTimersByTime(20);
    }
    expect(flushes).toEqual([]);

    vi.advanceTimersByTime(300);

    expect(flushes).toEqual([['rsvps', 'sessions']]);
  });

  it('does nothing until the quiet period has passed', () => {
    const { flushes, coalescer } = setup();
    coalescer.add('sessions');
    vi.advanceTimersByTime(299);
    expect(flushes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushes).toEqual([['sessions']]);
  });

  it('flushes separate bursts separately', () => {
    const { flushes, coalescer } = setup();
    coalescer.add('sessions');
    vi.advanceTimersByTime(300);
    coalescer.add('rsvps');
    vi.advanceTimersByTime(300);
    expect(flushes).toEqual([['sessions'], ['rsvps']]);
  });

  it('cannot be postponed forever by a steady stream', () => {
    const { flushes, coalescer } = setup();
    // An event every 200ms keeps restarting the 300ms wait.
    for (let elapsed = 0; elapsed < 1800; elapsed += 200) {
      coalescer.add('rsvps');
      vi.advanceTimersByTime(200);
    }
    expect(flushes).toEqual([]);

    vi.advanceTimersByTime(100);
    expect(flushes).toEqual([['rsvps']]);

    // The cap starts again with the next burst.
    coalescer.add('rsvps');
    vi.advanceTimersByTime(300);
    expect(flushes).toHaveLength(2);
  });

  it('flush() delivers immediately and leaves nothing behind', () => {
    const { flushes, coalescer } = setup();
    coalescer.add('membership');
    coalescer.flush();
    expect(flushes).toEqual([['membership']]);
    vi.advanceTimersByTime(5000);
    expect(flushes).toHaveLength(1);
    coalescer.flush();
    expect(flushes).toHaveLength(1);
  });

  it('cancel() drops queued keys and stops the timer', () => {
    const { flushes, coalescer } = setup();
    coalescer.add('sessions');
    coalescer.cancel();
    vi.advanceTimersByTime(5000);
    expect(flushes).toEqual([]);
    // Usable again afterwards.
    coalescer.add('rsvps');
    vi.advanceTimersByTime(300);
    expect(flushes).toEqual([['rsvps']]);
  });

  it('keeps working when the flush handler queues more work', () => {
    const flushes: string[][] = [];
    const coalescer = createCoalescer<string>(
      (keys) => {
        flushes.push(keys);
        if (flushes.length === 1) coalescer.add('again');
      },
      { delayMs: 300, maxWaitMs: 2000 },
    );
    coalescer.add('first');
    vi.advanceTimersByTime(300);
    vi.advanceTimersByTime(300);
    expect(flushes).toEqual([['first'], ['again']]);
  });
});

describe('topicsForTable', () => {
  it('maps each subscribed table to what it makes stale', () => {
    expect(topicsForTable('training_sessions')).toEqual(['sessions']);
    expect(topicsForTable('training_rsvps')).toEqual(['rsvps', 'sessions']);
    expect(topicsForTable('memberships')).toEqual(['membership']);
  });

  it('ignores tables it does not know', () => {
    expect(topicsForTable('profiles')).toEqual([]);
    expect(topicsForTable('')).toEqual([]);
  });
});

describe('resubscribeDelayMs', () => {
  it('backs off exponentially up to 30 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(resubscribeDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  it('treats nonsense attempts as the first', () => {
    expect(resubscribeDelayMs(-3)).toBe(1000);
    expect(resubscribeDelayMs(0.9)).toBe(1000);
  });
});
