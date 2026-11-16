import { ensureSession } from '@/features/community/api/session';
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
 * Organizer only. Throws AppError: `forbidden`, `validation_failed` (field
 * `name` / `timezone`), `not_authenticated`, `network_error`.
 */
export async function updateCommunity(
  communityId: string,
  name: string,
  timezone: string,
): Promise<Community> {
  const { data, error } = await getSupabase().rpc('update_community', {
    p_community_id: communityId,
    p_name: name,
    p_timezone: timezone,
  });
  if (error) throw toAppError(error);
  return data;
}
