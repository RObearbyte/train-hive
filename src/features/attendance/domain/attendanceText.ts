/**
 * The attendance list as plain text for copying or sharing (an organizer pasting it into a chat or a
 * spreadsheet). Pure. Groups by status, sorted by name; walk-ins are marked. Nothing but display names
 * and the event's title and time is included.
 */
import type { AttendanceSheetEntry } from '@/lib/database.types';

import { countEntries, countsText, sortEntries } from './sheet';

const GROUPS = [
  ['present', 'Present'],
  ['absent', 'Absent'],
  ['unrecorded', 'Not recorded'],
] as const;

export function attendanceListText(input: {
  title: string | null;
  when: string | null;
  entries: readonly AttendanceSheetEntry[];
}): string {
  const lines: string[] = [];
  lines.push(input.title ? `Attendance: ${input.title}` : 'Attendance');
  if (input.when) lines.push(input.when);
  lines.push(countsText(countEntries(input.entries)));

  const sorted = sortEntries(input.entries);
  for (const [status, label] of GROUPS) {
    const group = sorted.filter((entry) => entry.attendance_status === status);
    if (group.length === 0) continue;
    lines.push('', `${label} (${group.length})`);
    for (const entry of group) lines.push(`- ${entry.display_name}${entry.is_walk_in ? ' (walk-in)' : ''}`);
  }
  return lines.join('\n');
}
