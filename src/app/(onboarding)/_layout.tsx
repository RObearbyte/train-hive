import { Stack } from 'expo-router';

import { ContentColumn } from '@/features/shell/components/ContentColumn';
import { useLayout } from '@/features/shell/hooks/useLayout';
import { OnboardingProvider } from '@/features/onboarding/hooks/OnboardingProvider';
import { useTheme } from '@/ui';

// Where the root gate lands when it sends someone to onboarding.
export const unstable_settings = { anchor: 'welcome' };

export default function OnboardingLayout() {
  const { colors } = useTheme();
  const { onboardingMaxWidth } = useLayout();
  return (
    <OnboardingProvider>
      <ContentColumn maxWidth={onboardingMaxWidth}>
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
        />
      </ContentColumn>
    </OnboardingProvider>
  );
}
