/**
 * The edit-conflict guard of the community settings form (O6). The form
 * remembers the row it was loaded from (the baseline) and sends its
 * `updated_at` with every save; the server answers `stale_data` when someone
 * else saved in between. Pure.
 */
import type { Community } from '@/lib/database.types';

export type SettingsBaseline = {
  /** Sent as `p_expected_updated_at`; null only if the row carried none (the server then does last-write-wins). */
  updatedAt: string | null;
  name: string;
  timezone: string;
};

export type SettingsValues = { name: string; timezone: string };

type CommunityRow = Pick<Community, 'name' | 'timezone' | 'updated_at'>;

/** The baseline for a community row: what the form is prefilled from. */
export function baselineFrom(community: CommunityRow): SettingsBaseline {
  return { updatedAt: community.updated_at ?? null, name: community.name, timezone: community.timezone };
}

/** True when the submitted values differ from the baseline (nothing to save otherwise). */
export function hasSettingsChanges(values: SettingsValues, baseline: SettingsBaseline): boolean {
  return values.name !== baseline.name || values.timezone !== baseline.timezone;
}

/**
 * After a conflict: the baseline moves to the latest row (so the next save is
 * checked against it) while the typed values stay as they are. Also says
 * whether the typed values still differ from the latest ones.
 */
export function resolveConflict(
  latest: CommunityRow,
  typed: SettingsValues,
): { baseline: SettingsBaseline; typedDiffers: boolean } {
  const baseline = baselineFrom(latest);
  return { baseline, typedDiffers: hasSettingsChanges(typed, baseline) };
}
