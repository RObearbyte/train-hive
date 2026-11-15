import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import type { CommunityStatistics, StatisticsWindow } from '@/lib/database.types';
import { formatDateTime, isValidTimeZone } from '@/lib/datetime';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Card, Divider, EmptyState, ErrorState, Text, useTheme } from '@/ui';

import { countScale } from '../domain/chart';
import { CONVERSION_HELP, EMPTY_STATS, incompleteNote } from '../domain/copy';
import {
  formatCount,
  formatDecimal,
  formatPercent,
  ofCount,
  sessionsText,
  formatTickValue,
  smallRsvpSampleLabel,
} from '../domain/format';
import { axisLabels } from '../domain/periods';
import { presentText, trendSummary, visibleTopSessions } from '../domain/summaries';
import { useCommunityStatistics } from '../hooks/useStatistics';
import { BarChart } from './BarChart';
import { MemberList } from './MemberList';
import { StatsSkeleton } from './Skeleton';
import { StatCard, StatGrid } from './StatCard';

function Overview({ stats }: { stats: CommunityStatistics }) {
  const router = useRouter();
  const { spacing, minTouchTarget } = useTheme();
  const top = visibleTopSessions(stats.top_sessions);
  const excluded = incompleteNote(stats.incomplete_sessions);
  const conversionSample = smallRsvpSampleLabel(stats.rsvp_going_recorded);
  const unit = stats.trend_unit === 'month' ? 'month' : 'week';
  const averages = stats.trend.map((bucket) => bucket.average_attendees);
  const hasSessions = stats.completed_trainings > 0;

  return (
    <View style={{ gap: spacing.lg }}>
      {hasSessions ? null : <Banner tone="info" message={EMPTY_STATS} />}

      <StatGrid>
        <StatCard label="Completed trainings" value={formatCount(stats.completed_trainings)} />
        <StatCard label="Total attendances" value={formatCount(stats.total_attendances)} detail="people present" />
        <StatCard
          label="Average attendees per training"
          value={formatDecimal(stats.average_attendees)}
          detail={
            stats.average_attendees === null
              ? null
              : `across ${sessionsText(stats.average_attendees_sessions)}`
          }
          note={excluded}
        />
        <StatCard
          label="Average RSVP participation"
          value={formatDecimal(stats.average_rsvp_participation)}
          detail="said going per training"
        />
        <StatCard
          label="RSVP to attendance"
          value={formatPercent(stats.rsvp_conversion)}
          detail={
            stats.rsvp_going_recorded > 0
              ? ofCount(stats.rsvp_going_present, stats.rsvp_going_recorded, 'recorded going RSVPs')
              : 'No recorded going RSVPs yet'
          }
          note={conversionSample}
          help={CONVERSION_HELP}
        />
        <StatCard
          label="Active members"
          value={formatCount(stats.active_members)}
          detail={`${formatCount(stats.members_attended)} attended in this period`}
        />
        <StatCard
          label="Cancelled, too few signed up"
          value={formatCount(stats.cancelled_insufficient_participation)}
          note={`${formatCount(stats.cancelled_by_organizer)} cancelled by an organizer`}
        />
      </StatGrid>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Attendance trend</Text>
        <Text variant="caption" color="textMuted">
          Average attendees per {unit}. A dash means no sessions, or none with attendance marked.
        </Text>
        <Card>
          {stats.trend.length === 0 ? (
            <Text color="textMuted">No {unit}s to show yet.</Text>
          ) : (
            <BarChart
              values={averages}
              axisLabels={axisLabels(
                stats.trend.map((bucket) => bucket.period),
                unit,
              )}
              valueLabels={averages.map((value) => formatDecimal(value))}
              captions={stats.trend.map((bucket) =>
                bucket.sessions > 0 ? sessionsText(bucket.sessions) : null,
              )}
              scale={countScale(averages)}
              formatTick={formatTickValue}
              accessibilitySummary={trendSummary(stats.trend, unit)}
            />
          )}
        </Card>
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Most attended trainings</Text>
        {top.length === 0 ? (
          <Text color="textMuted">No trainings with recorded attendance in this period.</Text>
        ) : (
          <Card style={{ paddingVertical: spacing.xs }}>
            {top.map((session, index) => {
              const zone = isValidTimeZone(session.timezone) ? session.timezone : 'UTC';
              const when = formatDateTime(session.starts_at, zone);
              return (
                <View key={session.session_id}>
                  {index > 0 ? <Divider /> : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${index + 1}. ${session.title}, ${when}, ${presentText(session.present)}, minimum ${session.min_participants}`}
                    onPress={() => router.push(`/trainings/${session.session_id}`)}
                    style={({ pressed }) => ({
                      minHeight: minTouchTarget + 12,
                      paddingVertical: spacing.sm,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.md,
                      opacity: pressed ? 0.8 : 1,
                    })}
                  >
                    <Text variant="heading" color="textMuted" style={{ width: 24 }}>
                      {index + 1}
                    </Text>
                    <View style={{ flex: 1, gap: spacing.xxs }}>
                      <Text variant="label">{session.title}</Text>
                      <Text variant="caption" color="textMuted">
                        {when} {'·'} minimum {session.min_participants}
                      </Text>
                    </View>
                    <Text variant="label">{presentText(session.present)}</Text>
                  </Pressable>
                </View>
              );
            })}
          </Card>
        )}
      </View>
    </View>
  );
}

/** Organizers: the community numbers, the attendance trend and the member list. */
export function CommunityOverview({
  communityId,
  window,
}: {
  communityId: string | null;
  window: StatisticsWindow;
}) {
  const { spacing } = useTheme();
  const stats = useCommunityStatistics(communityId, window, true);

  if (stats.isPending) return <StatsSkeleton label="Loading community overview" />;

  if (!stats.data) {
    const error = toAppError(stats.error);
    if (error.code === 'forbidden') {
      // The server decides who is an organizer; it may have changed since this screen loaded.
      return (
        <EmptyState
          title="Organizers only"
          message="The community overview is only available to organizers."
        />
      );
    }
    return (
      <ErrorState
        title="Could not load the overview"
        message={userMessage(error.code, error.field)}
        onRetry={() => {
          stats.refetch().catch((e: unknown) => reportError('statistics.community', e));
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
              stats.refetch().catch((e: unknown) => reportError('statistics.community', e));
            },
          }}
        />
      ) : null}
      <Overview stats={stats.data} />
      <MemberList communityId={communityId} window={window} />
    </View>
  );
}
