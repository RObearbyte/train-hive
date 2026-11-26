/**
 * Personal records: the post-save "max effort?" question and the Personal bests page.
 * Pure TypeScript (no react-native). The server computes and stores everything
 * (docs/API_CONTRACT.md "Personal records", docs/STATS_DEFINITIONS.md "Personal records");
 * this file only words and checks what it returns. Records are personal data: nothing here logs them.
 */
import type {
  LiftKey,
  LiftRecord,
  LongestRun,
  MaxEffortCandidate,
  MaxEffortCandidates,
  MaxEffortConfirmation,
  PersonalRecords,
  RunningBest,
  RunningBests,
} from '@/lib/database.types';
import { toAppError, userMessage } from '@/lib/errors';

import { formatKm, formatPace, formatWeight } from './workoutLog';

const pad2 = (n: number) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// The max-effort question
// ---------------------------------------------------------------------------

/** "1 rep", "3 reps". */
export function repsText(reps: number): string {
  return `${reps} ${reps === 1 ? 'rep' : 'reps'}`;
}

/** "1RM", "2RM", "3RM". */
export function repMaxLabel(reps: number): string {
  return `${reps}RM`;
}

/** "Back squat, 3 reps at 100 kg". */
export function candidateTitle(candidate: Pick<MaxEffortCandidate, 'label' | 'reps' | 'weight_kg'>): string {
  return `${candidate.label}, ${repsText(candidate.reps)} at ${formatWeight(candidate.weight_kg)} kg`;
}

export const MAX_EFFORT_QUESTION = 'Was this a maximal effort?';

/** Stable id of a candidate within one log. */
export function candidateId(candidate: Pick<MaxEffortCandidate, 'lift' | 'reps'>): string {
  return `${candidate.lift}:${candidate.reps}`;
}

/** The candidate is confirmed with exactly the weight it shows. */
export function isConfirmedAsShown(candidate: MaxEffortCandidate): boolean {
  return candidate.confirmed && candidate.confirmed_weight_kg === candidate.weight_kg;
}

/** Ask after a save only when at least one candidate has no answer stored yet. */
export function needsMaxEffortQuestion(data: MaxEffortCandidates | null | undefined): boolean {
  return !!data && data.candidates.some((candidate) => !isConfirmedAsShown(candidate));
}

/** One line under a candidate: how it compares with the best confirmed set of other events. */
export function candidateRecordNote(candidate: MaxEffortCandidate): string {
  const rm = `${repMaxLabel(candidate.reps)} ${candidate.label.toLowerCase()}`;
  if (candidate.previous_best_kg === null) return `Your first confirmed ${rm} would be a record.`;
  const previous = `${formatWeight(candidate.previous_best_kg)} kg`;
  if (candidate.is_new_record) return `Your best ${rm} so far is ${previous}: this would be a new record.`;
  return `Your best ${rm} is ${previous}.`;
}

/** The celebration text after a confirmation that is (or keeps) the record. */
export function newRecordMessage(candidate: Pick<MaxEffortCandidate, 'label' | 'reps' | 'weight_kg'>): string {
  return `New record! ${candidate.label} ${repMaxLabel(candidate.reps)}: ${formatWeight(candidate.weight_kg)} kg.`;
}

export const MAX_EFFORT_INTRO =
  'Only sets you confirm as a maximal effort count as lift records. Answer No if you could have lifted more.';

export const MAX_EFFORT_NO_CONSENT =
  'Confirming a maximal effort needs your agreement to workout logs. Agree on this page by saving the log with the box ticked, then try again.';

/** Friendly text for a failed confirmation (or a failed load of the question). */
export function maxEffortErrorMessage(error: unknown): string {
  const appError = toAppError(error);
  if (appError.code === 'consent_required' && appError.field === 'workout_logs') return MAX_EFFORT_NO_CONSENT;
  if (appError.code === 'not_found') return 'This workout log no longer exists. It may have been deleted.';
  return userMessage(appError.code, appError.field);
}

/** The candidate list after a confirmation answer from the server (the rest is unchanged). */
export function applyConfirmation(data: MaxEffortCandidates, result: MaxEffortConfirmation): MaxEffortCandidates {
  return {
    ...data,
    candidates: data.candidates.map((candidate) =>
      candidate.lift === result.lift && candidate.reps === result.reps
        ? {
            ...candidate,
            confirmed: result.confirmed,
            confirmed_weight_kg: result.confirmed ? result.weight_kg : null,
            is_new_record: result.confirmed ? result.is_new_record : candidate.is_new_record,
          }
        : candidate,
    ),
  };
}

// ---------------------------------------------------------------------------
// Personal bests page
// ---------------------------------------------------------------------------

/** A record time: "24:35" under an hour, "3:25:10" from an hour. */
export function formatRecordTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** The same time for a screen reader: "3 hours 25 minutes 10 seconds". */
export function spokenRecordTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const parts: [number, string][] = [
    [Math.floor(total / 3600), 'hour'],
    [Math.floor((total % 3600) / 60), 'minute'],
    [total % 60, 'second'],
  ];
  const words = parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`);
  return words.length === 0 ? '0 seconds' : words.join(' ');
}

export type RunningKey = 'best_5k' | 'best_10k' | 'best_half' | 'best_marathon';

export const RUNNING_DISTANCES: readonly { key: RunningKey; label: string }[] = [
  { key: 'best_5k', label: '5 km' },
  { key: 'best_10k', label: '10 km' },
  { key: 'best_half', label: 'Half marathon' },
  { key: 'best_marathon', label: 'Marathon' },
];

export type RunningRow = {
  key: RunningKey | 'longest';
  label: string;
  /** The record ("24:35", "42.4 km") or "—". */
  value: string;
  /** "5:00 /km" (or the time and pace of the longest run); null without a record. */
  detail: string | null;
  spoken: string;
  record: RunningBest | LongestRun | null;
};

function runningRow(key: RunningKey, label: string, best: RunningBest | null): RunningRow {
  if (best === null) return { key, label, value: '—', detail: null, spoken: `${label}: no record yet`, record: null };
  const pace = formatPace(best.pace_s_per_km);
  return {
    key,
    label,
    value: formatRecordTime(best.time_s),
    detail: pace,
    spoken: `${label}: ${spokenRecordTime(best.time_s)}, pace ${pace.replace(' /km', ' per kilometre')}`,
    record: best,
  };
}

function longestRow(longest: LongestRun | null): RunningRow {
  const label = 'Longest distance';
  if (longest === null) return { key: 'longest', label, value: '—', detail: null, spoken: `${label}: no record yet`, record: null };
  const value = `${formatKm(Math.round(longest.distance_m))} km`;
  const detail =
    longest.duration_s === null
      ? null
      : `${formatRecordTime(longest.duration_s)}${longest.pace_s_per_km === null ? '' : `, ${formatPace(longest.pace_s_per_km)}`}`;
  const spokenTime = longest.duration_s === null ? '' : `, in ${spokenRecordTime(longest.duration_s)}`;
  return { key: 'longest', label, value, detail, spoken: `${label}: ${value}${spokenTime}`, record: longest };
}

/** The running part of the page: four distances, then the longest run. */
export function runningRows(running: RunningBests): RunningRow[] {
  return [
    ...RUNNING_DISTANCES.map(({ key, label }) => runningRow(key, label, running[key])),
    longestRow(running.longest),
  ];
}

export type LiftCell = { reps: 1 | 2 | 3; label: string; value: string; record: LiftRecord | null };
export type LiftRow = { lift: LiftKey; label: string; cells: LiftCell[]; spoken: string };

/** One row per lift (always six, in the server's order) with 1RM, 2RM and 3RM, "—" when none. */
export function liftRows(records: PersonalRecords, dateText: (iso: string) => string): LiftRow[] {
  return records.lifts.map((lift) => {
    const cells: LiftCell[] = (
      [
        [1, lift.one_rm],
        [2, lift.two_rm],
        [3, lift.three_rm],
      ] as const
    ).map(([reps, record]) => ({
      reps,
      label: repMaxLabel(reps),
      value: record ? `${formatWeight(record.weight_kg)} kg` : '—',
      record,
    }));
    const spoken = cells
      .map((cell) => (cell.record ? `${cell.label} ${cell.value}, ${dateText(cell.record.achieved_at)}` : `${cell.label} none`))
      .join('; ');
    return { lift: lift.lift, label: lift.label, cells, spoken: `${lift.label}: ${spoken}` };
  });
}

export function hasRunningRecords(running: RunningBests): boolean {
  return RUNNING_DISTANCES.some(({ key }) => running[key] !== null) || running.longest !== null;
}

export function hasLiftRecords(records: PersonalRecords): boolean {
  return records.lifts.some((lift) => lift.one_rm !== null || lift.two_rm !== null || lift.three_rm !== null);
}

/** Short lines for the Statistics card: the records that exist, running first, at most `max`. */
export function highlightLines(records: PersonalRecords, max = 5): { key: string; label: string; value: string }[] {
  const lines: { key: string; label: string; value: string }[] = [];
  for (const row of runningRows(records.running)) {
    if (row.record !== null) lines.push({ key: row.key, label: row.label, value: row.value });
  }
  for (const lift of records.lifts) {
    const best = lift.one_rm ? 1 : lift.two_rm ? 2 : lift.three_rm ? 3 : null;
    const record = lift.one_rm ?? lift.two_rm ?? lift.three_rm;
    if (best !== null && record) {
      lines.push({ key: lift.lift, label: `${lift.label} ${repMaxLabel(best)}`, value: `${formatWeight(record.weight_kg)} kg` });
    }
  }
  return lines.slice(0, max);
}

export const RUNNING_RECORDS_HELP =
  'Running bests come from your run and race logs that have a time. A log counts for a distance when it is that distance or up to 5% longer (a 5.2 km run counts for 5 km), and its time is scaled to exactly that distance. A shorter run never counts.';

export const LIFT_RECORDS_HELP =
  'Lift records come only from sets you confirmed as a maximal effort: 1, 2 or 3 reps of Deadlift, Bench press, Back squat, Front squat, Strict press or Push press with a weight. After you save a strength log, TrainHive asks about those sets.';

export const RECORDS_PRIVACY_NOTE =
  'Your own entries, private to you. Organizers never see them. Deleting a log, or withdrawing your agreement to workout logs, removes its records.';

// ---------------------------------------------------------------------------
// Shape checks of server answers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isNumberOrNull = (value: unknown): boolean => value === null || typeof value === 'number';

function isCandidate(value: unknown): value is MaxEffortCandidate {
  return (
    isRecord(value) &&
    typeof value.lift === 'string' &&
    typeof value.label === 'string' &&
    (value.reps === 1 || value.reps === 2 || value.reps === 3) &&
    typeof value.weight_kg === 'number' &&
    typeof value.confirmed === 'boolean' &&
    isNumberOrNull(value.confirmed_weight_kg) &&
    isNumberOrNull(value.previous_best_kg) &&
    typeof value.is_new_record === 'boolean'
  );
}

export function isMaxEffortCandidates(value: unknown): value is MaxEffortCandidates {
  return (
    isRecord(value) &&
    typeof value.session_id === 'string' &&
    typeof value.has_consent === 'boolean' &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isCandidate)
  );
}

export function isMaxEffortConfirmation(value: unknown): value is MaxEffortConfirmation {
  return (
    isRecord(value) &&
    typeof value.lift === 'string' &&
    typeof value.reps === 'number' &&
    typeof value.weight_kg === 'number' &&
    typeof value.confirmed === 'boolean' &&
    typeof value.is_new_record === 'boolean'
  );
}

function isRunningBest(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.time_s === 'number' &&
      typeof value.pace_s_per_km === 'number' &&
      typeof value.session_id === 'string' &&
      typeof value.event_title === 'string' &&
      typeof value.event_starts_at === 'string')
  );
}

function isLongestRun(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.distance_m === 'number' &&
      isNumberOrNull(value.duration_s) &&
      isNumberOrNull(value.pace_s_per_km) &&
      typeof value.session_id === 'string' &&
      typeof value.event_title === 'string' &&
      typeof value.event_starts_at === 'string')
  );
}

function isLiftRecord(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.weight_kg === 'number' &&
      typeof value.session_id === 'string' &&
      typeof value.event_title === 'string' &&
      typeof value.achieved_at === 'string')
  );
}

export function isPersonalRecords(value: unknown): value is PersonalRecords {
  if (!isRecord(value) || !isRecord(value.running) || !Array.isArray(value.lifts)) return false;
  const running = value.running;
  return (
    isRunningBest(running.best_5k) &&
    isRunningBest(running.best_10k) &&
    isRunningBest(running.best_half) &&
    isRunningBest(running.best_marathon) &&
    isLongestRun(running.longest) &&
    value.lifts.every(
      (lift) =>
        isRecord(lift) &&
        typeof lift.lift === 'string' &&
        typeof lift.label === 'string' &&
        isLiftRecord(lift.one_rm) &&
        isLiftRecord(lift.two_rm) &&
        isLiftRecord(lift.three_rm),
    )
  );
}
