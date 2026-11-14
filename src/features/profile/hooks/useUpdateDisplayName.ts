import { useMutation, useQueryClient } from '@tanstack/react-query';

import { membershipKeys } from '@/features/community/hooks/useCurrentMembership';
import type { Profile } from '@/lib/database.types';
import type { AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { updateDisplayName } from '../api/profile';

/** Saves a new display name, then refetches the profile so every screen shows the server's value. */
export function useUpdateDisplayName() {
  const queryClient = useQueryClient();
  return useMutation<Profile, AppError, string>({
    mutationFn: updateDisplayName,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: membershipKeys.all }),
    onError: (error) => reportError('profile.updateDisplayName', error),
  });
}
