import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { needsAttendance } from '@/features/attendance/domain/sheet';
import { QuickInvite } from '@/features/invitations/components/QuickInvite';
import { FAB_CLEARANCE } from '@/features/invitations/domain/quickInvite';
import { ScreenHeader } from '@/features/shell/components/ScreenHeader';
import { TrainingCard } from '@/features/trainings/components/TrainingCard';
import {
  KIND_FILTER_OPTIONS,
  filterByKind,
  kindInfo,
  type KindFilter,
} from '@/features/trainings/domain/events';
import { useCommunityTrainings } from '@/features/trainings/hooks/useTrainings';
import { userMessage } from '@/lib/errors';
import { useNow } from '@/lib/useNow';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  SegmentedControl,
  useTheme,
} from '@/ui';

type Section = 'upcoming' | 'past';

const KIND_OPTIONS = KIND_FILTER_OPTIONS.map((option) =>
  option.value === 'sports_event'
    ? { ...option, accessibilityLabel: 'Sports events' }
    : option,
);

const SECTIONS = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
] as const;

export default function TrainingsScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const now = useNow();
  const { isOrganizer } = useCurrentMembership();
  const trainings = useCommunityTrainings(now);
  const [section, setSection] = useState<Section>('upcoming');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  const inSection = section === 'upcoming' ? trainings.upcoming : trainings.past;
  const sessions = filterByKind(inSection, kindFilter);
  const hasData = trainings.upcoming.length + trainings.past.length > 0;

  const header = (
    <View style={{ gap: spacing.lg }}>
      <ScreenHeader
        title="Events"
        actions={
          isOrganizer ? (
            <Button
              label="New event"
              icon="plus"
              size="sm"
              onPress={() => router.push('/trainings/new')}
            />
          ) : undefined
        }
      />
      <SegmentedControl
        options={SECTIONS}
        value={section}
        onChange={setSection}
        accessibilityLabel="Which events to show"
      />
      <SegmentedControl
        options={KIND_OPTIONS}
        value={kindFilter}
        onChange={setKindFilter}
        accessibilityLabel="Filter by kind of event"
      />
      {/* Showing what is cached while the latest refresh failed. */}
      {trainings.error && hasData ? (
        <Banner
          tone="warning"
          message={userMessage(trainings.error.code, trainings.error.field)}
          action={{ label: 'Try again', onPress: trainings.refetch }}
        />
      ) : null}
    </View>
  );

  let empty;
  if (trainings.error && !hasData) {
    empty = (
      <ErrorState
        message={userMessage(trainings.error.code, trainings.error.field)}
        onRetry={trainings.refetch}
        style={{ flex: 1 }}
      />
    );
  } else if (trainings.isLoading) {
    empty = <LoadingState message="Loading events" style={{ flex: 1 }} />;
  } else if (kindFilter !== 'all' && inSection.length > 0) {
    const plural = kindInfo(kindFilter).plural.toLowerCase();
    empty = (
      <EmptyState
        title={section === 'upcoming' ? `No upcoming ${plural}` : `No past ${plural}`}
        message="Choose All to see every kind of event."
        action={{ label: 'Show all', onPress: () => setKindFilter('all') }}
        style={{ flex: 1 }}
      />
    );
  } else if (section === 'upcoming') {
    empty = (
      <EmptyState
        title="Nothing planned yet"
        message={
          isOrganizer
            ? 'Events you plan will show up here for the whole community.'
            : 'When your organizer plans an event, it will show up here.'
        }
        action={
          isOrganizer
            ? { label: 'Create an event', onPress: () => router.push('/trainings/new') }
            : undefined
        }
        style={{ flex: 1 }}
      />
    );
  } else {
    empty = (
      <EmptyState
        title="No past events"
        message="Events appear here once they are over."
        style={{ flex: 1 }}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Screen padded={false} edges={['top', 'left', 'right']}>
        <FlatList
          data={sessions}
          keyExtractor={(session) => session.id}
          renderItem={({ item }) => (
            <TrainingCard
              session={item}
              myResponse={trainings.myResponse(item.id)}
              now={now}
              showRsvp={section === 'upcoming'}
              needsAttendance={isOrganizer && needsAttendance(item, now)}
              onPress={() => router.push(`/trainings/${item.id}`)}
            />
          )}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={{
            flexGrow: 1,
            padding: spacing.lg,
            paddingBottom: spacing.lg + (isOrganizer ? FAB_CLEARANCE : 0),
            gap: spacing.lg,
          }}
          refreshControl={
            <RefreshControl
              refreshing={trainings.isRefetching}
              onRefresh={trainings.refetch}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        />
      </Screen>
    <QuickInvite />
    </View>
  );
}
