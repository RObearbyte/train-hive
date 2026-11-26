import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { personalBestsHref } from '@/features/notifications/components/routes';
import { reportError } from '@/lib/logger';
import { Banner, Button, Card, ErrorState, LoadingState, Text, useTheme } from '@/ui';

import { highlightLines } from '../domain/personalRecords';
import { workoutLogErrorMessage } from '../domain/workoutLog';
import { useMyPersonalRecords } from '../hooks/useWorkoutLogs';

/** Statistics, my view: a few of my personal bests with a way to the full page. */
export function PersonalBestsCard() {
  const router = useRouter();
  const { spacing } = useTheme();
  const query = useMyPersonalRecords();

  let body;
  if (query.isPending) {
    body = <LoadingState message="Loading your personal bests" />;
  } else if (!query.data) {
    body = (
      <ErrorState
        title="Could not load your personal bests"
        message={workoutLogErrorMessage(query.error)}
        onRetry={() => {
          query.refetch().catch((error: unknown) => reportError('workoutLogs.recordsRetry', error));
        }}
      />
    );
  } else {
    const lines = highlightLines(query.data);
    body =
      lines.length === 0 ? (
        <Text color="textMuted">
          No records yet. Log a run or a race with a time, or confirm a heavy set as a maximal effort after saving a strength
          log.
        </Text>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {query.isError ? (
            <Banner tone="warning" message={`${workoutLogErrorMessage(query.error)} Showing the records that loaded.`} />
          ) : null}
          {lines.map((line) => (
            <View
              key={line.key}
              accessible
              accessibilityLabel={`${line.label}: ${line.value}`}
              style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}
            >
              <Text color="textMuted">{line.label}</Text>
              <Text variant="label">{line.value}</Text>
            </View>
          ))}
        </View>
      );
  }

  return (
    <Card style={{ gap: spacing.md }}>
      <Text variant="heading">Personal bests</Text>
      <Text variant="caption" color="textMuted">
        From your own logs, all communities. Private to you.
      </Text>
      {body}
      <Button
        label="See personal bests"
        variant="secondary"
        icon="trophy"
        onPress={() => router.push(personalBestsHref)}
        testID="personal-bests-open"
      />
    </Card>
  );
}
