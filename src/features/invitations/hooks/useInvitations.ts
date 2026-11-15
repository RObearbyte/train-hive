import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { InvitationCode } from '@/lib/database.types';
import type { AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import {
  createInvitation,
  fetchInvitations,
  revokeInvitation,
  type NewInvitation,
} from '../api/invitations';

export const invitationKeys = {
  all: ['invitations'] as const,
  list: (communityId: string) => ['invitations', 'list', communityId] as const,
};

/** The community's invitation codes, newest first (organizers only; others get none). */
export function useInvitations(communityId: string) {
  return useQuery<InvitationCode[], AppError>({
    queryKey: invitationKeys.list(communityId),
    queryFn: () => fetchInvitations(communityId),
  });
}

/** Creates a code, then refetches the list so it shows the server's rows. */
export function useCreateInvitation(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation<InvitationCode, AppError, NewInvitation>({
    mutationFn: (invitation) => createInvitation(communityId, invitation),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationKeys.list(communityId) }),
    onError: (error) => reportError('invitations.create', error),
  });
}

/** Revokes a code, then refetches the list. */
export function useRevokeInvitation(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation<InvitationCode, AppError, string>({
    mutationFn: revokeInvitation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationKeys.list(communityId) }),
    onError: (error) => reportError('invitations.revoke', error),
  });
}
