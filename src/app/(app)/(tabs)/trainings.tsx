import { EmptyState, Screen, Text } from '@/ui';

// Upcoming / past lists arrive with M1-A2.
export default function TrainingsScreen() {
  return (
    <Screen scroll edges={['top', 'left', 'right']}>
      <Text variant="title">Trainings</Text>
      <EmptyState
        title="No trainings yet"
        message="Upcoming and past trainings will be listed here."
        style={{ flex: 1 }}
      />
    </Screen>
  );
}
