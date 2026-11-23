import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import { deviceTimeZone, formatDateTime } from '@/lib/datetime';
import { reportError } from '@/lib/logger';
import { Banner, Button, Card, ErrorState, LoadingState, Text, useTheme } from '@/ui';

import {
  cannotLogMessage,
  logSummary,
  logTypeLabel,
  workoutLogErrorMessage,
} from '../domain/workoutLog';
import { useDeleteWorkoutLog, useWorkoutLogScreen } from '../hooks/useWorkoutLogs';
import { WorkoutLogForm } from './WorkoutLogForm';

/**
 * "Log your workout" for one event (also the target of the `/events/<id>/log` notification
 * link). The server decides whether the person can log and which shape the log has.
 */
export function WorkoutLogScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const query = useWorkoutLogScreen(sessionId);
  const remove = useDeleteWorkoutLog(sessionId);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  };

  const header = (
    <>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={leave} />
      </View>
      <Text variant="title">{query.data?.log ? 'Your workout log' : 'Log your workout'}</Text>
    </>
  );

  if (query.isPending) {
    return (
      <KeyboardScreen>
        {header}
        <LoadingState message="Loading" style={{ flex: 1 }} />
      </KeyboardScreen>
    );
  }
  if (!query.data) {
    return (
      <KeyboardScreen>
        {header}
        <ErrorState
          message={workoutLogErrorMessage(query.error)}
          onRetry={() => {
            query.refetch().catch((error: unknown) => reportError('workoutLogs.retry', error));
          }}
          style={{ flex: 1 }}
        />
      </KeyboardScreen>
    );
  }

  const screen = query.data;
  const title = screen.event?.title ?? screen.log?.event_title ?? 'Event';
  const startsAt = screen.event?.starts_at ?? screen.log?.event_starts_at ?? null;
  const when = startsAt ? formatDateTime(startsAt, deviceTimeZone() ?? 'UTC') : null;
  const logType = screen.log_type;

  return (
    <KeyboardScreen>
      {header}
      <View style={{ gap: spacing.xxs }}>
        <Text variant="heading">{title}</Text>
        <Text color="textMuted">{[logTypeLabel(logType), when].filter(Boolean).join(' · ')}</Text>
      </View>

      {query.isError ? (
        <Banner
          tone="warning"
          message={`${workoutLogErrorMessage(query.error)} Showing the last details that loaded.`}
          action={{
            label: 'Try again',
            onPress: () => {
              query.refetch().catch((error: unknown) => reportError('workoutLogs.retry', error));
            },
          }}
        />
      ) : null}
      {notice ? <Banner tone="success" message={notice} /> : null}

      {screen.can_log && screen.event !== null && logType !== null ? (
        <WorkoutLogForm
          screen={screen}
          logType={logType}
          onSaved={() => setNotice('Saved. Your workout log is up to date.')}
        />
      ) : (
        <>
          <Banner tone="info" message={cannotLogMessage(screen.cannot_log_reason)} />
          {screen.log ? (
            <Card style={{ gap: spacing.xs }}>
              <Text variant="label">Your saved log</Text>
              <Text>{logSummary(screen.log)}</Text>
              {screen.log.notes ? <Text color="textMuted">{screen.log.notes}</Text> : null}
            </Card>
          ) : null}
        </>
      )}

      {screen.log ? (
        <Button
          label="Delete this log"
          variant="danger"
          icon="trash"
          fullWidth
          onPress={() => {
            setNotice(null);
            setDeleting(true);
          }}
          testID="workout-delete"
        />
      ) : null}

      <ConfirmDialog
        visible={deleting}
        title="Delete this workout log?"
        message="The log is deleted from TrainHive for good and no longer counts in any total. This cannot be undone."
        confirmLabel="Delete log"
        cancelLabel="Keep it"
        destructive
        pending={remove.isPending}
        error={remove.isError ? workoutLogErrorMessage(remove.error) : null}
        onConfirm={() => {
          if (remove.isPending) return;
          remove.mutate(undefined, {
            onSuccess: () => {
              setDeleting(false);
              if (router.canGoBack()) router.back();
              else setNotice('Your workout log was deleted.');
            },
          });
        }}
        onCancel={() => {
          setDeleting(false);
          remove.reset();
        }}
      />
    </KeyboardScreen>
  );
}
