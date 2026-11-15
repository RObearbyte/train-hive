import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { SectionList, View } from 'react-native';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { formatDateTime, isValidTimeZone } from '@/lib/datetime';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, EmptyState, ErrorState, Icon, ListItem, LoadingState, Screen, Text, useTheme, type ColorToken, type IconName } from '@/ui';

import type { MyAttendanceItem } from '../api/attendance';
import { countByStatus, countsLine, groupByMonth } from '../domain/history';
import { statusLabel } from '../domain/sheet';
import { useMyAttendance } from '../hooks/useAttendanceSheet';

const STATUS_STYLE: Record<MyAttendanceItem['status'], { icon: IconName; color: ColorToken }> = {
  present: { icon: 'check-circle', color: 'success' },
  absent: { icon: 'close', color: 'danger' },
  unrecorded: { icon: 'circle', color: 'textMuted' },
};

/**
 * My attendance in finalized trainings, grouped by month. "Not recorded" is
 * shown as such and never as a miss: nobody marked it, which says nothing
 * about whether I came. Per-status counts only; statistics arrive later.
 */
export function AttendanceHistoryScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { userId } = useSession();
  const history = useMyAttendance(userId);

  const items = history.data;
  const sections = useMemo(
    () => groupByMonth(items ?? []).map((group) => ({ title: group.label, data: group.items })),
    [items],
  );
  const counts = useMemo(() => countByStatus(items ?? []), [items]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/profile');
  };
  const refetch = () => {
    history.refetch().catch((error: unknown) => reportError('attendance.history', error));
  };

  const back = (
    <View style={{ alignItems: 'flex-start' }}>
      <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={goBack} />
    </View>
  );

  if (history.isPending) {
    return (
      <Screen>
        {back}
        <LoadingState message="Loading your attendance" style={{ flex: 1 }} />
      </Screen>
    );
  }
  if (!items) {
    const error = toAppError(history.error);
    return (
      <Screen>
        {back}
        <ErrorState
          title="Could not load your attendance"
          message={userMessage(error.code, error.field)}
          onRetry={refetch}
          style={{ flex: 1 }}
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.recordId}
        stickySectionHeadersEnabled={false}
        onRefresh={refetch}
        refreshing={history.isRefetching}
        contentContainerStyle={{ flexGrow: 1, padding: spacing.lg, gap: spacing.xs }}
        ListHeaderComponent={
          <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
            {back}
            <Text variant="title">My attendance</Text>
            {history.isError ? (
              <Banner
                tone="warning"
                message={`${userMessage(toAppError(history.error).code)} Showing the last list that loaded.`}
                action={{ label: 'Try again', onPress: refetch }}
              />
            ) : null}
            {items.length > 0 ? (
              <View style={{ gap: spacing.xs }}>
                <Text variant="label">{countsLine(counts)}</Text>
                <Text variant="caption" color="textMuted">
                  Only trainings your organizer has finalized appear here. Not recorded means
                  nobody marked it; it is not counted as a miss.
                </Text>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title="No attendance yet"
            message="Trainings show up here after your organizer finalizes their attendance."
          />
        }
        renderSectionHeader={({ section }) => (
          <Text variant="heading" style={{ paddingTop: spacing.md, paddingBottom: spacing.xs }}>
            {section.title}
          </Text>
        )}
        renderItem={({ item, index, section }) => {
          const zone = isValidTimeZone(item.session.timezone) ? item.session.timezone : 'UTC';
          const style = STATUS_STYLE[item.status];
          return (
            <View
              style={{
                borderTopLeftRadius: index === 0 ? 12 : 0,
                borderTopRightRadius: index === 0 ? 12 : 0,
                borderBottomLeftRadius: index === section.data.length - 1 ? 12 : 0,
                borderBottomRightRadius: index === section.data.length - 1 ? 12 : 0,
                overflow: 'hidden',
              }}
            >
              <ListItem
                title={item.session.title}
                subtitle={`${formatDateTime(item.session.startsAt, zone)} · ${item.session.locationName}`}
                accessibilityLabel={`${item.session.title}, ${formatDateTime(item.session.startsAt, zone)}, ${statusLabel(item.status)}`}
                trailing={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                    <Icon name={style.icon} size={18} color={style.color} />
                    <Text variant="label" color={item.status === 'unrecorded' ? 'textMuted' : 'text'}>
                      {statusLabel(item.status)}
                    </Text>
                  </View>
                }
                onPress={() => router.push(`/trainings/${item.session.id}`)}
                showChevron={false}
              />
            </View>
          );
        }}
      />
    </Screen>
  );
}
