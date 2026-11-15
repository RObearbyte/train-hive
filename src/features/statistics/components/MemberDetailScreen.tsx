import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, EmptyState, ErrorState, Screen, Text, useTheme } from '@/ui';

import { windowPhrase } from '../domain/windows';
import { useMemberStatistics, useStatsWindow } from '../hooks/useStatistics';
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
 * chart, with a header that says whose numbers these are. The attendance
 * history list is only available for oneself (there is no RPC for others).
 */
export function MemberDetailScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const params = useLocalSearchParams<{ userId?: string; name?: string }>();
  const memberId = firstParam(params.userId);
  const name = (firstParam(params.name) ?? 'This member').slice(0, MAX_NAME);
  const { community, isOrganizer } = useCurrentMembership();
  const [window] = useStatsWindow();
  const stats = useMemberStatistics(community?.id ?? null, memberId, window, isOrganizer);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/statistics');
  };
  const refetch = () => {
    stats.refetch().catch((error: unknown) => reportError('statistics.member', error));
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
          <Banner tone="info" message={`${name} has left the community. Their past attendance is shown.`} />
        ) : null}
        <MemberStatsView stats={stats.data} subject={name} />
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
