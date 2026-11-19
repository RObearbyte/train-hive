import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { setPendingJoinCode } from '@/features/onboarding/domain/pendingJoin';
import { removeExportedFiles } from '@/features/dataRights/api/removeExports';
import { unregisterThisDevice } from '@/features/notifications/api/unregisterDevice';
import { authStorage } from '@/lib/authStorage';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { AUTH_STORAGE_KEY, getSupabase } from '@/lib/supabase';

import { runSignOut } from '../domain/signOut';

/**
 * Signs out for good (the account is anonymous and cannot be recovered). The
 * mutation fails, with nothing cleared, when the server cannot be reached. On
 * success the auth listener moves the root gate to onboarding, which shows the
 * welcome screen.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const { userId } = useSession();

  return useMutation<void, AppError, void>({
    mutationFn: async () => {
      const result = await runSignOut(
        {
          unregisterDevice: unregisterThisDevice,
          signOut: async () => {
            const { error } = await getSupabase().auth.signOut();
            if (error) throw toAppError(error);
          },
          removeStored: (key) => authStorage.removeItem(key),
          removeExportedFiles,
          clearQueryCache: () => queryClient.clear(),
          resetInMemoryState: () => setPendingJoinCode(null),
          report: reportError,
        },
        { userId, authStorageKey: AUTH_STORAGE_KEY },
      );
      if (!result.ok) throw toAppError(result.error);
    },
    onError: (error) => reportError('signOut', error),
  });
}
