import { Stack } from 'expo-router';

import { OnboardingProvider } from '@/features/onboarding/hooks/OnboardingProvider';
import { useTheme } from '@/ui';

/**
 * Join another community / create a community, for someone who already has
 * one. Lives inside (app) so the root gate never moves them; the accepted
 * code is held in memory by the provider for the length of the flow.
 */
export default function AddCommunityLayout() {
  const { colors } = useTheme();
  return (
    <OnboardingProvider>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </OnboardingProvider>
  );
}
