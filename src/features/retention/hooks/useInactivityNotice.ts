import { useQuery, useQueryClient } from '@tanstack/react-query';

import { inactivityNoticeKey, type InactivityNoticeEntry } from '../api/keys';
import { inactivityNoticeMessage } from '../domain/appOpen';

/**
 * The one-time banner text for an inactivity notice that `record_app_open` just ended, and a way
 * to dismiss it. The server returns the notice only once, so it is not shown again after dismissal.
 */
export function useInactivityNotice(): { message: string | null; dismiss: () => void } {
  const queryClient = useQueryClient();
  // Never fetches: the entry is written by useRecordAppOpen.
  const { data } = useQuery<InactivityNoticeEntry>({
    queryKey: inactivityNoticeKey,
    queryFn: () => queryClient.getQueryData<InactivityNoticeEntry>(inactivityNoticeKey) ?? null,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const message = data ? inactivityNoticeMessage(data.result, data.receivedAt) : null;
  return {
    message,
    dismiss: () => queryClient.setQueryData<InactivityNoticeEntry>(inactivityNoticeKey, null),
  };
}
