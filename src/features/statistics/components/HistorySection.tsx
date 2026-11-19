import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import type { AttendanceHistoryItem, AttendanceHistoryPage, AttendanceStatus } from '@/lib/database.types';
import { formatDateTime, isValidTimeZone } from '@/lib/datetime';
import { kindLabel } from '@/features/trainings/domain/events';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import {
  Banner,
  Button,
  Card,
  Divider,
  ErrorState,
  Icon,
  LoadingState,
  Text,
  useTheme,
  type ColorToken,
  type IconName,
} from '@/ui';

import { KindChip } from '@/features/trainings/components/KindChip';

import { HISTORY_EMPTY } from '../domain/copy';
import { outcomeLabel, rsvpLabel } from '../domain/summaries';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';

import type { AppError } from '@/lib/errors';

const OUTCOME_STYLE: Record<AttendanceStatus, { icon: IconName; fg: ColorToken; bg: ColorToken }> = {
  present: { icon: 'check-circle', fg: 'success', bg: 'successSoft' },
  absent: { icon: 'close', fg: 'danger', bg: 'dangerSoft' },
  // Neutral on purpose: not recorded is not a miss.
  unrecorded: { icon: 'circle', fg: 'textMuted', bg: 'surface' },
};

/** Glyph + word, never color alone. */
function OutcomeChip({ outcome }: { outcome: AttendanceStatus }) {
  const { colors, radii, spacing } = useTheme();
  const style = OUTCOME_STYLE[outcome] ?? OUTCOME_STYLE.unrecorded;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radii.pill,
        backgroundColor: colors[style.bg],
        borderWidth: 1,
        borderColor: outcome === 'unrecorded' ? colors.borderStrong : colors[style.bg],
      }}
    >
      <Icon name={style.icon} size={16} color={style.fg} />
      <Text variant="caption" color={outcome === 'unrecorded' ? 'textMuted' : 'text'} style={{ fontWeight: '700' }}>
        {outcomeLabel(outcome)}
      </Text>
    </View>
  );
}

function HistoryRow({ item }: { item: AttendanceHistoryItem }) {
  const router = useRouter();
  const { spacing, minTouchTarget } = useTheme();
  const zone = isValidTimeZone(item.timezone) ? item.timezone : 'UTC';
  const when = formatDateTime(item.starts_at, zone);
  const rsvp = rsvpLabel(item.rsvp_response);
  const detail = [when, rsvp, item.is_walk_in ? 'Walk-in' : null].filter(Boolean).join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${kindLabel(item.event_kind)}: ${item.title}, ${detail}, ${outcomeLabel(item.outcome)}`}
      onPress={() => router.push(`/trainings/${item.session_id}`)}
      style={({ pressed }) => ({
        minHeight: minTouchTarget + 12,
        paddingVertical: spacing.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View style={{ flex: 1, gap: spacing.xxs }}>
        <Text variant="label">{item.title}</Text>
        <Text variant="caption" color="textMuted">
          {detail}
        </Text>
        <KindChip kind={item.event_kind} />
      </View>
      <OutcomeChip outcome={item.outcome} />
    </Pressable>
  );
}

/**
 * "History": finalized events in the window, newest first, loaded page by page.
 * The caller supplies the query (mine, or an organizer's view of one member).
 */
export function HistorySection({
  history,
  errorTitle = 'Could not load your history',
}: {
  history: {
    query: UseInfiniteQueryResult<InfiniteData<AttendanceHistoryPage, string | null>, AppError>;
    items: AttendanceHistoryItem[];
  };
  errorTitle?: string;
}) {
  const { spacing } = useTheme();
  const { query, items } = history;

  let body;
  if (query.isPending) {
    body = <LoadingState message="Loading history" />;
  } else if (query.isError && items.length === 0) {
    body = (
      <ErrorState
        title={errorTitle}
        message={userMessage(toAppError(query.error).code)}
        onRetry={() => {
          query.refetch().catch((error: unknown) => reportError('statistics.history', error));
        }}
      />
    );
  } else if (items.length === 0) {
    body = <Text color="textMuted">{HISTORY_EMPTY}</Text>;
  } else {
    body = (
      <>
        <Card style={{ paddingVertical: spacing.xs }}>
          {items.map((item, index) => (
            <View key={item.session_id}>
              {index > 0 ? <Divider /> : null}
              <HistoryRow item={item} />
            </View>
          ))}
        </Card>
        {query.isRefetchError ? (
          <Banner
            tone="warning"
            message={`${userMessage(toAppError(query.error).code)} Showing the last history that loaded.`}
            action={{
              label: 'Try again',
              onPress: () => {
                query.refetch().catch((error: unknown) => reportError('statistics.history', error));
              },
            }}
          />
        ) : null}
        {query.isFetchNextPageError ? (
          <Banner
            tone="warning"
            message={`More events could not be loaded. ${userMessage(toAppError(query.error).code)}`}
          />
        ) : null}
        {query.hasNextPage ? (
          <Button
            label="Load more"
            variant="secondary"
            fullWidth
            loading={query.isFetchingNextPage}
            onPress={() => {
              query.fetchNextPage().catch((error: unknown) => reportError('statistics.historyMore', error));
            }}
          />
        ) : null}
      </>
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="heading">History</Text>
      {body}
    </View>
  );
}
