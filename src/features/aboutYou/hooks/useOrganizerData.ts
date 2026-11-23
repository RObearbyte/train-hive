import { useQuery } from '@tanstack/react-query';

import type { CommunityDemographics, CommunityEmergencyList, MemberEmergencyInfo } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';

import {
  fetchCommunityDemographics,
  fetchCommunityEmergencyList,
  fetchMemberEmergencyInfo,
} from '../api/aboutYou';
import { aboutYouKeys } from '../api/keys';

/**
 * Members' details are sensitive: they are read again every time a screen asks,
 * and dropped from memory shortly after the screen is gone (never kept as
 * "last known" data for long).
 */
const SENSITIVE = { staleTime: 0, gcTime: 30_000 } as const;

/** Organizers: one active member's emergency contact and T-shirt size. */
export function useMemberEmergencyInfo(communityId: string, userId: string | null) {
  return useQuery<MemberEmergencyInfo, AppError>({
    queryKey: aboutYouKeys.memberEmergency(communityId, userId),
    queryFn: () =>
      fetchMemberEmergencyInfo(communityId, userId as string).catch((error: unknown) =>
        Promise.reject(toAppError(error)),
      ),
    enabled: userId !== null,
    ...SENSITIVE,
  });
}

/** Organizers: the community's emergency contacts and T-shirt sizes. Loads only when `enabled`. */
export function useCommunityEmergencyList(communityId: string, enabled: boolean) {
  return useQuery<CommunityEmergencyList, AppError>({
    queryKey: aboutYouKeys.emergencyList(communityId),
    queryFn: () =>
      fetchCommunityEmergencyList(communityId).catch((error: unknown) => Promise.reject(toAppError(error))),
    enabled,
    ...SENSITIVE,
  });
}

/** Organizers: grouped age and gender numbers for the community. */
export function useCommunityDemographics(communityId: string | null) {
  return useQuery<CommunityDemographics, AppError>({
    queryKey: aboutYouKeys.demographics(communityId),
    queryFn: () =>
      fetchCommunityDemographics(communityId as string).catch((error: unknown) =>
        Promise.reject(toAppError(error)),
      ),
    enabled: communityId !== null,
    ...SENSITIVE,
  });
}
