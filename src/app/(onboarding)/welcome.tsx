import { useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { peekAccountDeletedNotice, setAccountDeletedNotice } from '@/features/dataRights/domain/deletedNotice';
import { WelcomeLegalLinks } from '@/features/legal/components/WelcomeLegalLinks';
import { FLOW_ROUTES } from '@/features/onboarding/domain/flowRoutes';
import { BrandHero } from '@/features/onboarding/components/BrandHero';
import { Banner, Button, Text, useTheme } from '@/ui';

export default function WelcomeScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  // Set once after "Delete my account"; shown here and gone after the next reload.
  const [notice] = useState(peekAccountDeletedNotice);
  useEffect(() => {
    setAccountDeletedNotice(null);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* The hero is navy in both themes. */}
      <StatusBar style="light" />
      <BrandHero />
      <SafeAreaView
        edges={['bottom', 'left', 'right']}
        style={{ padding: spacing.xl, gap: spacing.lg }}
      >
        {notice ? <Banner tone="success" message={notice} /> : null}
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
        <WelcomeLegalLinks />
      </SafeAreaView>
    </View>
  );
}
