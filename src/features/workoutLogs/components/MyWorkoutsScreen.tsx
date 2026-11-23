import { useRouter, type Href } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { workoutLogHref } from '@/features/notifications/components/routes';
import type { WorkoutLog } from '@/lib/database.types';
import { deviceTimeZone, formatDateTime } from '@/lib/datetime';
import { reportError } from '@/lib/logger';
import { Banner, Button, Card, Divider, EmptyState, ErrorState, ListItem, LoadingState, Screen, Text, useTheme } from '@/ui';

import { logSummary, logTypeLabel, workoutLogErrorMessage } from '../domain/workoutLog';
import { useMyWorkoutLogs } from '../hooks/useWorkoutLogs';

/** "My workouts": every log I saved, newest event first, page by page. Each row opens its log. */
export function MyWorkoutsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const query = useMyWorkoutLogs();
  const logs = useMemo<WorkoutLog[]>(() => query.data?.pages.flatMap((page) => page.logs) ?? [], [query.data]);
  const zone = deviceTimeZone() ?? 'UTC';

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/profile' as Href);
  };

  let body;
  if (query.isPending) {
    body = <LoadingState message="Loading your workouts" />;
  } else if (query.isError && logs.length === 0) {
    body = (
      <ErrorState
        title="Could not load your workouts"
        message={workoutLogErrorMessage(query.error)}
        onRetry={() => {
          query.refetch().catch((error: unknown) => reportError('workoutLogs.listRetry', error));
        }}
      />
    );
  } else if (logs.length === 0) {
    body = (
      <EmptyState
        title="No workouts logged yet"
        message="After an event you went to, TrainHive asks how it went. Your logs are private and appear here."
      />
    );
  } else {
    body = (
      <View style={{ gap: spacing.md }}>
        {query.isError ? (
          <Banner tone="warning" message={`${workoutLogErrorMessage(query.error)} Showing the workouts that loaded.`} />
        ) : null}
        <Card>
          {logs.map((log, index) => {
            const meta = `${logTypeLabel(log.log_type)} · ${formatDateTime(log.event_starts_at, zone)}`;
            const summary = logSummary(log);
            return (
              <View key={log.id}>
                {index > 0 ? <Divider /> : null}
                <ListItem
                  title={log.event_title}
                  subtitle={`${meta}. ${summary}`}
                  onPress={() => router.push(workoutLogHref(log.session_id))}
                  accessibilityLabel={`${log.event_title}. ${meta}. ${summary}`}
                />
              </View>
            );
          })}
        </Card>
        {query.hasNextPage ? (
          <Button
            label="Show more"
            variant="secondary"
            loading={query.isFetchingNextPage}
            onPress={() => {
              query.fetchNextPage().catch((error: unknown) => reportError('workoutLogs.nextPage', error));
            }}
          />
        ) : null}
      </View>
    );
  }

  return (
    <Screen
      scroll
      onRefresh={() => {
        query.refetch().catch((error: unknown) => reportError('workoutLogs.refresh', error));
      }}
      refreshing={query.isRefetching && !query.isFetchingNextPage}
    >
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={leave} />
      </View>
      <Text variant="title">My workouts</Text>
      <Text color="textMuted">Private to you. Organizers never see individual logs.</Text>
      {body}
    </Screen>
  );
}
