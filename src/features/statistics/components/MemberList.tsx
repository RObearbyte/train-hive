import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import type { MemberStatisticsSummaryRow, StatisticsWindow } from '@/lib/database.types';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Avatar, Card, Divider, ErrorState, Icon, LoadingState, Text, useTheme } from '@/ui';

import { MEMBER_LIST_NOTE, truncatedNote } from '../domain/copy';
import { formatPercent, smallSampleLabel } from '../domain/format';
import { memberLine, memberRowLabel } from '../domain/summaries';
import { useMemberSummary } from '../hooks/useStatistics';

function MemberRow({ row }: { row: MemberStatisticsSummaryRow }) {
  const router = useRouter();
  const { spacing, minTouchTarget } = useTheme();
  const sample = smallSampleLabel(row.eligible);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={memberRowLabel(row)}
      accessibilityHint="Opens this member's participation"
      onPress={() =>
        router.push({
          pathname: '/statistics/[userId]',
          params: { userId: row.user_id, name: row.display_name },
        })
      }
      style={({ pressed }) => ({
        minHeight: minTouchTarget + 12,
        paddingVertical: spacing.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Avatar name={row.display_name} size={36} />
      <View style={{ flex: 1, gap: spacing.xxs }}>
        <Text variant="label">{row.display_name}</Text>
        <Text variant="caption" color="textMuted">
          {memberLine(row)}
          {sample ? ` · ${sample}` : ''}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text variant="heading">{formatPercent(row.attendance_rate)}</Text>
        {row.not_recorded > 0 ? (
          <Text variant="caption" color="textMuted">
            {row.not_recorded} not recorded
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-right" size={18} color="textMuted" />
    </Pressable>
  );
}

/** Organizers: every active member's participation, by name; tap a member for detail. */
export function MemberList({
  communityId,
  window,
}: {
  communityId: string | null;
  window: StatisticsWindow;
}) {
  const { spacing } = useTheme();
  const summary = useMemberSummary(communityId, window, true);

  let body;
  if (summary.isPending) {
    body = <LoadingState message="Loading members" />;
  } else if (!summary.data) {
    body = (
      <ErrorState
        title="Could not load members"
        message={userMessage(toAppError(summary.error).code)}
        onRetry={() => {
          summary.refetch().catch((error: unknown) => reportError('statistics.members', error));
        }}
      />
    );
  } else if (summary.data.members.length === 0) {
    body = <Text color="textMuted">No active members yet.</Text>;
  } else {
    const { members, total_members: total, truncated } = summary.data;
    const note = truncated ? truncatedNote(members.length, total) : null;
    body = (
      <>
        <Card style={{ paddingVertical: spacing.xs }}>
          {members.map((row, index) => (
            <View key={row.user_id}>
              {index > 0 ? <Divider /> : null}
              <MemberRow row={row} />
            </View>
          ))}
        </Card>
        {note ? (
          <Text variant="caption" color="textMuted">
            {note}
          </Text>
        ) : null}
      </>
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="heading">Members</Text>
      <Text variant="caption" color="textMuted">
        {MEMBER_LIST_NOTE}
      </Text>
      {body}
    </View>
  );
}
