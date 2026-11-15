import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { AttendanceRecord, AttendanceSheet } from '@/lib/database.types';

import { attendanceKeys, recordAttendanceKey } from '../api/keys';
import {
  applyOptimisticMark,
  invalidateAttendanceUnlessPending,
  invalidateSheetUnlessPending,
  isRowPending,
  reconcileMark,
  rollbackMark,
  upsertWalkIn,
  type MarkVariables,
} from './sheetCache';
import { entry } from './testFixtures';

const SESSION = 's1';

function makeSheet(): AttendanceSheet {
  return {
    session_id: SESSION,
    status: 'confirmed',
    ended: true,
    attendance_finalized_at: null,
    attendance_finalized_by: null,
    entries: [entry('u1', 'Ann'), entry('u2', 'Ben'), entry('u3', 'Cat')],
  };
}

function seed() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(attendanceKeys.sheet(SESSION), makeSheet());
  return queryClient;
}

const sheetOf = (qc: QueryClient) =>
  qc.getQueryData<AttendanceSheet>(attendanceKeys.sheet(SESSION)) as AttendanceSheet;
const statusOf = (qc: QueryClient, id: string) =>
  sheetOf(qc).entries.find((e) => e.user_id === id)?.attendance_status;

function record(userId: string, status: AttendanceRecord['status'], extra: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: `r-${userId}`,
    session_id: SESSION,
    community_id: 'c1',
    user_id: userId,
    status,
    recorded_by: 'org',
    recorded_at: '2026-11-14T09:00:00Z',
    updated_at: '2026-11-14T09:01:00Z',
    had_rsvp_going: true,
    is_walk_in: false,
    ...extra,
  };
}

describe('optimistic mark', () => {
  it('changes only the tapped row', () => {
    const qc = seed();
    applyOptimisticMark(qc, SESSION, { userId: 'u2', next: 'present' });
    expect(statusOf(qc, 'u1')).toBe('unrecorded');
    expect(statusOf(qc, 'u2')).toBe('present');
    expect(statusOf(qc, 'u3')).toBe('unrecorded');
  });

  it('rolls back exactly the one row, leaving other rows changed meanwhile alone', () => {
    const qc = seed();
    const snapshotU1 = applyOptimisticMark(qc, SESSION, { userId: 'u1', next: 'present' });
    applyOptimisticMark(qc, SESSION, { userId: 'u3', next: 'absent' });
    // u1 fails, u3 is still pending
    rollbackMark(qc, snapshotU1);
    expect(statusOf(qc, 'u1')).toBe('unrecorded');
    expect(statusOf(qc, 'u3')).toBe('absent');
    expect(sheetOf(qc).entries).toHaveLength(3);
  });

  it('rolls back into a sheet that was refetched in the meantime', () => {
    const qc = seed();
    const snapshot = applyOptimisticMark(qc, SESSION, { userId: 'u1', next: 'present' });
    // A refetch brought a new row from another organizer
    qc.setQueryData<AttendanceSheet>(attendanceKeys.sheet(SESSION), {
      ...sheetOf(qc),
      entries: [...sheetOf(qc).entries, entry('u9', 'Zed', { attendance_status: 'present', has_record: true })],
    });
    rollbackMark(qc, snapshot);
    expect(statusOf(qc, 'u1')).toBe('unrecorded');
    expect(statusOf(qc, 'u9')).toBe('present');
  });

  it('restores a previously recorded row exactly (including its metadata)', () => {
    const qc = new QueryClient();
    const sheet = makeSheet();
    sheet.entries[0] = entry('u1', 'Ann', {
      attendance_status: 'absent',
      has_record: true,
      had_rsvp_going: true,
      updated_at: '2026-11-14T08:00:00Z',
    });
    qc.setQueryData(attendanceKeys.sheet(SESSION), sheet);
    const snapshot = applyOptimisticMark(qc, SESSION, { userId: 'u1', next: 'present' });
    rollbackMark(qc, snapshot);
    expect(sheetOf(qc)).toEqual(sheet);
  });

  it('does nothing when the sheet is not cached or the row is not on it', () => {
    const empty = new QueryClient();
    const snapshot = applyOptimisticMark(empty, SESSION, { userId: 'u1', next: 'present' });
    expect(snapshot.entry).toBeNull();
    rollbackMark(empty, snapshot);
    expect(empty.getQueryData(attendanceKeys.sheet(SESSION))).toBeUndefined();

    const qc = seed();
    const missing = applyOptimisticMark(qc, SESSION, { userId: 'nobody', next: 'present' });
    expect(missing.entry).toBeNull();
    expect(sheetOf(qc)).toEqual(makeSheet());
  });
});

describe('reconcileMark / upsertWalkIn', () => {
  it("takes the server's row", () => {
    const qc = seed();
    applyOptimisticMark(qc, SESSION, { userId: 'u2', next: 'present' });
    reconcileMark(qc, SESSION, record('u2', 'present'));
    const row = sheetOf(qc).entries.find((e) => e.user_id === 'u2');
    expect(row).toMatchObject({
      attendance_status: 'present',
      has_record: true,
      had_rsvp_going: true,
      is_walk_in: false,
      updated_at: '2026-11-14T09:01:00Z',
    });
  });

  it('adds a walk-in row with the known name, or updates an existing row', () => {
    const qc = seed();
    upsertWalkIn(qc, SESSION, record('w1', 'present', { had_rsvp_going: false, is_walk_in: true }), 'Walt');
    const walkIn = sheetOf(qc).entries.find((e) => e.user_id === 'w1');
    expect(walkIn).toMatchObject({
      display_name: 'Walt',
      is_walk_in: true,
      attendance_status: 'present',
      has_record: true,
    });
    upsertWalkIn(qc, SESSION, record('w1', 'present', { had_rsvp_going: false, is_walk_in: true }), 'Walt');
    expect(sheetOf(qc).entries.filter((e) => e.user_id === 'w1')).toHaveLength(1);
  });
});

/** Runs a real mutation so the pending bookkeeping is checked against TanStack itself. */
function startMutation(qc: QueryClient, vars: MarkVariables, hold: Promise<void>, onSettled?: () => void) {
  const observer = new MutationObserver<unknown, Error, MarkVariables>(qc, {
    mutationKey: recordAttendanceKey(SESSION),
    mutationFn: async () => {
      await hold;
      return null;
    },
    onSettled,
  });
  const done = observer.mutate(vars).catch(() => undefined);
  return done;
}

describe('pending bookkeeping', () => {
  it('knows which row is pending and lets go once it settles', async () => {
    const qc = seed();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const done = startMutation(qc, { userId: 'u1', next: 'present', reason: null }, hold);
    expect(isRowPending(qc, SESSION, 'u1')).toBe(true);
    expect(isRowPending(qc, SESSION, 'u2')).toBe(false);
    expect(isRowPending(qc, 'other-session', 'u1')).toBe(false);
    release();
    await done;
    expect(isRowPending(qc, SESSION, 'u1')).toBe(false);
  });

  it('skips invalidation while changes are in flight, and runs it when none are', async () => {
    const qc = seed();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const done = startMutation(qc, { userId: 'u1', next: 'present', reason: null }, hold);

    invalidateSheetUnlessPending(qc, SESSION);
    invalidateAttendanceUnlessPending(qc);
    expect(qc.getQueryState(attendanceKeys.sheet(SESSION))?.isInvalidated).toBe(false);

    release();
    await done;
    invalidateSheetUnlessPending(qc, SESSION);
    expect(qc.getQueryState(attendanceKeys.sheet(SESSION))?.isInvalidated).toBe(true);
  });

  it('counts the settling mutation as pending inside onSettled (the selfSettling threshold)', async () => {
    const qc = seed();
    const seen: { alone: boolean; withOther: boolean } = { alone: false, withOther: false };
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let releaseOther: () => void = () => undefined;
    const holdOther = new Promise<void>((resolve) => (releaseOther = resolve));

    // alone: onSettled of the only mutation must refetch
    const first = startMutation(qc, { userId: 'u1', next: 'present', reason: null }, hold, () => {
      invalidateSheetUnlessPending(qc, SESSION, { selfSettling: true });
      seen.alone = qc.getQueryState(attendanceKeys.sheet(SESSION))?.isInvalidated === true;
    });
    release();
    await first;
    expect(seen.alone).toBe(true);

    // with another row still pending, onSettled must not refetch
    qc.setQueryData(attendanceKeys.sheet(SESSION), makeSheet()); // clears the invalidated flag
    const other = startMutation(qc, { userId: 'u2', next: 'absent', reason: null }, holdOther);
    let release3: () => void = () => undefined;
    const hold3 = new Promise<void>((resolve) => (release3 = resolve));
    const third = startMutation(qc, { userId: 'u3', next: 'absent', reason: null }, hold3, () => {
      invalidateSheetUnlessPending(qc, SESSION, { selfSettling: true });
      seen.withOther = qc.getQueryState(attendanceKeys.sheet(SESSION))?.isInvalidated === true;
    });
    release3();
    await third;
    expect(seen.withOther).toBe(false);
    releaseOther();
    await other;
  });
});
