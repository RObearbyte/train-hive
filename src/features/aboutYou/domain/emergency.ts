/**
 * The organizers' view of members' emergency contact and T-shirt size: shape
 * checks, display text and the plain-text list to copy. Pure TypeScript.
 */
import type { CommunityEmergencyList, MemberEmergencyInfo } from '@/lib/database.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';

export function isMemberEmergencyInfo(value: unknown): value is MemberEmergencyInfo {
  return (
    isRecord(value) &&
    typeof value.user_id === 'string' &&
    typeof value.display_name === 'string' &&
    nullableString(value.emergency_contact_name) &&
    nullableString(value.emergency_contact_phone) &&
    nullableString(value.emergency_contact_relationship) &&
    nullableString(value.tshirt_size) &&
    typeof value.has_emergency_contact === 'boolean'
  );
}

export function isCommunityEmergencyList(value: unknown): value is CommunityEmergencyList {
  return (
    isRecord(value) &&
    typeof value.community_id === 'string' &&
    typeof value.truncated === 'boolean' &&
    Array.isArray(value.members) &&
    value.members.every(isMemberEmergencyInfo)
  );
}

/** Whether the member shared anything an organizer may see. */
export function hasSharedInfo(info: Pick<MemberEmergencyInfo, 'has_emergency_contact' | 'tshirt_size'>): boolean {
  return info.has_emergency_contact || info.tshirt_size !== null;
}

/** "Ion Pop (brother)" or just the name. Null when there is no contact. */
export function contactSummary(
  info: Pick<MemberEmergencyInfo, 'emergency_contact_name' | 'emergency_contact_relationship'>,
): string | null {
  if (info.emergency_contact_name === null) return null;
  return info.emergency_contact_relationship === null
    ? info.emergency_contact_name
    : `${info.emergency_contact_name} (${info.emergency_contact_relationship})`;
}

/**
 * A `tel:` link for a phone number: only digits and a leading + are kept, so
 * nothing else the person typed can end up in the link. Null when there are no digits.
 */
export function telHref(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits === '') return null;
  return `tel:${phone.trim().startsWith('+') ? '+' : ''}${digits}`;
}

/** Spoken label for one member's shared details. */
export function infoAccessibilityLabel(info: MemberEmergencyInfo): string {
  if (!hasSharedInfo(info)) return `${info.display_name}: nothing shared`;
  const parts = [info.display_name];
  const contact = contactSummary(info);
  if (contact !== null) parts.push(`emergency contact ${contact}`);
  if (info.emergency_contact_phone !== null) parts.push(`phone ${info.emergency_contact_phone}`);
  if (info.tshirt_size !== null) parts.push(`T-shirt size ${info.tshirt_size}`);
  return parts.join(', ');
}

/**
 * The list as plain text for Copy / Share. Display only: it prints what the
 * server returned (so only members who agreed), never anything else.
 */
export function emergencyListText(list: CommunityEmergencyList, communityName: string): string {
  const lines: string[] = [
    `Emergency contacts and T-shirt sizes: ${communityName}`,
    `${list.members.length} ${list.members.length === 1 ? 'member' : 'members'} shared details.`,
  ];
  for (const member of list.members) {
    lines.push('');
    lines.push(member.display_name);
    const contact = contactSummary(member);
    lines.push(
      contact === null
        ? '  Emergency contact: none'
        : `  Emergency contact: ${contact}${member.emergency_contact_phone ? `, ${member.emergency_contact_phone}` : ''}`,
    );
    lines.push(`  T-shirt size: ${member.tshirt_size ?? 'not given'}`);
  }
  if (list.truncated) {
    lines.push('');
    lines.push('The list was cut at 500 members.');
  }
  return lines.join('\n');
}
