import { useRouter } from 'expo-router';

import { workoutLogHref } from '@/features/notifications/components/routes';
import { Card, Icon, ListItem } from '@/ui';

import { useWorkoutLogScreen } from '../hooks/useWorkoutLogs';

/**
 * Entry on the event details: "Log your workout" / "Edit your workout log". Shown only when
 * the server says the person can log (or already has a log). Nothing is shown while loading,
 * on an error, or when logging is not possible: the log screen explains that when it is opened
 * from a notification.
 */
export function WorkoutLogEntry({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const query = useWorkoutLogScreen(sessionId);
  const screen = query.data;
  if (!screen || (!screen.can_log && screen.log === null)) return null;

  const hasLog = screen.log !== null;
  const title = hasLog ? 'Edit your workout log' : 'Log your workout';
  return (
    <Card>
      <ListItem
        title={title}
        subtitle={hasLog ? 'Private to you' : 'How did it go? Private to you.'}
        leading={<Icon name="edit" size={22} color="primary" />}
        onPress={() => router.push(workoutLogHref(sessionId))}
        accessibilityLabel={title}
        testID="workout-log-entry"
      />
    </Card>
  );
}
