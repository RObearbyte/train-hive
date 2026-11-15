import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';

import { endsMarkAllRun, markAllSummary, runMarkAll, type MarkAllProgress } from './markAll';

describe('runMarkAll', () => {
  it('runs rows one after another and reports progress', async () => {
    const order: string[] = [];
    const progress: MarkAllProgress[] = [];
    let running = 0;
    let maxRunning = 0;
    const result = await runMarkAll(
      ['a', 'b', 'c'],
      async (id) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await Promise.resolve();
        order.push(id);
        running -= 1;
      },
      (p) => progress.push(p),
    );
    expect(order).toEqual(['a', 'b', 'c']);
    expect(maxRunning).toBe(1);
    expect(result).toEqual({ succeeded: ['a', 'b', 'c'], failed: [], skipped: [], superseded: [] });
    expect(progress).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
    expect(markAllSummary(result)).toBe('Marked 3 people present.');
  });

  it('keeps going after a per-row failure and reports it', async () => {
    const result = await runMarkAll(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new AppError('attendee_not_a_member');
    });
    expect(result.succeeded).toEqual(['a', 'c']);
    expect(result.failed).toEqual([
      { id: 'b', code: 'attendee_not_a_member', message: 'attendee_not_a_member' },
    ]);
    expect(result.skipped).toEqual([]);
    expect(markAllSummary(result)).toBe('Marked 2 present, 1 failed.');
  });

  it('stops when the failure will repeat for every row', async () => {
    const attempted: string[] = [];
    const result = await runMarkAll(['a', 'b', 'c', 'd'], async (id) => {
      attempted.push(id);
      if (id === 'b') throw new AppError('session_not_ended');
    });
    expect(attempted).toEqual(['a', 'b']);
    expect(result.succeeded).toEqual(['a']);
    expect(result.failed.map((f) => f.id)).toEqual(['b']);
    expect(result.skipped).toEqual(['c', 'd']);
    expect(markAllSummary(result)).toBe('Marked 1 present, 1 failed, 2 not attempted.');
  });

  it('converts non-AppError throws and handles an empty list', async () => {
    const result = await runMarkAll(['a'], async () => {
      throw { message: 'Network request failed' };
    });
    expect(result.failed[0]?.code).toBe('network_error');
    expect(result.skipped).toEqual([]);
    expect(await runMarkAll([], async () => undefined)).toEqual({
      succeeded: [],
      failed: [],
      skipped: [],
      superseded: [],
    });
  });

  it('leaves alone a row that is no longer eligible when its turn comes', async () => {
    const marked = new Set<string>();
    const absent = new Set<string>();
    const progress: MarkAllProgress[] = [];
    const result = await runMarkAll(
      ['a', 'b', 'c'],
      async (id) => {
        marked.add(id);
        // The organizer taps Absent on c while a is being saved.
        if (id === 'a') absent.add('c');
      },
      (p) => progress.push(p),
      (id) => absent.has(id),
    );
    expect([...marked]).toEqual(['a', 'b']);
    expect(result.succeeded).toEqual(['a', 'b']);
    expect(result.superseded).toEqual(['c']);
    expect(result.failed).toEqual([]);
    expect(progress.at(-1)).toEqual({ done: 3, total: 3 });
    expect(markAllSummary(result)).toBe('Marked 2 present, 1 skipped because they changed meanwhile.');
  });

  it('classifies codes', () => {
    expect(endsMarkAllRun('forbidden')).toBe(true);
    expect(endsMarkAllRun('network_error')).toBe(true);
    expect(endsMarkAllRun('attendee_not_a_member')).toBe(false);
    expect(endsMarkAllRun('unknown')).toBe(false);
  });
});
