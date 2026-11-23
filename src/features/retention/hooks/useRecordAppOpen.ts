import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { reportError } from '@/lib/logger';
import { readClock } from '@/lib/useNow';

import { recordAppOpen } from '../api/appOpen';
import { inactivityNoticeKey, type InactivityNoticeEntry } from '../api/keys';
import { shouldRecordAppOpen } from '../domain/appOpen';

/**
 * Reports "the app was opened" when the signed-in area starts and whenever the app returns to the
 * foreground, at most once an hour (the server also limits itself). Fire and forget: a failure is
 * logged and never blocks the app; the next return to the foreground tries again. A pending
 * inactivity notice that comes back is put in the query cache for the Home banner. Nothing
 * personal is logged. Mount once, inside `(app)`.
 */
export function useRecordAppOpen(): void {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const lastAttempt = useRef<{ userId: string; at: number } | null>(null);

  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;

    const run = () => {
      const last = lastAttempt.current;
      const previous = last !== null && last.userId === userId ? last.at : null;
      const now = readClock().getTime();
      if (!shouldRecordAppOpen(previous, now)) return;
      lastAttempt.current = { userId, at: now };
      recordAppOpen()
        .then((result) => {
          if (cancelled || result.notice === null) return;
          const entry: InactivityNoticeEntry = { result, receivedAt: readClock().getTime() };
          queryClient.setQueryData(inactivityNoticeKey, entry);
        })
        .catch((error: unknown) => {
          // Let the next return to the foreground retry instead of waiting out the hour.
          if (lastAttempt.current?.at === now) lastAttempt.current = null;
          reportError('retention.recordAppOpen', error);
        });
    };

    run();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [queryClient, userId]);
}
