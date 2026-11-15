/**
 * The friendly, plain-text message an organizer sends to invite someone.
 * Pure: `now` and the time zone are injected, nothing reads the clock.
 */
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

import { formatInvitationCode } from '@/features/onboarding/domain/invitationCode';
import { isValidTimeZone } from '@/lib/datetime';

export const FALLBACK_COMMUNITY_NAME = 'our community';
const MAX_NAME_LENGTH = 60;

// Control characters, bidi overrides/isolates, zero-width and BOM characters.
const HIDDEN_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

/** Community name safe to put in a message: no control characters, one line, trimmed, at most 60 characters. */
export function sanitizeCommunityName(name: string | null | undefined): string {
  const cleaned = (name ?? '').replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return FALLBACK_COMMUNITY_NAME;
  const chars = Array.from(cleaned); // by code point: never cuts an emoji in half
  return chars.length > MAX_NAME_LENGTH ? `${chars.slice(0, MAX_NAME_LENGTH - 1).join('').trimEnd()}…` : cleaned;
}

export interface InvitationMessageInput {
  communityName: string | null | undefined;
  /** Any form of the code; shown as `ABCD-EFGH`. */
  code: string;
  /** ISO instant, or null when the code never expires. */
  expiresAt: string | null;
  /** Null when the code has no use limit. */
  maxRedemptions: number | null;
  /** Uses left, when the code was already used; wins over `maxRedemptions`. */
  remainingUses?: number | null;
  /** Download link, or null when none is configured. */
  appLink: string | null;
  /** Display only; the server decides whether a code works. */
  now: Date;
  /** The community's IANA time zone (an unknown zone falls back to UTC). */
  timeZone: string;
}

function expiryDate(expiresAt: string | null, timeZone: string): string | null {
  if (expiresAt === null) return null;
  const instant = new Date(expiresAt);
  if (Number.isNaN(instant.getTime())) return null;
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  return format(new TZDate(instant.getTime(), zone), 'd MMM yyyy');
}

function usesPhrase(maxRedemptions: number | null, remainingUses: number | null | undefined): string | null {
  if (maxRedemptions === null || maxRedemptions < 1) return null;
  if (remainingUses != null) {
    const left = Math.max(0, Math.floor(remainingUses));
    if (left < maxRedemptions) return left === 1 ? 'can be used 1 more time' : `can be used ${left} more times`;
  }
  return maxRedemptions === 1 ? 'can be used 1 time' : `works for up to ${maxRedemptions} people`;
}

export function buildInvitationMessage(input: InvitationMessageInput): string {
  const name = sanitizeCommunityName(input.communityName);
  const code = formatInvitationCode(input.code);
  const date = expiryDate(input.expiresAt, input.timeZone);
  const uses = usesPhrase(input.maxRedemptions, input.remainingUses);

  const conditions: string[] = [];
  if (date) conditions.push(`works until ${date}`);
  if (uses) conditions.push(uses);

  const lines = [`Hi! 🐻 You're invited to join ${name} on TrainHive.`];
  lines.push(input.appLink ? `1. Get the app: ${input.appLink}` : '1. Ask me where to get the app');
  lines.push(`2. Open it, tap "Join a community" and enter your code: ${code}`);
  if (conditions.length > 0) {
    lines.push(`(The code ${conditions.join(' and ')}.)`);
  }
  lines.push('One Pack. Stronger together.');
  return lines.join('\n');
}
