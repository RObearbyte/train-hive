import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandHero } from '@/features/onboarding/components/BrandHero';
import { Button, Text, useTheme } from '@/ui';

export default function WelcomeScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* The hero is navy in both themes. */}
      <StatusBar style="light" />
      <BrandHero />
      <SafeAreaView
        edges={['bottom', 'left', 'right']}
        style={{ padding: spacing.xl, gap: spacing.lg }}
      >
        <Text variant="title">Train with your pack</Text>
        <Text color="textMuted">
          See what is planned, say if you are in, and know for sure when a training is on.
        </Text>
        <Button
          label="I have an invitation code"
          size="lg"
          fullWidth
          onPress={() => router.push('/code')}
        />
        <Text variant="caption" color="textMuted" align="center">
          TrainHive is invitation only. Ask your organizer for a code.
        </Text>
      </SafeAreaView>
    </View>
  );
}
