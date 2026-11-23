import { useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';

import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, Text, useTheme } from '@/ui';

import { contactSummary, hasSharedInfo, infoAccessibilityLabel, telHref } from '../domain/emergency';
import { useMemberEmergencyInfo } from '../hooks/useOrganizerData';

/** What one member chose to share with organizers: emergency contact and T-shirt size. Organizers only (the server checks). */
export function MemberEmergencySection({ communityId, userId }: { communityId: string; userId: string }) {
  const { spacing } = useTheme();
  const query = useMemberEmergencyInfo(communityId, userId);
  const [callProblem, setCallProblem] = useState<string | null>(null);

  let body;
  if (query.isPending) {
    body = (
      <View accessibilityRole="progressbar" accessibilityLabel="Loading shared details">
        <ActivityIndicator />
      </View>
    );
  } else if (!query.data) {
    body = (
      <Banner
        tone="warning"
        message={userMessage(query.error.code, query.error.field)}
        action={{
          label: 'Try again',
          onPress: () => {
            query.refetch().catch((error: unknown) => reportError('aboutYou.memberRetry', error));
          },
        }}
      />
    );
  } else if (!hasSharedInfo(query.data)) {
    body = <Text color="textMuted">Nothing shared. This member has not given an emergency contact or T-shirt size.</Text>;
  } else {
    const info = query.data;
    const contact = contactSummary(info);
    const href = telHref(info.emergency_contact_phone);
    body = (
      <View style={{ gap: spacing.sm }} accessible accessibilityLabel={infoAccessibilityLabel(info)}>
        <View accessible={false}>
          <Text variant="caption" color="textMuted">
            Emergency contact
          </Text>
          <Text>{contact ?? 'None given'}</Text>
          {info.emergency_contact_phone ? <Text selectable>{info.emergency_contact_phone}</Text> : null}
        </View>
        <View accessible={false}>
          <Text variant="caption" color="textMuted">
            T-shirt size
          </Text>
          <Text>{info.tshirt_size ?? 'Not given'}</Text>
        </View>
      </View>
    );
    if (href !== null) {
      body = (
        <View style={{ gap: spacing.sm }}>
          {body}
          <Button
            label="Call emergency contact"
            variant="secondary"
            size="sm"
            accessibilityHint="Opens your phone app with this number. Nothing is dialed until you confirm."
            onPress={() => {
              setCallProblem(null);
              Linking.openURL(href).catch((error: unknown) => {
                reportError('aboutYou.call', error);
                setCallProblem('Could not open the phone app. Copy the number instead.');
              });
            }}
          />
          {callProblem ? <Banner tone="warning" message={callProblem} /> : null}
        </View>
      );
    }
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="label">Emergency contact and T-shirt size</Text>
      {body}
      <Text variant="caption" color="textMuted">
        Only organizers can see this. Use it only for safety at events and for race kits.
      </Text>
    </View>
  );
}
