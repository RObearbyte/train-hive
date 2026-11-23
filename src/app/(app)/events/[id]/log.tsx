import { useLocalSearchParams } from 'expo-router';

import { WorkoutLogScreen } from '@/features/workoutLogs/components/WorkoutLogScreen';

/** The workout log of an event (also the target of the `/events/<id>/log` notification link). */
export default function WorkoutLogRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <WorkoutLogScreen sessionId={id} />;
}
