/**
 * Rules of the organizer's Members screen and of leaving a community. Pure,
 * so they are unit tested. The server authorizes every action again
 * (`set_member_role`, `remove_member`, `leave_community`); this decides only
 * what the screen offers and how failures read.
 */
import type { MembershipRole, MembershipStatus, MyCommunity } from '@/lib/database.types';
import { toAppError, userMessage } from '@/lib/errors';

export type RosterEntry = {
  membershipId: string;
  userId: string;
  /** Null when the name cannot be read (people who left or were removed are not visible to others). */
  displayName: string | null;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: string;
};

export const FORMER_MEMBER_NAME = 'Former member';
export const FALLBACK_MEMBER_NAME = 'Member';

/** The name to show for a row. */
export function rosterName(entry: Pick<RosterEntry, 'displayName' | 'status'>): string {
  if (entry.displayName !== null && entry.displayName.trim() !== '') return entry.displayName;
  return entry.status === 'removed' ? FORMER_MEMBER_NAME : FALLBACK_MEMBER_NAME;
}

const byName = (a: RosterEntry, b: RosterEntry) =>
  rosterName(a).localeCompare(rosterName(b), 'en', { sensitivity: 'base' }) ||
  (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

/** Active members by name (organizers are marked by a badge, not moved); former ones, newest joiner first. */
export function splitRoster(entries: readonly RosterEntry[]): { active: RosterEntry[]; former: RosterEntry[] } {
  const active = entries.filter((entry) => entry.status === 'active').sort(byName);
  const former = entries
    .filter((entry) => entry.status !== 'active')
    .sort((a, b) => (a.joinedAt < b.joinedAt ? 1 : a.joinedAt > b.joinedAt ? -1 : byName(a, b)));
  return { active, former };
}

export type MemberAction = 'make_organizer' | 'make_member' | 'remove';

/**
 * What an organizer may do with a row. Nothing for oneself (the server refuses
 * `cannot_change_own_role` / `cannot_remove_self`; leaving is done from the
 * profile) and nothing for people who are already removed.
 */
export function availableActions(entry: RosterEntry, selfUserId: string | null): MemberAction[] {
  if (entry.status !== 'active') return [];
  if (selfUserId !== null && entry.userId === selfUserId) return [];
  return [entry.role === 'organizer' ? 'make_member' : 'make_organizer', 'remove'];
}

export const ACTION_LABELS: Record<MemberAction, string> = {
  make_organizer: 'Make organizer',
  make_member: 'Make member',
  remove: 'Remove from community',
};

export type ActionConfirmation = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
};

/** The confirmation text: what the action does to the person and what it leaves alone. */
export function actionConfirmation(action: MemberAction, name: string, communityName: string): ActionConfirmation {
  switch (action) {
    case 'make_organizer':
      return {
        title: `Make ${name} an organizer?`,
        message: `${name} will be able to create and edit trainings and announcements, record attendance, manage invitation codes and change members' roles in ${communityName}. You can change this back at any time.`,
        confirmLabel: 'Make organizer',
        cancelLabel: 'Cancel',
        destructive: false,
      };
    case 'make_member':
      return {
        title: `Make ${name} a regular member?`,
        message: `${name} will no longer be able to organize in ${communityName}: no editing trainings or announcements, attendance, invitation codes or roles.`,
        confirmLabel: 'Make member',
        cancelLabel: 'Cancel',
        destructive: false,
      };
    case 'remove':
      return {
        title: `Remove ${name} from ${communityName}?`,
        message: `${name} loses access to ${communityName} and cannot rejoin with an invitation code. Their answers on trainings that are still open are released. Their attendance history stays in the community's records.`,
        confirmLabel: 'Remove',
        cancelLabel: 'Keep member',
        destructive: true,
      };
  }
}

/** Friendly text for a failed member action. */
export function memberActionErrorMessage(error: unknown): string {
  const appError = toAppError(error);
  return userMessage(appError.code, appError.field);
}

export const LEAVE_TITLE = (communityName: string) => `Leave ${communityName}?`;

export const LEAVE_MESSAGE =
  'You lose access to this community and cannot rejoin with an invitation code: you would need an organizer to invite you again. Your answers on trainings that are still open are released. Your attendance history stays in the community’s records.';

/** Friendly text for a failed `leave_community`; the last organizer is pointed to the Members screen. */
export function leaveErrorMessage(error: unknown): string {
  const appError = toAppError(error);
  if (appError.code === 'last_organizer') {
    return 'You are the only organizer of this community and it still has other members. Make another member an organizer on the Members screen first, then leave.';
  }
  return userMessage(appError.code, appError.field);
}

/** True when the leave failed because the person must hand over first (offer the Members screen). */
export function leaveNeedsHandover(error: unknown): boolean {
  return toAppError(error).code === 'last_organizer';
}

/** My communities without the one just left. Ids are compared case-insensitively. */
export function withoutCommunity(communities: readonly MyCommunity[], leftId: string): MyCommunity[] {
  const left = leftId.toLowerCase();
  return communities.filter((item) => item.community_id.toLowerCase() !== left);
}
