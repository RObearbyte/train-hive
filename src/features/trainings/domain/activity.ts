/**
 * Labels for activity type keys. The keys are rows in `activity_types`, so a
 * key this build does not know can appear at any time: it gets a readable
 * label derived from the key instead of failing.
 */

export const DEFAULT_ACTIVITY_TYPE = 'other';

const LABELS = {
  running: 'Running',
  trail_running: 'Trail running',
  strength: 'Strength',
  functional_fitness: 'Functional fitness',
  ocr: 'OCR',
  other: 'Other',
} as const;

export type KnownActivityType = keyof typeof LABELS;

/** Seeded keys, in display order. */
export const ACTIVITY_TYPE_KEYS = Object.keys(LABELS) as KnownActivityType[];

export function isKnownActivityType(key: string): key is KnownActivityType {
  return Object.hasOwn(LABELS, key);
}

/** "trail_running" → "Trail running"; unknown "stand_up_paddle" → "Stand up paddle". */
export function activityLabel(key: string | null | undefined): string {
  if (key === null || key === undefined) return LABELS.other;
  if (isKnownActivityType(key)) return LABELS[key];
  const words = key.replace(/[_-]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (words === '') return LABELS.other;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Options for a picker: `{ key, label }` for every seeded type. */
export function activityOptions(): { key: KnownActivityType; label: string }[] {
  return ACTIVITY_TYPE_KEYS.map((key) => ({ key, label: LABELS[key] }));
}
