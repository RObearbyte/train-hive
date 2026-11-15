import { Stack } from 'expo-router';

import { PushProvider } from '@/features/notifications/hooks/PushProvider';
import { useActivityRealtime } from '@/features/notifications/hooks/useActivityRealtime';
import { useNotificationLinks } from '@/features/notifications/hooks/useNotificationLinks';
import { useTrainingsRealtime } from '@/features/trainings/hooks/useTrainingsRealtime';
import { useTheme } from '@/ui';

export const unstable_settings = { anchor: '(tabs)' };

function AppStack() {
  const { colors } = useTheme();
  // Live channels for the whole signed-in area; they close when this layout unmounts.
  useTrainingsRealtime();
  useActivityRealtime();
  // Notification taps (including a cold start) -> allowlisted deep links.
  useNotificationLinks();

  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    />
  );
}

/** Everything behind the membership gate. Detail and form screens are pushed above the tabs. */
export default function AppLayout() {
  return (
    <PushProvider>
      <AppStack />
    </PushProvider>
  );
}
