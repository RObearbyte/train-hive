/**
 * What the Community tab shows. Pure, so the rules (members never see
 * organizer controls, the counts read right) are unit tested.
 */

export function memberCountText(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return n === 1 ? '1 member' : `${n} members`;
}

export type CommunityTabSections = {
  /** Everyone: current community, switcher, member list, leave. */
  community: true;
  /** Organizers only: invitations, settings, announcements, emergency list. */
  management: boolean;
};

export function communityTabSections(isOrganizer: boolean): CommunityTabSections {
  return { community: true, management: isOrganizer };
}

export type ManagementLink = {
  key: 'invite' | 'settings' | 'new-announcement' | 'announcements' | 'members' | 'statistics';
  title: string;
  subtitle: string;
  href: string;
};

/** The organizer shortcuts, in order. The routes keep working as pushes from the tab. */
export const MANAGEMENT_LINKS: readonly ManagementLink[] = [
  { key: 'invite', title: 'Invite members', subtitle: 'Invitation codes: create, share and revoke', href: '/invitations' },
  { key: 'settings', title: 'Community settings', subtitle: 'Change the name and time zone', href: '/community-settings' },
  { key: 'new-announcement', title: 'New announcement', subtitle: 'Write to every member', href: '/announcements/new' },
  { key: 'announcements', title: 'All announcements', subtitle: 'Edit, schedule or cancel', href: '/announcements' },
  { key: 'members', title: 'Manage members', subtitle: 'Former members and the full roster', href: '/members' },
  { key: 'statistics', title: 'Community statistics', subtitle: 'Attendance and participation', href: '/statistics' },
];

export function managementLinks(isOrganizer: boolean): readonly ManagementLink[] {
  return isOrganizer ? MANAGEMENT_LINKS : [];
}

/** Bottom tab label size (dp). 11 dp semibold averages about 5.9 dp per character. */
export const TAB_LABEL_FONT_SIZE = 11;
export const TAB_LABEL_CHAR_WIDTH = 5.9;

/** Tab-bar label fit: every label must fit its slot, so six tabs stay readable on a 360dp phone. */
export function tabLabelFits(labels: readonly string[], screenWidthDp: number, charWidthDp = TAB_LABEL_CHAR_WIDTH): boolean {
  const slot = screenWidthDp / labels.length;
  return labels.every((label) => label.length * charWidthDp <= slot);
}
