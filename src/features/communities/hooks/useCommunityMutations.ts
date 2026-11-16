import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useActiveCommunityStore } from '@/features/community/hooks/ActiveCommunityProvider';
import { membershipKeys } from '@/features/community/hooks/useCurrentMembership';
import { statisticsKeys } from '@/features/statistics/api/keys';
import type { Community } from '@/lib/database.types';
import type { AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import {
  createCommunityWithCode,
  previewCreatorCode,
  updateCommunity,
  type CreateCommunityInput,
  type CreatedCommunity,
} from '../api/communities';

/** Checks a creator code. `error` is always an AppError. */
export function usePreviewCreatorCode() {
  return useMutation<void, AppError, string>({
    mutationFn: previewCreatorCode,
    onError: (error) => reportError('communities.previewCreatorCode', error),
  });
}

/**
 * Creates a community. On success the new community becomes the active one
 * and the membership queries are refetched before the mutation settles, so
 * the button stays busy until the app shows the new community.
 */
export function useCreateCommunity() {
  const queryClient = useQueryClient();
  const { select } = useActiveCommunityStore();
  return useMutation<CreatedCommunity, AppError, CreateCommunityInput>({
    mutationFn: createCommunityWithCode,
    onSuccess: async (created) => {
      select(created.communityId);
      await queryClient.invalidateQueries({ queryKey: membershipKeys.all });
    },
    onError: (error) => reportError('communities.create', error),
  });
}

/** Saves name and time zone, then refetches the memberships so every screen shows the server's values. */
export function useUpdateCommunity(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation<Community, AppError, { name: string; timezone: string }>({
    mutationFn: ({ name, timezone }) => updateCommunity(communityId, name, timezone),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: membershipKeys.all });
      // Statistics buckets follow the community's current zone.
      await queryClient.invalidateQueries({ queryKey: statisticsKeys.all });
    },
    onError: (error) => reportError('communities.update', error),
  });
}
