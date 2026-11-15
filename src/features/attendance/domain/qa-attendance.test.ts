/**
 * QA (M2-Q1): independent checks of the attendance logic and data layer. Pure logic against
 * real objects, and the mobile data layer read as text against the real migrations (nothing
 * is mocked, no database is started). What needs a device or hosted Supabase is listed in
 * docs/QA_REPORT.md.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { CommunityMember } from '@/features/community/api/members';
import { BACKEND_ERROR_CODES, AppError, toAppError, userMessage } from '@/lib/errors';
import type { AttendanceSheet, AttendanceSheetEntry, AttendanceStatus } from '@/lib/database.types';

import { attendanceKeys } from '../api/keys';
import { countByStatus, countsLine, groupByMonth, myOutcomeText } from './history';
import { endsMarkAllRun, markAllSummary, runMarkAll } from './markAll';
import {
  countEntries,
  countsText,
  deviceSaysEnded,
  isEditableMode,
  markAllTargets,
  needsAttendance,
  nextStatusOnTap,
  originLabel,
  sheetMode,
  sortEntries,
  statusLabel,
  walkInCandidates,
} from './sheet';
import { applyOptimisticMark, isRowPending, reconcileMark, rollbackMark } from './sheetCache';
import { entry } from './testFixtures';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), 'utf8');
const sql = [
  '20261114000100_core_schema.sql',
  '20261114000300_trainings_schema.sql',
  '20261115000100_attendance_schema.sql',
  '20261115000200_attendance_rpcs.sql',
]
  .map((file) => read('supabase', 'migrations', file))
  .join('\n');
const apiSource = read('src', 'features', 'attendance', 'api', 'attendance.ts');

describe('QA: the data layer matches the attendance migrations', () => {
  it('reads the keys the sheet RPC really returns (entry and envelope)', () => {
    const rpc = read('supabase', 'migrations', '20261115000200_attendance_rpcs.sql');
    const keysOf = (block: string) => [...block.matchAll(/'(\w+)',/g)].map((m) => m[1]).sort();
    const entryBlock = /jsonb_build_object\(\n\s+'user_id'[\s\S]*?\n\s+\)\n\s+order by/.exec(rpc)![0];
    const envelopeBlock = /return jsonb_build_object\([\s\S]*?\n  \);/.exec(rpc)![0];

    const sampleEntry: AttendanceSheetEntry = entry('u', 'n');
    const sampleSheet: AttendanceSheet = {
      session_id: 's',
      status: 'confirmed',
      ended: true,
      attendance_finalized_at: null,
      attendance_finalized_by: null,
      entries: [],
    };
    expect(keysOf(entryBlock)).toEqual(Object.keys(sampleEntry).sort());
    expect(keysOf(envelopeBlock)).toEqual(Object.keys(sampleSheet).sort());
  });

  it('calls each RPC with the argument names of the SQL functions', () => {
    const calls: Record<string, string[]> = {
      get_attendance_sheet: ['p_session_id'],
      record_attendance: ['p_session_id', 'p_user_id', 'p_status', 'p_reason'],
      add_walk_in_attendee: ['p_session_id', 'p_user_id'],
      finalize_attendance: ['p_session_id'],
    };
    for (const [name, args] of Object.entries(calls)) {
      const fn = new RegExp(`create function public\\.${name}\\(([^)]*)\\)`).exec(sql);
      expect(fn, name).not.toBeNull();
      const declared = [...fn![1].matchAll(/\b(p_\w+)\b/g)].map((m) => m[1]);
      expect(declared, name).toEqual(args);
      const call = new RegExp(`rpc\\('${name}', \\{([^}]*)\\}`).exec(apiSource);
      expect(call, `${name} is called`).not.toBeNull();
      const passed = [...call![1].matchAll(/(p_\w+):/g)].map((m) => m[1]);
      expect(passed, name).toEqual(args);
    }
  });

  it('names the foreign keys it embeds, and they exist (the audit log has two keys to profiles)', () => {
    expect(apiSource).toContain('attendance_records_session_fkey');
    expect(sql).toContain('constraint attendance_records_session_fkey');
    expect(apiSource).toContain('attendance_audit_log_changed_by_fkey');
    // The implicit name is <table>_<column>_fkey: the column must be an inline foreign key.
    expect(sql).toMatch(/create table public\.attendance_audit_log \([\s\S]*?changed_by uuid references public\.profiles \(id\) on delete set null/);
    expect(sql).toMatch(/create table public\.attendance_audit_log \([\s\S]*?user_id uuid not null references public\.profiles/);
  });

  it('selects only columns that exist on the tables it reads', () => {
    const tableColumns = (table: string) => {
      const body = new RegExp(`create table public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);`).exec(sql)![1];
      return new Set([...body.matchAll(/^ {2}(\w+) /gm)].map((m) => m[1]));
    };
    const records = tableColumns('attendance_records');
    const audit = tableColumns('attendance_audit_log');
    const sessions = tableColumns('training_sessions');
    const recordSelect = /from\('attendance_records'\)[\s\S]*?\.select\(\s*'([^']+)'/.exec(apiSource)![1];
    const auditSelect = /from\('attendance_audit_log'\)[\s\S]*?\.select\(\s*'([^']+)'/.exec(apiSource)![1];
    const plain = (select: string) =>
      select
        .replace(/\w+:\w+!\w+\([^)]*\)/g, '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
    for (const column of plain(recordSelect)) expect(records.has(column), `attendance_records.${column}`).toBe(true);
    for (const column of plain(auditSelect)) expect(audit.has(column), `attendance_audit_log.${column}`).toBe(true);
    const embedded = /training_sessions!attendance_records_session_fkey\(([^)]*)\)/.exec(recordSelect)![1].split(',');
    for (const column of embedded.map((c) => c.trim())) expect(sessions.has(column), `training_sessions.${column}`).toBe(true);
  });

  it('filters history to completed sessions on the client (the policy lets members read rows of cancelled ones)', () => {
    expect(apiSource).toMatch(/session\.status !== 'completed'\) continue/);
    // The select policy keys on the member, not on the session status.
    expect(sql).toMatch(/attendance_records_select_own_or_organizer[\s\S]*?user_id = \(select auth\.uid\(\)\) and public\.is_active_member/);
  });
});

describe('QA: "Not recorded" never reads as absent for a member', () => {
  const memberFacing = [
    myOutcomeText('unrecorded'),
    myOutcomeText(null),
    myOutcomeText(undefined),
    statusLabel('unrecorded'),
    countsLine({ present: 0, absent: 0, unrecorded: 3 }).split(' · ')[2],
  ];

  it('uses wording without absent / missed / no-show / skipped', () => {
    for (const text of memberFacing) expect(text, text).not.toMatch(/absent|miss|no[- ]?show|skip|did not (come|attend)/i);
  });

  it('absent has its own, different wording', () => {
    expect(myOutcomeText('absent')).toBe('You were marked absent');
    expect(new Set([myOutcomeText('present'), myOutcomeText('absent'), myOutcomeText('unrecorded')]).size).toBe(3);
    expect(new Set((['present', 'absent', 'unrecorded'] as const).map(statusLabel)).size).toBe(3);
  });

  it('screens that show a member their own outcome give unrecorded a neutral glyph and color, never the absent one', () => {
    const history = read('src', 'features', 'attendance', 'components', 'AttendanceHistoryScreen.tsx');
    expect(/unrecorded: \{ icon: 'circle', color: 'textMuted' \}/.test(history)).toBe(true);
    expect(/absent: \{ icon: 'close', color: 'danger' \}/.test(history)).toBe(true);
    const entryPoint = read('src', 'features', 'attendance', 'components', 'AttendanceEntryPoint.tsx');
    // present -> success, absent -> danger, anything else (unrecorded) -> neutral
    expect(entryPoint).toMatch(/status === 'present' \? 'check-circle' : status === 'absent' \? 'close' : 'circle'/);
    expect(entryPoint).toMatch(/status === 'present' \? 'success' : status === 'absent' \? 'danger' : 'textMuted'/);
  });

  it('counts a mix of statuses without folding unrecorded into absent', () => {
    const items: { status: AttendanceStatus }[] = [
      { status: 'present' },
      { status: 'unrecorded' },
      { status: 'unrecorded' },
      { status: 'absent' },
    ];
    expect(countByStatus(items)).toEqual({ present: 1, absent: 1, unrecorded: 2 });
  });
});

describe('QA: what a tap means', () => {
  it('covers every current status and tapped segment', () => {
    const expected: [AttendanceStatus, 'present' | 'absent', AttendanceStatus][] = [
      ['unrecorded', 'present', 'present'],
      ['unrecorded', 'absent', 'absent'],
      ['present', 'present', 'unrecorded'],
      ['present', 'absent', 'absent'],
      ['absent', 'absent', 'unrecorded'],
      ['absent', 'present', 'present'],
    ];
    for (const [current, tapped, next] of expected) expect(nextStatusOnTap(current, tapped), `${current} + ${tapped}`).toBe(next);
  });
});

describe('QA: mark-all targets', () => {
  it('takes unrecorded rows only; a row without a record needs an active membership; a cleared record of a removed member is allowed', () => {
    const entries = [
      entry('a', 'Ann'),
      entry('b', 'Ben', { attendance_status: 'present', has_record: true, had_rsvp_going: true }),
      entry('c', 'Cat', { attendance_status: 'absent', has_record: true, had_rsvp_going: true }),
      entry('d', 'Dan', { membership_status: 'removed' }),
      entry('e', 'Eve', { membership_status: null }),
      entry('f', 'Fay', { membership_status: 'removed', has_record: true, had_rsvp_going: true }),
      entry('g', 'Gus', { is_walk_in: true, has_record: true, rsvp_response: 'no_response', had_rsvp_going: false }),
    ];
    expect(markAllTargets(entries).map((e) => e.user_id)).toEqual(['a', 'f', 'g']);
  });

  it('is empty for an empty sheet and for a fully marked one', () => {
    expect(markAllTargets([])).toEqual([]);
    expect(markAllTargets([entry('a', 'A', { attendance_status: 'absent', has_record: true })])).toEqual([]);
  });
});

describe('QA: header counts', () => {
  it('words singular and plural walk-ins, and never lists unrecorded as absent', () => {
    const entries = [
      entry('a', 'A', { attendance_status: 'present', has_record: true }),
      entry('b', 'B'),
      entry('c', 'C', { is_walk_in: true, attendance_status: 'present', has_record: true }),
    ];
    expect(countsText(countEntries(entries))).toBe('Present 2 · Absent 0 · Unrecorded 1 · of 2 who said going (+1 walk-in)');
    expect(countsText(countEntries([...entries, entry('d', 'D', { is_walk_in: true })]))).toContain('(+2 walk-ins)');
    expect(countsText(countEntries([]))).toBe('Present 0 · Absent 0 · Unrecorded 0 · of 0 who said going');
  });

  it('labels the origin of a row', () => {
    expect(originLabel({ is_walk_in: true })).toBe('Walk-in');
    expect(originLabel({ is_walk_in: false })).toBe('Said going');
  });
});

describe('QA: sorting', () => {
  it('is stable for names that differ only by case or accents, and for identical names', () => {
    const entries = [
      entry('3', 'zoe'),
      entry('2', 'Zoe'),
      entry('1', 'Zoe'),
      entry('4', 'Álvaro'),
      entry('5', 'Alvaro'),
    ];
    const once = sortEntries(entries).map((e) => e.user_id);
    expect(sortEntries([...entries].reverse()).map((e) => e.user_id)).toEqual(once);
    expect(once.slice(0, 2).sort()).toEqual(['4', '5']);
  });
});

describe('QA: walk-in candidates', () => {
  const members: CommunityMember[] = [
    { userId: 'a', displayName: 'Ștefan Ionescu', role: 'member' },
    { userId: 'b', displayName: 'Ana (a.k.a. "A+")', role: 'member' },
    { userId: 'c', displayName: 'Ana', role: 'organizer' },
  ];

  it('treats the search as plain text, not a pattern', () => {
    expect(walkInCandidates(members, [], '(a.k.a.').map((m) => m.userId)).toEqual(['b']);
    expect(walkInCandidates(members, [], '.*').map((m) => m.userId)).toEqual([]);
    expect(walkInCandidates(members, [], '"A+"').map((m) => m.userId)).toEqual(['b']);
  });

  it('finds names with diacritics, and an organizer can add themselves', () => {
    expect(walkInCandidates(members, [], 'ștefan').map((m) => m.userId)).toEqual(['a']);
    expect(walkInCandidates(members, [{ user_id: 'a' }], '').map((m) => m.userId)).toEqual(['c', 'b']);
  });

  it('a member who is already on the sheet (even removed) is never offered', () => {
    expect(walkInCandidates(members, members.map((m) => ({ user_id: m.userId })), '')).toEqual([]);
  });
});

describe('QA: screen mode versus the server', () => {
  const statuses = ['scheduled', 'confirmed', 'cancelled', 'completed'] as const;

  it('the server decides: only confirmed+ended and completed are editable, whatever the device clock says', () => {
    for (const status of statuses) {
      for (const ended of [true, false]) {
        for (const device of [true, false]) {
          const mode = sheetMode({ status, ended }, device);
          const editable = isEditableMode(mode);
          expect(editable, `${status} ended=${ended} device=${device}`).toBe(
            status === 'completed' || (status === 'confirmed' && ended),
          );
        }
      }
    }
  });

  it('a confirmed session the server calls not ended gets the clock hint only from the device', () => {
    expect(sheetMode({ status: 'confirmed', ended: false }, true)).toEqual({ kind: 'not_ended', hint: 'checking' });
    expect(sheetMode({ status: 'confirmed', ended: false }, false)).toEqual({ kind: 'not_ended', hint: 'wait' });
  });

  it('needsAttendance and deviceSaysEnded: the end instant itself counts as over, garbage dates never do', () => {
    const end = '2026-11-14T10:00:00.000Z';
    const at = (iso: string) => new Date(iso);
    expect(needsAttendance({ status: 'confirmed', starts_at: '2026-11-14T08:00:00Z', ends_at: end }, at(end))).toBe(true);
    expect(needsAttendance({ status: 'confirmed', starts_at: '2026-11-14T08:00:00Z', ends_at: end }, at('2026-11-14T09:59:59.999Z'))).toBe(false);
    expect(needsAttendance({ status: 'confirmed', starts_at: 'not a date', ends_at: null }, at(end))).toBe(false);
    expect(needsAttendance({ status: 'completed', starts_at: '2020-01-01T00:00:00Z', ends_at: null }, at(end))).toBe(false);
    expect(deviceSaysEnded({ starts_at: 'nope', ends_at: null }, at(end))).toBe(false);
  });
});

describe('QA: history grouping across zones and the new year', () => {
  const item = (id: string, startsAt: string, timezone: string) => ({
    id,
    status: 'present' as AttendanceStatus,
    session: { id, startsAt, timezone },
  });

  it('a late New Year session stays in December in its own zone, and moves with the zone elsewhere', () => {
    // 2026-12-31 23:30 in Los Angeles is 2027-01-01 07:30 UTC.
    const groups = groupByMonth([item('la', '2027-01-01T07:30:00Z', 'America/Los_Angeles'), item('ro', '2027-01-01T07:30:00Z', 'Europe/Bucharest')]);
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ['2027-01', ['ro']],
      ['2026-12', ['la']],
    ]);
  });

  it('an unknown zone falls back to UTC instead of dropping the row', () => {
    const groups = groupByMonth([item('x', '2026-11-30T23:30:00Z', 'Mars/Olympus')]);
    expect(groups[0].key).toBe('2026-11');
    expect(groups[0].items).toHaveLength(1);
  });
});

describe('QA: mark-all stops and continues for the right reasons', () => {
  const stops = ['not_authenticated', 'forbidden', 'not_found', 'session_not_confirmed', 'session_not_ended', 'network_error'];

  it('pins the classification of every backend code', () => {
    for (const code of [...BACKEND_ERROR_CODES, 'network_error', 'unknown'] as const) {
      expect(endsMarkAllRun(code), code).toBe(stops.includes(code));
    }
  });

  it('a per-row refusal (member left, RSVP missing) is reported and the run continues; a cancelled session ends it', async () => {
    const seen: string[] = [];
    const result = await runMarkAll(['a', 'b', 'c', 'd', 'e'], async (id) => {
      seen.push(id);
      if (id === 'b') throw new AppError('attendee_not_a_member');
      if (id === 'c') throw new AppError('no_going_rsvp');
      if (id === 'd') throw new AppError('session_not_confirmed');
    });
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    expect(result.succeeded).toEqual(['a']);
    expect(result.failed.map((f) => [f.id, f.code])).toEqual([
      ['b', 'attendee_not_a_member'],
      ['c', 'no_going_rsvp'],
      ['d', 'session_not_confirmed'],
    ]);
    expect(result.skipped).toEqual(['e']);
    expect(markAllSummary(result)).toBe('Marked 1 present, 3 failed, 1 not attempted.');
  });

  it('every failure carries a human message, never the raw code', () => {
    for (const code of BACKEND_ERROR_CODES) {
      const text = userMessage(code);
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toContain('_');
    }
  });

  it('a raw Postgres refusal from record_attendance maps to its code', () => {
    const error = toAppError({ code: 'P0001', message: 'validation_failed:reason' });
    expect(error.code).toBe('validation_failed');
    expect(userMessage(error.code, error.field)).toContain('reason');
  });

  it('the codes the cache treats as "the sheet is stale" are real backend codes', () => {
    const source = read('src', 'features', 'attendance', 'hooks', 'useAttendanceMutations.ts');
    const block = /STALE_SHEET_CODES = new Set\(\[([\s\S]*?)\]\)/.exec(source)![1];
    const codes = [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(3);
    for (const code of codes) expect(BACKEND_ERROR_CODES as readonly string[], code).toContain(code);
  });
});

describe('QA: optimistic rows under overlapping changes to different rows', () => {
  const makeClient = () => {
    const qc = new QueryClient();
    const sheet: AttendanceSheet = {
      session_id: 's',
      status: 'confirmed',
      ended: true,
      attendance_finalized_at: null,
      attendance_finalized_by: null,
      entries: [entry('a', 'Ann'), entry('b', 'Ben')],
    };
    qc.setQueryData(attendanceKeys.sheet('s'), sheet);
    return qc;
  };
  const status = (qc: QueryClient, id: string) =>
    qc.getQueryData<AttendanceSheet>(attendanceKeys.sheet('s'))!.entries.find((e) => e.user_id === id)!.attendance_status;

  it('a failure of one row restores only that row while the other is saved, in either order', () => {
    const qc = makeClient();
    const snapA = applyOptimisticMark(qc, 's', { userId: 'a', next: 'present' });
    const snapB = applyOptimisticMark(qc, 's', { userId: 'b', next: 'absent' });
    reconcileMark(qc, 's', {
      id: 'r', session_id: 's', community_id: 'c', user_id: 'b', status: 'absent', recorded_by: 'o',
      recorded_at: '2026-11-14T10:00:00Z', updated_at: '2026-11-14T10:00:00Z', had_rsvp_going: true, is_walk_in: false,
    });
    rollbackMark(qc, snapA);
    expect(status(qc, 'a')).toBe('unrecorded');
    expect(status(qc, 'b')).toBe('absent');
    expect(snapB.entry?.attendance_status).toBe('unrecorded');
  });

  it('nothing is pending on a fresh client', () => {
    expect(isRowPending(makeClient(), 's', 'a')).toBe(false);
  });

  it('does not invent a row: a mark for someone not on the sheet changes nothing and rolls back to nothing', () => {
    const qc = makeClient();
    const before = JSON.stringify(qc.getQueryData(attendanceKeys.sheet('s')));
    const snap = applyOptimisticMark(qc, 's', { userId: 'zzz', next: 'present' });
    expect(snap.entry).toBeNull();
    rollbackMark(qc, snap);
    expect(JSON.stringify(qc.getQueryData(attendanceKeys.sheet('s')))).toBe(before);
  });
});
