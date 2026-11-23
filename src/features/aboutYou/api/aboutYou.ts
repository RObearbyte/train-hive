import type {
  AboutYou,
  AboutYouInput,
  CommunityDemographics,
  CommunityEmergencyList,
  ConsentPurpose,
  MemberEmergencyInfo,
} from '@/lib/database.types';
import { AppError, toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';
import { recordConsent } from '@/features/legal/api/consents';

import { isAboutYou } from '../domain/aboutYou';
import { isCommunityDemographics } from '../domain/demographics';
import { isCommunityEmergencyList, isMemberEmergencyInfo } from '../domain/emergency';

/** Keeps only the function name: the answer is personal data and must not reach AppError.original or the logs. */
function unexpected(fn: string): AppError {
  return new AppError('unknown', { message: `${fn} returned an unexpected shape` });
}

/** My own details. Throws AppError (`not_authenticated`, ...). */
export async function fetchMyAboutYou(): Promise<AboutYou> {
  const { data, error } = await getSupabase().rpc('get_my_about_you');
  if (error) throw toAppError(error);
  if (!isAboutYou(data)) throw unexpected('get_my_about_you');
  return data;
}

/**
 * Records the agreements the saved fields need (one at a time, in order), then
 * saves. Throws AppError: `consent_required:<purpose>`, `validation_failed:<field>`, `not_a_member`.
 */
export async function saveMyAboutYou(input: AboutYouInput, consents: readonly ConsentPurpose[]): Promise<AboutYou> {
  for (const purpose of consents) await recordConsent(purpose);
  const { data, error } = await getSupabase().rpc('save_my_about_you', { p_input: input });
  if (error) throw toAppError(error);
  if (!isAboutYou(data)) throw unexpected('save_my_about_you');
  return data;
}

/** Deletes all my details (agreements stay as they are). */
export async function clearMyAboutYou(): Promise<AboutYou> {
  const { data, error } = await getSupabase().rpc('clear_my_about_you');
  if (error) throw toAppError(error);
  if (!isAboutYou(data)) throw unexpected('clear_my_about_you');
  return data;
}

/** Organizers: one active member's emergency contact and T-shirt size. Throws `forbidden`, `not_found`. */
export async function fetchMemberEmergencyInfo(communityId: string, userId: string): Promise<MemberEmergencyInfo> {
  const { data, error } = await getSupabase().rpc('get_member_emergency_info', {
    p_community_id: communityId,
    p_user_id: userId,
  });
  if (error) throw toAppError(error);
  if (!isMemberEmergencyInfo(data)) throw unexpected('get_member_emergency_info');
  return data;
}

/** Organizers: the community's list (members with a contact or a T-shirt size). Throws `forbidden`. */
export async function fetchCommunityEmergencyList(communityId: string): Promise<CommunityEmergencyList> {
  const { data, error } = await getSupabase().rpc('list_community_emergency_info', {
    p_community_id: communityId,
  });
  if (error) throw toAppError(error);
  if (!isCommunityEmergencyList(data)) throw unexpected('list_community_emergency_info');
  return data;
}

/** Organizers: grouped age and gender numbers (small groups suppressed by the server). Throws `forbidden`. */
export async function fetchCommunityDemographics(communityId: string): Promise<CommunityDemographics> {
  const { data, error } = await getSupabase().rpc('get_community_demographics', { p_community_id: communityId });
  if (error) throw toAppError(error);
  if (!isCommunityDemographics(data)) throw unexpected('get_community_demographics');
  return data;
}
