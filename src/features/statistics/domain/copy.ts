/**
 * Fixed wording for the Statistics tab. It follows docs/STATS_DEFINITIONS.md:
 * a session nobody marked is "Not recorded", never an absence or a miss.
 */
export const EMPTY_STATS =
  'No finalized trainings yet. Statistics appear after attendance is finalized.';

export const NOT_RECORDED_NOTE =
  'Not recorded means nobody marked the attendance for that training. It is not counted as an absence, but it is included when the rate is calculated, so the rate can be lower than the real turnout.';

export const RATE_NOTE = 'Attended divided by all finalized trainings eligible in this period.';

export const RELIABILITY_HELP =
  'Of the trainings where going was the answer and attendance was recorded, how many were attended. Not recorded trainings are left out, so missing data never counts against anyone.';

export const MISSED_HELP = 'Said going, then marked absent. Not recorded is never a miss.';

export const WALK_INS_HELP = 'Attended without having said going.';

export const CONVERSION_HELP =
  'Of the going answers with a recorded outcome, how many came. Not recorded outcomes are left out.';

export const HISTORY_EMPTY = 'No finalized trainings in this period yet.';

export const MEMBER_LIST_NOTE =
  'A rate is attended divided by all of the member’s finalized trainings in the selected period. Trainings with no attendance recorded are not counted as absences, but they are included in that total, so a rate can be lower than the real turnout.';

/** "n sessions had no attendance marked and are excluded." */
export function incompleteNote(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  const n = Math.trunc(count);
  return n === 1
    ? '1 session had no attendance marked and is excluded.'
    : `${n} sessions had no attendance marked and are excluded.`;
}

export function truncatedNote(listed: number, total: number): string | null {
  if (!Number.isFinite(listed) || !Number.isFinite(total) || total <= listed) return null;
  return `Showing the first ${listed} of ${total} members.`;
}
