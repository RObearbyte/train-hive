/**
 * View model of the community switcher: what each row shows. Pure, so the
 * rules ("a single community shows no switcher", "the active one is checked")
 * are tested without rendering anything.
 */
import type { MyCommunity } from '@/lib/database.types';
import { isValidTimeZone, zoneCityName } from '@/lib/datetime';

import { localTimeSummary } from './timezones';

export type SwitcherItem = {
  id: string;
  name: string;
  roleLabel: 'Organizer' | 'Member';
  /** "Bucharest, 14:32 (UTC+02:00)" */
  timezoneLabel: string;
  isActive: boolean;
  accessibilityLabel: string;
};

/** The header title only opens a switcher when there is something to switch to. */
export function canSwitchCommunity(communities: readonly unknown[]): boolean {
  return communities.length > 1;
}

export function buildSwitcherItems(
  communities: readonly MyCommunity[],
  activeId: string | null,
  now: Date,
): SwitcherItem[] {
  return communities.map((item) => {
    const isActive = item.community_id === activeId;
    const roleLabel = item.role === 'organizer' ? 'Organizer' : 'Member';
    const timezoneLabel = isValidTimeZone(item.timezone)
      ? `${zoneCityName(item.timezone)}, ${localTimeSummary(item.timezone, now)}`
      : item.timezone;
    return {
      id: item.community_id,
      name: item.name,
      roleLabel,
      timezoneLabel,
      isActive,
      accessibilityLabel: `${item.name}, ${roleLabel}, ${timezoneLabel}${isActive ? ', current community' : ''}`,
    };
  });
}
