import { Stack } from 'expo-router';

import { useTheme } from '@/ui';

export const unstable_settings = { anchor: '(tabs)' };

/** Everything behind the membership gate. Detail and form screens are pushed above the tabs. */
export default function AppLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    />
  );
}
