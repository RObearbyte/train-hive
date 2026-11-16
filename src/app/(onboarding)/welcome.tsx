import { useRouter, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FLOW_ROUTES } from '@/features/onboarding/domain/flowRoutes';
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
          label="Join a community"
          size="lg"
          fullWidth
          accessibilityHint="Use the invitation code from your organizer"
          onPress={() => router.push(FLOW_ROUTES.onboarding.joinCode as Href)}
        />
        <Text variant="caption" color="textMuted" align="center">
          Ask your organizer for an invitation code.
        </Text>
        <Button
          label="Create a community"
          variant="secondary"
          size="sm"
          fullWidth
          accessibilityHint="For people with a creator code"
          onPress={() => router.push(FLOW_ROUTES.onboarding.createCode as Href)}
        />
        <Text variant="caption" color="textMuted" align="center">
          I have a creator code. Creator codes are issued by the TrainHive team.
        </Text>
      </SafeAreaView>
    </View>
  );
}
