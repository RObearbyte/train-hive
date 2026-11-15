import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, EmptyState, ErrorState, Screen, Text, useTheme } from '@/ui';

import { windowPhrase } from '../domain/windows';
import {
  useMemberAttendanceHistory,
  useMemberStatistics,
  useMemberSummary,
  useStatsWindow,
} from '../hooks/useStatistics';
import { HistorySection } from './HistorySection';
import { MemberStatsView } from './MemberStatsView';
import { StatsSkeleton } from './Skeleton';
import { WindowFilter } from './WindowFilter';

const MAX_NAME = 60;

function firstParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * An organizer looking at one member. Reuses the "my participation" cards and
 * chart and the attendance history, with a header that says whose numbers
 * these are.
 */
export function MemberDetailScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const params = useLocalSearchParams<{ userId?: string; name?: string }>();
  const memberId = firstParam(params.userId);
  const routeName = firstParam(params.name);
  const { community, isOrganizer } = useCurrentMembership();
  const [window] = useStatsWindow();
  const stats = useMemberStatistics(community?.id ?? null, memberId, window, isOrganizer);
  const history = useMemberAttendanceHistory(community?.id ?? null, memberId, window, isOrganizer);
  // The name comes from the server (the member list); the route parameter is only a fallback
  // (removed members are not in the list).
  const summary = useMemberSummary(community?.id ?? null, window, isOrganizer);
  const serverName = summary.data?.members.find((row) => row.user_id === memberId)?.display_name;
  const name = (serverName ?? routeName ?? 'This member').slice(0, MAX_NAME);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/statistics');
  };
  const refetch = () => {
    stats.refetch().catch((error: unknown) => reportError('statistics.member', error));
    history.query.refetch().catch((error: unknown) => reportError('statistics.memberHistory', error));
  };

  let body;
  if (!isOrganizer) {
    body = (
      <EmptyState title="Organizers only" message="Member statistics are only available to organizers." />
    );
  } else if (stats.data) {
    body = (
      <View style={{ gap: spacing.lg }}>
        {stats.data.membership_status === 'removed' ? (
          <Banner tone="info" message={`${name} was removed from the community. Their past attendance is shown.`} />
        ) : null}
        <MemberStatsView stats={stats.data} subject={name} />
        <HistorySection history={history} errorTitle="Could not load this member's history" />
      </View>
    );
  } else if (stats.isPending) {
    body = <StatsSkeleton />;
  } else {
    const error = toAppError(stats.error);
    if (error.code === 'forbidden') {
      body = (
        <EmptyState title="Organizers only" message="Member statistics are only available to organizers." />
      );
    } else if (error.code === 'not_found') {
      body = <EmptyState title="Member not found" message="This member is not part of your community." />;
    } else {
      body = (
        <ErrorState
          title="Could not load statistics"
          message={userMessage(error.code, error.field)}
          onRetry={refetch}
        />
      );
    }
  }

  return (
    <Screen scroll onRefresh={refetch} refreshing={stats.isRefetching && !stats.isPending}>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={goBack} />
      </View>
      <View style={{ gap: spacing.xs }}>
        <Text variant="title">{name}</Text>
        {isOrganizer ? (
          <Text variant="caption" color="textMuted">
            Organizer view of this member&apos;s participation for {windowPhrase(window)}.
          </Text>
        ) : null}
      </View>
      <WindowFilter />
      {body}
    </Screen>
  );
}
