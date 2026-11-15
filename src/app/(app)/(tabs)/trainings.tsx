import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { TrainingCard } from '@/features/trainings/components/TrainingCard';
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
  Text,
  useTheme,
} from '@/ui';

type Section = 'upcoming' | 'past';

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

  const sessions = section === 'upcoming' ? trainings.upcoming : trainings.past;
  const hasData = trainings.upcoming.length + trainings.past.length > 0;

  const header = (
    <View style={{ gap: spacing.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Text variant="title" style={{ flex: 1 }}>
          Trainings
        </Text>
        {isOrganizer ? (
          <Button
            label="New training"
            icon="plus"
            size="sm"
            onPress={() => router.push('/trainings/new')}
          />
        ) : null}
      </View>
      <SegmentedControl
        options={SECTIONS}
        value={section}
        onChange={setSection}
        accessibilityLabel="Which trainings to show"
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
    empty = <LoadingState message="Loading trainings" style={{ flex: 1 }} />;
  } else if (section === 'upcoming') {
    empty = (
      <EmptyState
        title="Nothing planned yet"
        message={
          isOrganizer
            ? 'Trainings you plan will show up here for the whole community.'
            : 'When your organizer plans a training, it will show up here.'
        }
        action={
          isOrganizer
            ? { label: 'Create a training', onPress: () => router.push('/trainings/new') }
            : undefined
        }
        style={{ flex: 1 }}
      />
    );
  } else {
    empty = (
      <EmptyState
        title="No past trainings"
        message="Trainings appear here once they are over."
        style={{ flex: 1 }}
      />
    );
  }

  return (
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
            onPress={() => router.push(`/trainings/${item.id}`)}
          />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={{ flexGrow: 1, padding: spacing.lg, gap: spacing.lg }}
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
  );
}
