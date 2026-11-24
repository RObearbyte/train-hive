import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { promptState, type PromptState } from '@/features/aboutYou/domain/prompt';
import { useSession } from '@/features/community/hooks/SessionProvider';
import { reportError } from '@/lib/logger';

import { readSecureSeen, writeSecureSeen } from '../api/promptStorage';
import { secureAccountAvailable } from '../domain/securePrompt';

const promptKey = (userId: string | null) => ['account', 'securePrompt', userId] as const;

/**
 * Whether the one-time "Secure your account" page is due, from a note on this
 * device. Not a rule: it only avoids asking twice (same shape as the About-you note).
 */
export function useSecurePrompt(): { state: PromptState; markSeen: () => Promise<void> } {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const available = secureAccountAvailable();

  const query = useQuery<boolean>({
    queryKey: promptKey(userId),
    queryFn: () => readSecureSeen(userId as string),
    enabled: available && userId !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const readError = query.error;
  useEffect(() => {
    if (readError) reportError('account.readSecureSeen', readError);
  }, [readError]);

  const state = promptState({
    available: available && userId !== null,
    seen: query.isError ? null : query.data,
  });

  const markSeen = async () => {
    if (userId === null) return;
    queryClient.setQueryData(promptKey(userId), true);
    try {
      await writeSecureSeen(userId);
    } catch (error) {
      // Only a convenience: failing to keep the note means the page may show once more.
      reportError('account.writeSecureSeen', error);
    }
  };

  return { state, markSeen };
}
