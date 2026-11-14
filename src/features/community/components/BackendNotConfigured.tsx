import { View } from 'react-native';

import { Banner, Screen, Text, useTheme } from '@/ui';

/** Shown instead of the app when the Supabase env vars are missing. */
export function BackendNotConfigured() {
  const { spacing } = useTheme();
  return (
    <Screen scroll>
      <View style={{ flex: 1, justifyContent: 'center', gap: spacing.lg }}>
        <Text variant="title">Backend not configured</Text>
        <Text color="textMuted">
          TrainHive needs a Supabase project to run. Follow the steps in docs/SUPABASE_SETUP.md,
          then restart the app.
        </Text>
        <Banner
          tone="warning"
          title="Missing settings"
          message="Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in .env.local (copy .env.example), then stop and start the dev server."
        />
      </View>
    </Screen>
  );
}
