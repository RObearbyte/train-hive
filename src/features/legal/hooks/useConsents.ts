import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useSession } from '@/features/community/hooks/SessionProvider';
import type { ConsentEvent, ConsentPurpose, MyConsents } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { BUNDLED_TERMS_PRIVACY_VERSION } from '../constants';
import {
  acceptCurrentTerms,
  fetchMyConsents,
  recordConsent,
  withdrawConsent,
} from '../api/consents';
import { clearLocalAcceptance, readLocalAcceptance, writeLocalAcceptance } from '../api/acceptanceStorage';
import { consentKeys } from '../api/keys';
import { createLocalAcceptance, type LocalAcceptance } from '../domain/acceptance';
import { applyConsentEvent, optimisticConsent } from '../domain/consentCache';

/** The server's view of the signed-in user's consents. */
export function useMyConsents() {
  const { userId } = useSession();
  const query = useQuery<MyConsents>({
    queryKey: consentKeys.mine(userId),
    queryFn: fetchMyConsents,
    enabled: userId !== null,
  });
  return {
    consents: query.data ?? null,
    isLoading: query.isPending,
    error: query.error ? toAppError(query.error) : null,
    refetch: () => {
      query.refetch().catch((error: unknown) => reportError('consents.refetch', error));
    },
  };
}

type SetConsentVariables = { purpose: ConsentPurpose; granted: boolean };
type Snapshot = { previous: MyConsents | undefined; key: ReturnType<typeof consentKeys.mine> };

/**
 * Turns one optional consent on or off. Turning ON is optimistic (the switch
 * moves at once and snaps back with the error if the server refuses); turning
 * OFF waits for the server, behind the confirmation dialog, because it
 * deletes data. Either way the server's state is read again afterwards.
 */
export function useSetConsent() {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const key = consentKeys.mine(userId);

  return useMutation<ConsentEvent, AppError, SetConsentVariables, Snapshot>({
    mutationFn: async ({ purpose, granted }) => {
      try {
        return granted ? await recordConsent(purpose) : await withdrawConsent(purpose);
      } catch (error) {
        throw toAppError(error);
      }
    },
    onMutate: async ({ purpose, granted }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<MyConsents>(key);
      if (granted && previous) queryClient.setQueryData(key, optimisticConsent(previous, purpose, true));
      return { previous, key };
    },
    onSuccess: (event) => {
      queryClient.setQueryData<MyConsents>(key, (current) =>
        current ? applyConsentEvent(current, event) : current,
      );
    },
    onError: (error, _variables, snapshot) => {
      reportError('consents.set', error);
      if (snapshot) queryClient.setQueryData(snapshot.key, snapshot.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: consentKeys.all }),
  });
}

/** The first-launch acknowledgement stored on this device (undefined while it is being read). */
export function useLocalAcceptance() {
  const queryClient = useQueryClient();
  const query = useQuery<LocalAcceptance | null>({
    queryKey: consentKeys.local,
    queryFn: readLocalAcceptance,
    // Re-read from storage whenever a screen needs it (cheap), so a stale answer never outlives a sign-out.
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const accept = useMutation<LocalAcceptance, AppError, void>({
    mutationFn: async () => {
      const acceptance = createLocalAcceptance(BUNDLED_TERMS_PRIVACY_VERSION, new Date());
      try {
        await writeLocalAcceptance(acceptance);
      } catch (error) {
        throw toAppError(error);
      }
      return acceptance;
    },
    onSuccess: (acceptance) => queryClient.setQueryData(consentKeys.local, acceptance),
    onError: (error) => reportError('consents.saveLocal', error),
  });

  return {
    acceptance: query.data,
    isLoading: query.isPending,
    error: query.error ? toAppError(query.error) : null,
    accept,
    clear: async () => {
      await clearLocalAcceptance();
      queryClient.setQueryData(consentKeys.local, null);
    },
  };
}

/**
 * "We updated our terms": records the acknowledgement of the texts this build
 * shows, remembers it on the device too, and refreshes the server state so
 * the gate lets the person through.
 */
export function useAcceptUpdatedTerms() {
  const queryClient = useQueryClient();
  return useMutation<void, AppError, void>({
    mutationFn: async () => {
      try {
        await acceptCurrentTerms();
      } catch (error) {
        throw toAppError(error);
      }
      // The server has it; a failed local note only means the first-launch screen may show again on a new account.
      await writeLocalAcceptance(createLocalAcceptance(BUNDLED_TERMS_PRIVACY_VERSION, new Date())).catch(
        (error: unknown) => reportError('consents.saveLocal', error),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: consentKeys.all }),
    onError: (error) => reportError('consents.acceptUpdated', error),
  });
}
