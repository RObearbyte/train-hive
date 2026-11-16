/**
 * The friendly, plain-text message an organizer sends to invite someone.
 * Pure: `now` and the time zone are injected, nothing reads the clock.
 */
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

import { formatInvitationCode } from '@/features/onboarding/domain/invitationCode';
import { buildWebJoinLink } from '@/features/onboarding/domain/joinLink';
import { isValidTimeZone } from '@/lib/datetime';

export const FALLBACK_COMMUNITY_NAME = 'our community';
const MAX_NAME_LENGTH = 60;

// Control characters become a space (they may stand for a line break).
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
// Invisible format characters are dropped without a trace: zero-width space, LRM/RLM, bidi
// embeddings/overrides/isolates, Arabic letter mark, word joiner and invisible operators, BOM.
// The zero-width joiner (U+200D) and non-joiner (U+200C) stay: emoji sequences and Persian words need them.
const INVISIBLE_CHARS =
  /[\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{61C}\u{180E}\u{FEFF}]/gu;
const JOINERS = /[\u{200C}\u{200D}]/gu;
const EDGE_JOINERS_AND_SPACE = /^[\s\u{200C}\u{200D}]+|[\s\u{200C}\u{200D}]+$/gu;

/** Community name safe to put in a message: no control characters, one line, trimmed, at most 60 characters. */
export function sanitizeCommunityName(name: string | null | undefined): string {
  const cleaned = (name ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(EDGE_JOINERS_AND_SPACE, '');
  // Nothing visible left (only joiners and spaces): use the neutral wording.
  if (cleaned.replace(JOINERS, '').trim() === '') return FALLBACK_COMMUNITY_NAME;
  const chars = Array.from(cleaned); // by code point: never cuts an emoji in half
  return chars.length > MAX_NAME_LENGTH
    ? `${chars.slice(0, MAX_NAME_LENGTH - 1).join('').trimEnd()}…`
    : cleaned;
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
  /** Normalized web app address (`parseWebAppUrl`), or null/undefined when the web app is not configured. */
  webAppUrl?: string | null;
  /** Display only; the server decides whether a code works. */
  now: Date;
  /** The community's IANA time zone (an unknown zone falls back to UTC); the expiry is shown in it. */
  timeZone: string;
}

/** "22 Nov 2026, 14:30" in the community zone: a code stops at a time of day, not at the end of a date. */
function expiryMoment(expiresAt: string | null, timeZone: string): string | null {
  if (expiresAt === null) return null;
  const instant = new Date(expiresAt);
  if (Number.isNaN(instant.getTime())) return null;
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  return format(new TZDate(instant.getTime(), zone), 'd MMM yyyy, HH:mm');
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
  const moment = expiryMoment(input.expiresAt, input.timeZone);
  const uses = usesPhrase(input.maxRedemptions, input.remainingUses);

  const conditions: string[] = [];
  if (moment) conditions.push(`works until ${moment}`);
  if (uses) conditions.push(uses);

  const lines = [`Hi! \u{1F43B} You're invited to join ${name} on TrainHive.`];
  const webLink = buildWebJoinLink(input.webAppUrl ?? null, input.code);
  const joinHelp = '(already using TrainHive? Profile → Join another community)';
  if (webLink) {
    // The link opens the web app with the code already filled in; the code stays as the fallback.
    lines.push(`Open it here: ${webLink}`);
    lines.push(input.appLink ? `Or get the app: ${input.appLink}` : 'Or ask me where to get the app');
    const manual = `Or enter the code manually in the app: ${code} ${joinHelp}`;
    lines.push(manual);
  } else {
    lines.push(input.appLink ? `1. Get the app: ${input.appLink}` : '1. Ask me where to get the app');
    lines.push(`2. Open TrainHive and enter your code under "Join a community": ${code} ${joinHelp}`);
  }
  if (conditions.length > 0) {
    lines.push(`(The code ${conditions.join(' and ')}.)`);
  }
  lines.push('One Pack. Stronger together.');
  return lines.join('\n');
}
