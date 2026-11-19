import { ensureSession } from '@/features/community/api/session';
import { ensureConsentRecorded } from '@/features/legal/api/consents';
import { normalizeInvitationCode } from '@/features/onboarding/domain/invitationCode';
import type {
  Community,
  CreateCommunityWithCodeResult,
  PreviewCreatorCodeResult,
} from '@/lib/database.types';
import { appErrorFromResult, toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

/**
 * Checks a creator code without using it. Counts toward the server's shared
 * rate limit when the code is wrong. Throws AppError: `invalid_code`,
 * `expired`, `revoked`, `exhausted`, `rate_limited`, `network_error`, ...
 */
export async function previewCreatorCode(code: string): Promise<void> {
  await ensureSession();
  const { data, error } = await getSupabase().rpc('preview_creator_code', {
    p_code: normalizeInvitationCode(code),
  });
  if (error) throw toAppError(error);

  const result = data as PreviewCreatorCodeResult | null;
  if (!result || !result.ok) throw appErrorFromResult(result?.error);
}

export type CreateCommunityInput = {
  code: string;
  name: string;
  timezone: string;
  displayName: string;
  /** One per form submission; the same value on every retry of it. */
  requestId: string;
};

export type CreatedCommunity = {
  communityId: string;
  membershipId: string;
  /** True when the request id had already succeeded: the first result is returned. */
  alreadyCreated: boolean;
};

/**
 * Creates a community with a creator code; the caller becomes its organizer
 * and their display name is saved (it is shared across all their communities).
 * A replayed `requestId` succeeds with `alreadyCreated`. Throws AppError for
 * every `{ ok: false, error }` answer (`community_limit_reached`,
 * `validation_failed` with field `name` / `timezone` / `display_name`, the
 * code problems, `rate_limited`, ...).
 */
export async function createCommunityWithCode(input: CreateCommunityInput): Promise<CreatedCommunity> {
  await ensureSession();
  // The acknowledgement from the first-launch screen must be on the server before creating (GDPR G1).
  await ensureConsentRecorded();
  const { data, error } = await getSupabase().rpc('create_community_with_code', {
    p_code: normalizeInvitationCode(input.code),
    p_name: input.name,
    p_timezone: input.timezone,
    p_display_name: input.displayName,
    p_request_id: input.requestId,
  });
  if (error) throw toAppError(error);

  const result = data as CreateCommunityWithCodeResult | null;
  if (!result || !result.ok) throw appErrorFromResult(result?.error);
  return {
    communityId: result.community_id,
    membershipId: result.membership_id,
    alreadyCreated: result.already_created,
  };
}

/**
 * Organizer only. `expectedUpdatedAt` is the `updated_at` of the row the form
 * was loaded from; when the row changed since, the server answers
 * `stale_data` and changes nothing. Throws AppError: `stale_data`,
 * `forbidden`, `validation_failed` (field `name` / `timezone`),
 * `not_authenticated`, `network_error`.
 */
export async function updateCommunity(
  communityId: string,
  name: string,
  timezone: string,
  expectedUpdatedAt: string | null,
): Promise<Community> {
  const { data, error } = await getSupabase().rpc('update_community', {
    p_community_id: communityId,
    p_name: name,
    p_timezone: timezone,
    p_expected_updated_at: expectedUpdatedAt,
  });
  if (error) throw toAppError(error);
  return data;
}

/** The current community row (readable by its members). Throws AppError; `not_found` when it is gone. */
export async function fetchCommunity(communityId: string): Promise<Community> {
  const { data, error } = await getSupabase()
    .from('communities')
    .select('*')
    .eq('id', communityId)
    .maybeSingle();
  if (error) throw toAppError(error);
  if (!data) throw appErrorFromResult('not_found');
  return data;
}
