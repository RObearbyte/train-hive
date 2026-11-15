import { Stack } from 'expo-router';

import { useTrainingsRealtime } from '@/features/trainings/hooks/useTrainingsRealtime';
import { useTheme } from '@/ui';

export const unstable_settings = { anchor: '(tabs)' };

/** Everything behind the membership gate. Detail and form screens are pushed above the tabs. */
export default function AppLayout() {
  const { colors } = useTheme();
  // One live channel for the whole signed-in area; it closes when this layout unmounts.
  useTrainingsRealtime();

  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    />
  );
}
