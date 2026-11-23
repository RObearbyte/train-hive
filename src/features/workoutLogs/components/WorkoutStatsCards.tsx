import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { myWorkoutsHref } from '@/features/notifications/components/routes';
import { windowPhrase } from '@/features/statistics/domain/windows';
import type { StatisticsWindow } from '@/lib/database.types';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, Card, ErrorState, LoadingState, Text, useTheme } from '@/ui';

import {
  COMMUNITY_NOTE,
  INSUFFICIENT_COMMUNITY_MESSAGE,
  communityStatLines,
  personalStatLines,
  type StatLine,
} from '../domain/stats';
import { useCommunityWorkoutStats, useMyWorkoutStats } from '../hooks/useWorkoutLogs';

function Lines({ lines }: { lines: StatLine[] }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
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

/** My workout totals (all time, my logs only) with a way to the list. */
export function MyWorkoutStatsCard({ communityId }: { communityId: string | null }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const query = useMyWorkoutStats(communityId);

  let body;
  if (query.isPending) {
    body = <LoadingState message="Loading your workout totals" />;
  } else if (!query.data) {
    body = (
      <ErrorState
        title="Could not load your workout totals"
        message={userMessage(query.error.code, query.error.field)}
        onRetry={() => {
          query.refetch().catch((error: unknown) => reportError('workoutLogs.statsRetry', error));
        }}
      />
    );
  } else {
    const { empty, lines } = personalStatLines(query.data);
    body = empty ? (
      <Text color="textMuted">Nothing logged yet. After an event you went to, TrainHive asks how it went.</Text>
    ) : (
      <Lines lines={lines} />
    );
  }

  return (
    <Card style={{ gap: spacing.md }}>
      <Text variant="heading">My workouts</Text>
      <Text variant="caption" color="textMuted">
        From the logs you saved, all time. Private to you.
      </Text>
      {body}
      <Button label="See my workouts" variant="secondary" icon="chevron-right" onPress={() => router.push(myWorkoutsHref)} />
    </Card>
  );
}

/** Organizers only: approximate community workout totals for the selected window. */
export function CommunityWorkoutCard({
  communityId,
  window,
}: {
  communityId: string | null;
  window: StatisticsWindow;
}) {
  const { spacing } = useTheme();
  const query = useCommunityWorkoutStats(communityId, window);

  let body;
  if (query.isPending) {
    body = <LoadingState message="Loading workout totals" />;
  } else if (!query.data) {
    body = (
      <ErrorState
        title="Could not load the workout totals"
        message={userMessage(query.error.code, query.error.field)}
        onRetry={() => {
          query.refetch().catch((error: unknown) => reportError('workoutLogs.communityRetry', error));
        }}
      />
    );
  } else if (query.data.insufficient_data) {
    body = <Text color="textMuted">{INSUFFICIENT_COMMUNITY_MESSAGE}</Text>;
  } else {
    body = (
      <View style={{ gap: spacing.md }}>
        {query.isError ? (
          <Banner tone="warning" message={`${userMessage(query.error.code, query.error.field)} Showing the last numbers that loaded.`} />
        ) : null}
        <Lines lines={communityStatLines(query.data)} />
      </View>
    );
  }

  return (
    <Card style={{ gap: spacing.md }}>
      <Text variant="heading">Workouts</Text>
      <Text variant="caption" color="textMuted">
        Approximate totals for {windowPhrase(window)}. {COMMUNITY_NOTE}
      </Text>
      {body}
    </Card>
  );
}
