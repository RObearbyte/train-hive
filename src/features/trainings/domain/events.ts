/**
 * Event kinds and subtypes: labels, the subtype lists, which kinds carry a
 * minimum, which subtypes carry course facts, the kind filter and the course
 * line ("21.1 km · D+ 450 m · 12 obstacles").
 *
 * The subtype list lives in the `event_subtypes` table (extensible). The
 * bundled list below is the same data the migration seeds; it is the fallback
 * until the table is loaded and the label source for unknown keys.
 */
import type { EventKind } from '@/lib/database.types';
import type { IconName } from '@/ui/theme/status';

export const EVENT_KINDS: readonly EventKind[] = ['training', 'race', 'sports_event', 'social'];

export type KindInfo = {
  kind: EventKind;
  /** Singular name: "Sports event". */
  label: string;
  /** Plural, for the list filter: "Sports events". */
  plural: string;
  description: string;
  icon: IconName;
};

const KIND_INFO: Record<EventKind, KindInfo> = {
  training: {
    kind: 'training',
    label: 'Training',
    plural: 'Trainings',
    description: 'A regular session. Confirmed once enough people sign up.',
    icon: 'person',
  },
  race: {
    kind: 'race',
    label: 'Race',
    plural: 'Races',
    description: 'A timed run or obstacle race with a course.',
    icon: 'flag',
  },
  sports_event: {
    kind: 'sports_event',
    label: 'Sports event',
    plural: 'Sports events',
    description: 'A competition, open training or other sports meet-up.',
    icon: 'trophy',
  },
  social: {
    kind: 'social',
    label: 'Social event',
    plural: 'Social events',
    description: 'A get-together off the track.',
    icon: 'people',
  },
};

export function kindInfo(kind: EventKind): KindInfo {
  return KIND_INFO[kind];
}

export function kindLabel(kind: EventKind): string {
  return KIND_INFO[kind].label;
}

export function isTraining(kind: EventKind): boolean {
  return kind === 'training';
}

export type SubtypeOption = { key: string; label: string };

const FALLBACK_SUBTYPES: Record<EventKind, readonly SubtypeOption[]> = {
  training: [
    { key: 'running', label: 'Running' },
    { key: 'trail_running', label: 'Trail running' },
    { key: 'strength', label: 'Strength' },
    { key: 'functional_fitness', label: 'Functional fitness' },
    { key: 'ocr', label: 'OCR' },
    { key: 'other', label: 'Other' },
  ],
  race: [
    { key: 'trail_running', label: 'Trail running' },
    { key: 'asphalt_running', label: 'Asphalt running' },
    { key: 'ocr', label: 'OCR' },
  ],
  sports_event: [
    { key: 'crossfit_event', label: 'CrossFit event' },
    { key: 'public_training', label: 'Public training' },
    { key: 'other', label: 'Other' },
  ],
  social: [
    { key: 'social_gathering', label: 'Social gathering' },
    { key: 'other', label: 'Other' },
  ],
};

/** The bundled subtypes of a kind, in display order. */
export function fallbackSubtypes(kind: EventKind): SubtypeOption[] {
  return FALLBACK_SUBTYPES[kind].map((option) => ({ ...option }));
}

/** The subtype preselected for a kind in the create flow. */
export const DEFAULT_SUBTYPE: Record<EventKind, string> = {
  training: 'running',
  race: 'trail_running',
  sports_event: 'other',
  social: 'social_gathering',
};

export function defaultSubtype(kind: EventKind): string {
  return DEFAULT_SUBTYPE[kind];
}

type SubtypeRow = { kind: EventKind; key: string; label: string; sort_order: number };

/** "stand_up_paddle" → "Stand up paddle". */
function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (words === '') return 'Other';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Options for one kind: the loaded `event_subtypes` rows when there are any
 * for that kind, the bundled list otherwise. `selected` is always among them,
 * so editing an event with a subtype this list lacks never changes it silently.
 */
export function subtypeOptions(
  kind: EventKind,
  rows: readonly SubtypeRow[] | undefined,
  selected = '',
): SubtypeOption[] {
  const loaded = (rows ?? [])
    .filter((row) => row.kind === kind)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((row) => ({ key: row.key, label: row.label }));
  const options = loaded.length > 0 ? loaded : fallbackSubtypes(kind);
  if (selected !== '' && !options.some((option) => option.key === selected)) {
    options.push({ key: selected, label: humanizeKey(selected) });
  }
  return options;
}

/** Label for a subtype: the loaded row, else the bundled one, else derived from the key. */
export function subtypeLabel(
  kind: EventKind,
  key: string | null | undefined,
  rows?: readonly SubtypeRow[],
): string {
  if (key === null || key === undefined || key === '') return 'Other';
  const loaded = rows?.find((row) => row.kind === kind && row.key === key);
  if (loaded) return loaded.label;
  const bundled = FALLBACK_SUBTYPES[kind].find((option) => option.key === key);
  return bundled ? bundled.label : humanizeKey(key);
}

// --- Course facts -----------------------------------------------------------

const RUNNING_SUBTYPES: ReadonlySet<string> = new Set([
  'running',
  'trail_running',
  'asphalt_running',
  'ocr',
]);

/** Distance and D+ apply to these subtypes (any kind). */
export function takesCourse(subtype: string): boolean {
  return RUNNING_SUBTYPES.has(subtype);
}

/** Obstacles apply to OCR only. */
export function takesObstacles(subtype: string): boolean {
  return subtype === 'ocr';
}

export type CourseFields = {
  distance_km: number | null;
  elevation_gain_m: number | null;
  obstacle_count: number | null;
};

function formatNumber(value: number, locale: string | undefined, maxFractionDigits: number): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: maxFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

/** "21.1" (or "21,1" in a comma locale), at most 2 decimals, no trailing zeros. */
export function formatDistanceKm(km: number, locale?: string): string {
  return formatNumber(km, locale, 2);
}

/**
 * The course parts that are set, in order: ["21.1 km", "D+ 450 m", "12 obstacles"].
 * Empty when there is nothing to show.
 */
export function courseParts(event: CourseFields, locale?: string): string[] {
  const parts: string[] = [];
  if (event.distance_km !== null) parts.push(`${formatDistanceKm(event.distance_km, locale)} km`);
  if (event.elevation_gain_m !== null) {
    parts.push(`D+ ${formatNumber(event.elevation_gain_m, locale, 0)} m`);
  }
  if (event.obstacle_count !== null) {
    parts.push(`${event.obstacle_count} ${event.obstacle_count === 1 ? 'obstacle' : 'obstacles'}`);
  }
  return parts;
}

/** One line, or null when there are no course facts. */
export function courseLine(event: CourseFields, locale?: string): string | null {
  const parts = courseParts(event, locale);
  return parts.length === 0 ? null : parts.join(' · ');
}

// --- Kind filter ------------------------------------------------------------

export type KindFilter = 'all' | EventKind;

export const KIND_FILTER_OPTIONS: readonly { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'training', label: 'Trainings' },
  { value: 'race', label: 'Races' },
  { value: 'sports_event', label: 'Sports' },
  { value: 'social', label: 'Social' },
];

/** Keeps the events of one kind ("all" keeps everything). Does not mutate the input. */
export function filterByKind<T extends { event_kind: EventKind }>(
  events: readonly T[],
  filter: KindFilter,
): T[] {
  return filter === 'all' ? [...events] : events.filter((event) => event.event_kind === filter);
}
