import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { invalidateStatistics } from '@/features/statistics/api/invalidate';
import type { TrainingInput, TrainingSession } from '@/lib/database.types';
import type { AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { trainingKeys } from '../api/keys';
import { cancelTraining, createTraining, updateTraining } from '../api/trainings';

/**
 * Shows the row the server returned straight away, then refetches the lists
 * and details so every screen ends on server truth.
 */
function applySavedSession(queryClient: QueryClient, session: TrainingSession): void {
  queryClient.setQueryData(trainingKeys.detail(session.id), session);
  void queryClient.invalidateQueries({ queryKey: trainingKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: trainingKeys.details() });
  // A moved or cancelled session moves between statistics windows; refetch when the tab is shown.
  invalidateStatistics(queryClient, 'none');
}

/** A failed save may mean the session changed under the form: refetch it. */
function refetchSession(queryClient: QueryClient, sessionId: string): void {
  void queryClient.invalidateQueries({ queryKey: trainingKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: trainingKeys.detail(sessionId) });
}

export function useCreateTraining(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation<TrainingSession, AppError, TrainingInput>({
    mutationFn: (input) => createTraining(communityId, input),
    onSuccess: (session) => applySavedSession(queryClient, session),
    onError: (error) => reportError('training.create', error),
  });
}

export function useUpdateTraining(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<TrainingSession, AppError, TrainingInput>({
    mutationFn: (input) => updateTraining(sessionId, input),
    onSuccess: (session) => applySavedSession(queryClient, session),
    onError: (error) => {
      reportError('training.update', error);
      refetchSession(queryClient, sessionId);
    },
  });
}

export function useCancelTraining(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<TrainingSession, AppError, void>({
    mutationFn: () => cancelTraining(sessionId),
    onSuccess: (session) => applySavedSession(queryClient, session),
    onError: (error) => {
      reportError('training.cancel', error);
      refetchSession(queryClient, sessionId);
    },
  });
}
