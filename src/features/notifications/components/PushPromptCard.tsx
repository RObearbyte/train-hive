import { View } from 'react-native';

import { Banner, Button, Card, Icon, Text, useTheme } from '@/ui';

import { usePush } from '../hooks/PushProvider';

/**
 * In-context ask for push permission. Shown only while the system permission
 * is undecided and the member has not chosen "Not now"; the settings screen
 * keeps offering it afterwards. Never shown at first launch: it lives on Home
 * (after the first RSVP) and in the notification centre.
 */
export function PushPromptCard() {
  const { spacing } = useTheme();
  const push = usePush();
  if (!push.showPrompt) return null;

  return (
    <Card style={{ gap: spacing.md }}>
      <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}>
        <Icon name="bell" size={26} color="primary" />
        <View style={{ flex: 1, gap: spacing.xxs }}>
          <Text variant="heading">Stay in the loop</Text>
          <Text color="textMuted">
            Get notified when events are confirmed or cancelled. Tapping Enable records your consent to
            push notifications; you can withdraw it any time in Profile, Privacy.
          </Text>
        </View>
      </View>
      {push.enableError ? <Banner tone="error" message={push.enableError} /> : null}
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button
          label="Enable"
          size="sm"
          onPress={() => {
            void push.enable();
          }}
        />
        <Button label="Not now" variant="ghost" size="sm" onPress={push.dismissPrompt} />
      </View>
    </Card>
  );
}
