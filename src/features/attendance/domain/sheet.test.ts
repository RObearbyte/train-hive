import { describe, expect, it } from 'vitest';

import type { CommunityMember } from '@/features/community/api/members';

import {
  countEntries,
  countsText,
  deviceSaysEnded,
  isEditableMode,
  canMarkAllRow,
  markAllTargets,
  needsAttendance,
  needsEndRefetch,
  nextStatusOnTap,
  sheetMode,
  sortEntries,
  walkInCandidates,
} from './sheet';
import { entry } from './testFixtures';

describe('sortEntries', () => {
  it('puts going first by name, then walk-ins by name, without mutating', () => {
    const input = [
      entry('1', 'Zed', { is_walk_in: true, had_rsvp_going: false, has_record: true }),
      entry('2', 'bob'),
      entry('3', 'Anna', { is_walk_in: true, has_record: true }),
      entry('4', 'Alice'),
    ];
    const copy = [...input];
    expect(sortEntries(input).map((e) => e.display_name)).toEqual(['Alice', 'bob', 'Anna', 'Zed']);
    expect(input).toEqual(copy);
  });

  it('breaks name ties by user id so the order is stable', () => {
    const a = entry('b-id', 'Sam');
    const b = entry('a-id', 'Sam');
    expect(sortEntries([a, b]).map((e) => e.user_id)).toEqual(['a-id', 'b-id']);
    expect(sortEntries([b, a]).map((e) => e.user_id)).toEqual(['a-id', 'b-id']);
  });
});

describe('countEntries', () => {
  it('counts statuses, going and walk-ins separately', () => {
    const counts = countEntries([
      entry('1', 'A', { attendance_status: 'present' }),
      entry('2', 'B', { attendance_status: 'absent' }),
      entry('3', 'C'),
      entry('4', 'D', { attendance_status: 'present', is_walk_in: true }),
    ]);
    expect(counts).toEqual({
      present: 2,
      absent: 1,
      unrecorded: 1,
      total: 4,
      goingTotal: 3,
      walkIns: 1,
    });
    expect(countsText(counts)).toBe(
      'Present 2 · Absent 1 · Unrecorded 1 · of 3 who said going (+1 walk-in)',
    );
  });

  it('handles an empty sheet', () => {
    expect(countsText(countEntries([]))).toBe(
      'Present 0 · Absent 0 · Unrecorded 0 · of 0 who said going',
    );
  });
});

describe('sheetMode', () => {
  it('maps the server state to a screen mode', () => {
    expect(sheetMode({ status: 'confirmed', ended: true }, true)).toEqual({ kind: 'record' });
    expect(sheetMode({ status: 'completed', ended: true }, true)).toEqual({ kind: 'correct' });
    expect(sheetMode({ status: 'cancelled', ended: true }, true)).toEqual({ kind: 'cancelled' });
    expect(sheetMode({ status: 'scheduled', ended: false }, false)).toEqual({
      kind: 'not_confirmed',
    });
  });

  it('trusts the server over the device clock; the clock only picks the hint', () => {
    // device says over, not refetched since: checking, no blame on the phone
    expect(sheetMode({ status: 'confirmed', ended: false }, true)).toEqual({
      kind: 'not_ended',
      hint: 'checking',
    });
    // refetched after the end and the server still says not ended
    expect(sheetMode({ status: 'confirmed', ended: false }, true, true)).toEqual({
      kind: 'not_ended',
      hint: 'server_behind',
    });
    expect(sheetMode({ status: 'confirmed', ended: false }, false)).toEqual({
      kind: 'not_ended',
      hint: 'wait',
    });
    // device clock far in the future never opens the sheet by itself
    expect(isEditableMode(sheetMode({ status: 'confirmed', ended: false }, true))).toBe(false);
    expect(isEditableMode({ kind: 'record' })).toBe(true);
    expect(isEditableMode({ kind: 'correct' })).toBe(true);
    expect(isEditableMode({ kind: 'cancelled' })).toBe(false);
  });
});

describe('nextStatusOnTap', () => {
  it('sets the tapped status, and clears it when the active one is tapped again', () => {
    expect(nextStatusOnTap('unrecorded', 'present')).toBe('present');
    expect(nextStatusOnTap('present', 'absent')).toBe('absent');
    expect(nextStatusOnTap('present', 'present')).toBe('unrecorded');
    expect(nextStatusOnTap('absent', 'absent')).toBe('unrecorded');
  });
});

describe('markAllTargets', () => {
  it('returns unrecorded rows that can take a mark, in display order', () => {
    const targets = markAllTargets([
      entry('1', 'Bea'),
      entry('2', 'Al', { attendance_status: 'absent', has_record: true }),
      entry('3', 'Cy', { has_record: true }),
      entry('4', 'Dee', { membership_status: 'removed' }), // no row, not active: cannot be created
      entry('5', 'Eve', { membership_status: 'removed', has_record: true }),
    ]);
    expect(targets.map((e) => e.user_id)).toEqual(['1', '3', '5']);
  });
});

describe('walkInCandidates', () => {
  const members: CommunityMember[] = [
    { userId: '1', displayName: 'Zoe', role: 'member' },
    { userId: '2', displayName: 'amy', role: 'member' },
    { userId: '3', displayName: 'Bob', role: 'organizer' },
  ];

  it('excludes everyone already on the sheet and sorts by name', () => {
    expect(walkInCandidates(members, [{ user_id: '3' }], '').map((m) => m.userId)).toEqual([
      '2',
      '1',
    ]);
  });

  it('filters by a trimmed, case-insensitive search', () => {
    expect(walkInCandidates(members, [], '  AM ').map((m) => m.userId)).toEqual(['2']);
    expect(walkInCandidates(members, [], 'nobody')).toEqual([]);
  });
});

describe('needsAttendance / deviceSaysEnded', () => {
  const base = { starts_at: '2026-11-14T07:00:00Z', ends_at: '2026-11-14T08:00:00Z' };
  it('is true only for a confirmed session whose end has passed', () => {
    const after = new Date('2026-11-14T08:00:00Z');
    const before = new Date('2026-11-14T07:59:00Z');
    expect(needsAttendance({ ...base, status: 'confirmed' }, after)).toBe(true);
    expect(needsAttendance({ ...base, status: 'confirmed' }, before)).toBe(false);
    expect(needsAttendance({ ...base, status: 'completed' }, after)).toBe(false);
    expect(needsAttendance({ ...base, status: 'cancelled' }, after)).toBe(false);
    expect(needsAttendance({ ...base, status: 'scheduled' }, after)).toBe(false);
  });

  it('uses the start when there is no end', () => {
    const noEnd = { starts_at: '2026-11-14T07:00:00Z', ends_at: null };
    expect(needsAttendance({ ...noEnd, status: 'confirmed' }, new Date('2026-11-14T07:00:00Z'))).toBe(
      true,
    );
    expect(deviceSaysEnded(noEnd, new Date('2026-11-14T06:00:00Z'))).toBe(false);
  });
});

describe('canMarkAllRow', () => {
  it('only an unrecorded, idle row may be touched by mark all', () => {
    expect(canMarkAllRow(entry('a', 'A'), false)).toBe(true);
    expect(canMarkAllRow(entry('a', 'A', { attendance_status: 'absent' }), false)).toBe(false);
    expect(canMarkAllRow(entry('a', 'A', { attendance_status: 'present' }), false)).toBe(false);
    expect(canMarkAllRow(entry('a', 'A'), true)).toBe(false);
    expect(canMarkAllRow(undefined, false)).toBe(false);
  });
});

describe('needsEndRefetch', () => {
  const session = { starts_at: '2026-01-01T10:00:00Z', ends_at: '2026-01-01T11:00:00Z' };
  const before = new Date('2026-01-01T10:30:00Z');
  const after = new Date('2026-01-01T11:00:01Z');
  const loadedBefore = new Date('2026-01-01T10:20:00Z').getTime();
  const loadedAfter = new Date('2026-01-01T11:00:00Z').getTime();
  const open = { status: 'confirmed', ended: false } as const;

  it('refetches once the device clock passes the end for a sheet loaded earlier', () => {
    expect(needsEndRefetch(open, session, before, loadedBefore)).toBe(false);
    expect(needsEndRefetch(open, session, after, loadedBefore)).toBe(true);
  });

  it('does not refetch a sheet that was loaded after the end, or one the server says ended', () => {
    expect(needsEndRefetch(open, session, after, loadedAfter)).toBe(false);
    expect(needsEndRefetch({ status: 'confirmed', ended: true }, session, after, loadedBefore)).toBe(false);
    expect(needsEndRefetch({ status: 'cancelled', ended: false }, session, after, loadedBefore)).toBe(false);
  });
});
