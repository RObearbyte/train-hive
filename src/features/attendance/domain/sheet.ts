/**
 * Pure rules for the organizer's attendance sheet: ordering, counts, which
 * state the screen is in, what a tap on a segment means. No React, no network.
 *
 * `now` / device clock is used for DISPLAY hints only. Whether attendance can
 * be taken is the server's call (`session_not_ended`, `session_not_confirmed`).
 */
import type {
  AttendanceSheet,
  AttendanceSheetEntry,
  AttendanceStatus,
  TrainingSession,
} from '@/lib/database.types';
import type { CommunityMember } from '@/features/community/api/members';

const byName = (a: { display_name: string }, b: { display_name: string }) =>
  a.display_name.localeCompare(b.display_name, 'en', { sensitivity: 'base' });

/**
 * Display order: people who said going first (by name), then walk-ins (by
 * name). The user id breaks ties so the order is stable across refetches.
 * Does not mutate the input.
 */
export function sortEntries(entries: readonly AttendanceSheetEntry[]): AttendanceSheetEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_walk_in !== b.is_walk_in) return a.is_walk_in ? 1 : -1;
    const name = byName(a, b);
    if (name !== 0) return name;
    return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
  });
}

export type SheetCounts = {
  present: number;
  absent: number;
  unrecorded: number;
  /** Everyone on the sheet. */
  total: number;
  /** Entries that said going (walk-ins excluded): the "of N" in the header. */
  goingTotal: number;
  walkIns: number;
};

export function countEntries(entries: readonly AttendanceSheetEntry[]): SheetCounts {
  const counts: SheetCounts = {
    present: 0,
    absent: 0,
    unrecorded: 0,
    total: entries.length,
    goingTotal: 0,
    walkIns: 0,
  };
  for (const entry of entries) {
    counts[entry.attendance_status] += 1;
    if (entry.is_walk_in) counts.walkIns += 1;
    else counts.goingTotal += 1;
  }
  return counts;
}

/** One line for the header, e.g. "Present 5 · Absent 1 · Unrecorded 3 · of 9 who said going (+2 walk-ins)". */
export function countsText(counts: SheetCounts): string {
  const parts = [
    `Present ${counts.present}`,
    `Absent ${counts.absent}`,
    `Unrecorded ${counts.unrecorded}`,
    `of ${counts.goingTotal} who said going`,
  ];
  const text = parts.join(' · ');
  if (counts.walkIns === 0) return text;
  return `${text} (+${counts.walkIns} walk-in${counts.walkIns === 1 ? '' : 's'})`;
}

/**
 * What the screen shows for a session.
 * - `record`: confirmed and ended, attendance not finalized yet.
 * - `correct`: completed; every change is audited.
 * - `not_ended`: confirmed but the server says it has not ended. `hint`
 *   chooses the wording (display only): `wait` (device clock agrees), `checking`
 *   (device clock says over, the sheet has not been refetched since), `server_behind`
 *   (refetched after the end and the server still says not ended).
 */
export type SheetMode =
  | { kind: 'record' }
  | { kind: 'correct' }
  | { kind: 'not_confirmed' }
  | { kind: 'cancelled' }
  | { kind: 'not_ended'; hint: 'wait' | 'checking' | 'server_behind' };

export function sheetMode(
  sheet: Pick<AttendanceSheet, 'status' | 'ended'>,
  deviceSaysEnded: boolean,
  refetchedSinceEnd = false,
): SheetMode {
  switch (sheet.status) {
    case 'completed':
      return { kind: 'correct' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'scheduled':
      return { kind: 'not_confirmed' };
    case 'confirmed':
      return sheet.ended
        ? { kind: 'record' }
        : { kind: 'not_ended', hint: !deviceSaysEnded ? 'wait' : refetchedSinceEnd ? 'server_behind' : 'checking' };
  }
}

/** True when a mode lets the organizer change values. */
export function isEditableMode(mode: SheetMode): boolean {
  return mode.kind === 'record' || mode.kind === 'correct';
}

/**
 * What a tap on a segment sets. Tapping the segment that is already active
 * clears the mark back to `unrecorded` (the same gesture as the RSVP toggle),
 * so a slip is undone without a third button. Before finalization that is a
 * plain change; after it, it is a correction like any other.
 */
export function nextStatusOnTap(
  current: AttendanceStatus,
  tapped: Exclude<AttendanceStatus, 'unrecorded'>,
): AttendanceStatus {
  return current === tapped ? 'unrecorded' : tapped;
}

/**
 * Entries "Mark all present" would change: nobody has marked them. A member
 * with no row yet needs to be an active member (the server refuses to create a
 * row for anyone else), so those are left out.
 */
export function markAllTargets(entries: readonly AttendanceSheetEntry[]): AttendanceSheetEntry[] {
  return sortEntries(entries).filter(
    (entry) =>
      entry.attendance_status === 'unrecorded' &&
      (entry.has_record || entry.membership_status === 'active'),
  );
}

/**
 * Members who can be added as a walk-in: active members with nothing on the
 * sheet (a going RSVP is marked from its row, and anyone with a record
 * already has a row), filtered by a name search. Sorted by name.
 */
export function walkInCandidates(
  members: readonly CommunityMember[],
  entries: readonly Pick<AttendanceSheetEntry, 'user_id'>[],
  search: string,
): CommunityMember[] {
  const onSheet = new Set(entries.map((entry) => entry.user_id));
  const needle = search.trim().toLocaleLowerCase('en');
  return members
    .filter((member) => !onSheet.has(member.userId))
    .filter((member) => needle === '' || member.displayName.toLocaleLowerCase('en').includes(needle))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }));
}

/**
 * The training needs its attendance recorded: confirmed (not yet completed)
 * and over. The device clock only decides whether to show a cue; the server
 * decides whether recording is accepted.
 */
export function needsAttendance(
  session: Pick<TrainingSession, 'status' | 'starts_at' | 'ends_at'>,
  now: Date,
): boolean {
  if (session.status !== 'confirmed') return false;
  const end = new Date(session.ends_at ?? session.starts_at).getTime();
  return end <= now.getTime();
}

/** True when the device clock says the training is over (used only to pick wording). */
export function deviceSaysEnded(
  session: Pick<TrainingSession, 'starts_at' | 'ends_at'>,
  now: Date,
): boolean {
  return new Date(session.ends_at ?? session.starts_at).getTime() <= now.getTime();
}

export function statusLabel(status: AttendanceStatus): string {
  switch (status) {
    case 'present':
      return 'Present';
    case 'absent':
      return 'Absent';
    case 'unrecorded':
      return 'Not recorded';
  }
}

/** Origin chip text: why this person is on the list. */
export function originLabel(entry: Pick<AttendanceSheetEntry, 'is_walk_in'>): string {
  return entry.is_walk_in ? 'Walk-in' : 'Said going';
}

/** Epoch ms of the session's end (start when there is no end). */
function endMs(session: Pick<TrainingSession, 'starts_at' | 'ends_at'>): number {
  return new Date(session.ends_at ?? session.starts_at).getTime();
}

/**
 * True when the sheet on screen was loaded before the end time and the device
 * clock now says the end has passed, so the screen should refetch once. The
 * clock only triggers a refetch; the server's answer decides what is shown.
 */
export function needsEndRefetch(
  sheet: Pick<AttendanceSheet, 'status' | 'ended'>,
  session: Pick<TrainingSession, 'starts_at' | 'ends_at'>,
  now: Date,
  sheetLoadedAt: number,
): boolean {
  return (
    sheet.status === 'confirmed' &&
    !sheet.ended &&
    deviceSaysEnded(session, now) &&
    !sheetLoadedAfterEnd(session, sheetLoadedAt)
  );
}

/** True when the sheet was read at or after the session's end time (so a "not ended" answer is current). */
export function sheetLoadedAfterEnd(
  session: Pick<TrainingSession, 'starts_at' | 'ends_at'>,
  sheetLoadedAt: number,
): boolean {
  return sheetLoadedAt >= endMs(session);
}

/**
 * Whether "Mark all present" may still touch a row when its turn comes: the
 * row exists, is still unrecorded, and no other change for it is being saved.
 */
export function canMarkAllRow(
  entry: Pick<AttendanceSheetEntry, 'attendance_status'> | undefined,
  rowPending: boolean,
): boolean {
  return entry !== undefined && entry.attendance_status === 'unrecorded' && !rowPending;
}

