import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useActiveCommunityStore } from '@/features/community/hooks/ActiveCommunityProvider';
import { membershipKeys } from '@/features/community/hooks/useCurrentMembership';
import type { AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import {
  previewInvitation,
  redeemInvitation,
  type InvitationPreview,
  type RedeemedInvitation,
} from '../api/invitations';

/** Checks a code. `error` is always an AppError (the api layer converts). */
export function usePreviewInvitation() {
  return useMutation<InvitationPreview, AppError, string>({
    mutationFn: previewInvitation,
    onError: (error) => reportError('onboarding.preview', error),
  });
}

/**
 * Redeems a code. On success the joined community becomes the active one and
 * the membership queries are refetched before the mutation settles, so the
 * button stays busy until the app shows the community.
 */
export function useRedeemInvitation() {
  const queryClient = useQueryClient();
  const { select } = useActiveCommunityStore();
  return useMutation<RedeemedInvitation, AppError, { code: string; displayName: string }>({
    mutationFn: ({ code, displayName }) => redeemInvitation(code, displayName),
    onSuccess: async (joined) => {
      select(joined.communityId);
      await queryClient.invalidateQueries({ queryKey: membershipKeys.all });
    },
    onError: (error) => reportError('onboarding.redeem', error),
  });
}
