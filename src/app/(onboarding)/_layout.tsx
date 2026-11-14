import { Stack } from 'expo-router';

import { OnboardingProvider } from '@/features/onboarding/hooks/OnboardingProvider';
import { useTheme } from '@/ui';

// Where the root gate lands when it sends someone to onboarding.
export const unstable_settings = { anchor: 'welcome' };

export default function OnboardingLayout() {
  const { colors } = useTheme();
  return (
    <OnboardingProvider>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </OnboardingProvider>
  );
}
