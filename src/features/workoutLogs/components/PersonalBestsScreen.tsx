import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';

import { workoutLogHref } from '@/features/notifications/components/routes';
import { deviceTimeZone, formatShortDate } from '@/lib/datetime';
import { reportError } from '@/lib/logger';
import { Banner, Button, Card, Divider, ErrorState, ListItem, LoadingState, Screen, Text, useTheme } from '@/ui';

import {
  LIFT_RECORDS_HELP,
  RECORDS_PRIVACY_NOTE,
  RUNNING_RECORDS_HELP,
  hasLiftRecords,
  hasRunningRecords,
  liftRows,
  runningRows,
  type LiftRow,
} from '../domain/personalRecords';
import { workoutLogErrorMessage } from '../domain/workoutLog';
import { useMyPersonalRecords } from '../hooks/useWorkoutLogs';

/** "Personal bests": my running bests and lift records, each linked to the log it comes from. */
export function PersonalBestsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const query = useMyPersonalRecords();
  const zone = deviceTimeZone() ?? 'UTC';
  const dateText = (iso: string) => formatShortDate(iso, zone);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/profile' as Href);
  };

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
    const records = query.data;
    const running = runningRows(records.running);
    const lifts = liftRows(records, dateText);
    body = (
      <View style={{ gap: spacing.lg }}>
        {query.isError ? (
          <Banner tone="warning" message={`${workoutLogErrorMessage(query.error)} Showing the records that loaded.`} />
        ) : null}

        <View style={{ gap: spacing.sm }}>
          <Text variant="heading" accessibilityRole="header">
            Running
          </Text>
          {hasRunningRecords(records.running) ? null : (
            <Text color="textMuted">No running records yet. Log a run or a race with its distance and time.</Text>
          )}
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {running.map((row, index) => {
              const record = row.record;
              const meta = record ? `${record.event_title}, ${dateText(record.event_starts_at)}` : 'No record yet';
              const subtitle = row.detail ? `${row.detail} · ${meta}` : meta;
              return (
                <View key={row.key}>
                  {index > 0 ? <Divider /> : null}
                  <ListItem
                    title={`${row.label}: ${row.value}`}
                    subtitle={subtitle}
                    onPress={record ? () => router.push(workoutLogHref(record.session_id)) : undefined}
                    accessibilityLabel={record ? `${row.spoken}. ${meta}. Opens the log` : row.spoken}
                    testID={`record-${row.key}`}
                  />
                </View>
              );
            })}
          </Card>
          <Text variant="caption" color="textMuted">
            {RUNNING_RECORDS_HELP}
          </Text>
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="heading" accessibilityRole="header">
            Lifts
          </Text>
          {hasLiftRecords(records) ? null : (
            <Text color="textMuted">
              No lift records yet. After you save a strength log with heavy sets of 1 to 3 reps, answer Yes for the sets that
              were a maximal effort.
            </Text>
          )}
          <Card style={{ gap: spacing.md }}>
            {lifts.map((row, index) => (
              <View key={row.lift} style={{ gap: spacing.md }}>
                {index > 0 ? <Divider /> : null}
                <LiftRecordRow row={row} dateText={dateText} />
              </View>
            ))}
          </Card>
          <Text variant="caption" color="textMuted">
            {LIFT_RECORDS_HELP}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <Screen
      scroll
      onRefresh={() => {
        query.refetch().catch((error: unknown) => reportError('workoutLogs.recordsRefresh', error));
      }}
      refreshing={query.isRefetching}
    >
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={leave} />
      </View>
      <Text variant="title">Personal bests</Text>
      <Text color="textMuted">{RECORDS_PRIVACY_NOTE}</Text>
      {body}
    </Screen>
  );
}

function LiftRecordRow({ row, dateText }: { row: LiftRow; dateText: (iso: string) => string }) {
  const { spacing } = useTheme();
  return (
    <View accessible accessibilityLabel={row.spoken} style={{ gap: spacing.xs }}>
      <Text variant="label">{row.label}</Text>
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        {row.cells.map((cell) => (
          <View key={cell.reps} style={{ flex: 1, gap: 2 }}>
            <Text variant="caption" color="textMuted">
              {cell.label}
            </Text>
            <Text variant="heading">{cell.value}</Text>
            <Text variant="caption" color="textMuted">
              {cell.record ? dateText(cell.record.achieved_at) : ' '}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
