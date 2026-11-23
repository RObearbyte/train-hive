import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { CommunityProfileCard } from '@/features/aboutYou/components/CommunityProfileCard';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { FEATURES } from '@/features/legal/constants';
import { CommunityWorkoutCard, MyWorkoutStatsCard } from '@/features/workoutLogs/components/WorkoutStatsCards';
import { ScreenHeader } from '@/features/shell/components/ScreenHeader';
import type { StatisticsWindow } from '@/lib/database.types';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, ErrorState, LoadingState, Screen, SegmentedControl, Text, useTheme } from '@/ui';

import { statisticsKeys } from '../api/keys';
import { windowPhrase } from '../domain/windows';
import { useMyAttendanceHistory, useMyStatistics, useStatsWindow } from '../hooks/useStatistics';
import { CommunityOverview } from './CommunityOverview';
import { HistorySection } from './HistorySection';
import { MemberStatsView } from './MemberStatsView';
import { StatsSkeleton } from './Skeleton';
import { WindowFilter } from './WindowFilter';

type View_ = 'me' | 'community';

function MyParticipation({
  communityId,
  window,
}: {
  communityId: string | null;
  window: StatisticsWindow;
}) {
  const { spacing } = useTheme();
  const stats = useMyStatistics(communityId, window);
  const history = useMyAttendanceHistory(communityId, window);

  if (stats.isPending) return <StatsSkeleton />;
  if (!stats.data) {
    const error = toAppError(stats.error);
    return (
      <ErrorState
        title="Could not load your statistics"
        message={userMessage(error.code, error.field)}
        onRetry={() => {
          stats.refetch().catch((e: unknown) => reportError('statistics.mine', e));
        }}
      />
    );
  }
  return (
    <View style={{ gap: spacing.xl }}>
      {stats.isError ? (
        <Banner
          tone="warning"
          message={`${userMessage(toAppError(stats.error).code)} Showing the last numbers that loaded.`}
          action={{
            label: 'Try again',
            onPress: () => {
              stats.refetch().catch((e: unknown) => reportError('statistics.mine', e));
            },
          }}
        />
      ) : null}
      <MemberStatsView stats={stats.data} />
      <HistorySection history={history} />
      {FEATURES.workoutLogs ? <MyWorkoutStatsCard communityId={communityId} /> : null}
    </View>
  );
}

/** The Statistics tab: my participation for everyone, the community overview for organizers. */
export function StatisticsScreen() {
  const queryClient = useQueryClient();
  const { spacing } = useTheme();
  const { community, isOrganizer, isLoading } = useCurrentMembership();
  const communityId = community?.id ?? null;
  const [window] = useStatsWindow();
  const [chosen, setChosen] = useState<View_>('me');
  const [refreshing, setRefreshing] = useState(false);
  // Members never see the community view; the server enforces it as well.
  const view: View_ = isOrganizer ? chosen : 'me';

  // Numbers marked stale by an attendance, RSVP or training change refetch when the tab is shown.
  useFocusEffect(
    useCallback(() => {
      void queryClient.refetchQueries(
        { queryKey: statisticsKeys.all, type: 'active', stale: true },
        { cancelRefetch: false },
      );
    }, [queryClient]),
  );

  const refresh = () => {
    setRefreshing(true);
    queryClient
      .refetchQueries({ queryKey: statisticsKeys.all, type: 'active' })
      .catch((error: unknown) => reportError('statistics.refresh', error))
      .finally(() => setRefreshing(false));
  };

  return (
    <Screen scroll onRefresh={refresh} refreshing={refreshing} edges={['top', 'left', 'right']}>
      <ScreenHeader title="Statistics" />

      {isOrganizer ? (
        <SegmentedControl
          accessibilityLabel="Statistics view"
          options={[
            { value: 'me' as const, label: 'Me', accessibilityLabel: 'My participation' },
            { value: 'community' as const, label: 'Community', accessibilityLabel: 'Community overview' },
          ]}
          value={view}
          onChange={setChosen}
        />
      ) : null}

      <View style={{ gap: spacing.xs }}>
        <WindowFilter />
        <Text variant="caption" color="textMuted">
          {view === 'me' ? 'Your participation' : 'Community overview'} for {windowPhrase(window)}. Only
          finalized events count.
        </Text>
      </View>

      {isLoading && communityId === null ? (
        <LoadingState message="Loading" />
      ) : view === 'me' ? (
        <MyParticipation communityId={communityId} window={window} />
      ) : (
        <>
          <CommunityOverview communityId={communityId} window={window} />
          {/* Organizers only (this view is); the numbers are today's, whatever the period filter says. */}
          {FEATURES.workoutLogs ? <CommunityWorkoutCard communityId={communityId} window={window} /> : null}
          {FEATURES.demographics ? <CommunityProfileCard communityId={communityId} /> : null}
        </>
      )}
    </Screen>
  );
}
