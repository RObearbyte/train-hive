import { useMutation, useQueryClient } from '@tanstack/react-query';

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
 * Redeems a code. On success the membership query is refetched before the
 * mutation settles, so the button stays busy until the app gate lets the user in.
 */
export function useRedeemInvitation() {
  const queryClient = useQueryClient();
  return useMutation<RedeemedInvitation, AppError, { code: string; displayName: string }>({
    mutationFn: ({ code, displayName }) => redeemInvitation(code, displayName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: membershipKeys.all }),
    onError: (error) => reportError('onboarding.redeem', error),
  });
}
