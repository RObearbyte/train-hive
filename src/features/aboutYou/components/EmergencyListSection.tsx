import { useState } from 'react';
import { View } from 'react-native';

import { CopyAttendanceActions } from '@/features/attendance/components/CopyAttendanceActions';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, Card, Divider, EmptyState, ListItem, LoadingState, Text, useTheme } from '@/ui';

import { contactSummary, emergencyListText, infoAccessibilityLabel } from '../domain/emergency';
import { useCommunityEmergencyList } from '../hooks/useOrganizerData';

/**
 * Organizers: everyone in the community who shared an emergency contact or a
 * T-shirt size, with Copy / Share as plain text. Loaded only when opened; the
 * server returns only members who agreed.
 */
export function EmergencyListSection({
  communityId,
  communityName,
}: {
  communityId: string;
  communityName: string;
}) {
  const { spacing } = useTheme();
  const [open, setOpen] = useState(false);
  const query = useCommunityEmergencyList(communityId, open);

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="heading">Emergency contacts and T-shirt sizes</Text>
      <Text color="textMuted">
        What members chose to share with organizers, for safety at events and for race kits. Members who did not
        share anything are not listed.
      </Text>
      <Button
        label={open ? 'Hide the list' : 'Show the list'}
        variant="secondary"
        icon={open ? 'chevron-left' : 'chevron-right'}
        onPress={() => setOpen((value) => !value)}
        accessibilityHint="Shows names, phone numbers and T-shirt sizes members shared with organizers"
        testID="emergency-list-toggle"
      />
      {open ? (
        query.isPending ? (
          <LoadingState message="Loading the list" />
        ) : !query.data ? (
          <Banner
            tone="error"
            message={userMessage(query.error.code, query.error.field)}
            action={{
              label: 'Try again',
              onPress: () => {
                query.refetch().catch((error: unknown) => reportError('aboutYou.listRetry', error));
              },
            }}
          />
        ) : query.data.members.length === 0 ? (
          <EmptyState
            title="Nothing shared yet"
            message="Nobody in this community has shared an emergency contact or T-shirt size."
          />
        ) : (
          <View style={{ gap: spacing.md }}>
            {query.isError ? (
              <Banner tone="warning" message={`${userMessage(query.error.code, query.error.field)} Showing the last list that loaded.`} />
            ) : null}
            <Card style={{ padding: 0 }}>
              {query.data.members.map((member, index) => (
                <View key={member.user_id}>
                  {index > 0 ? <Divider /> : null}
                  <ListItem
                    title={member.display_name}
                    subtitle={[
                      contactSummary(member),
                      member.emergency_contact_phone,
                      member.tshirt_size ? `T-shirt ${member.tshirt_size}` : null,
                    ]
                      .filter((part): part is string => part !== null && part !== '')
                      .join(' · ')}
                    accessibilityLabel={infoAccessibilityLabel(member)}
                    testID={`emergency-row-${member.user_id}`}
                  />
                </View>
              ))}
            </Card>
            {query.data.truncated ? (
              <Banner tone="warning" message="The list was cut at 500 members." />
            ) : null}
            <CopyAttendanceActions text={emergencyListText(query.data, communityName)} />
            <Text variant="caption" color="textMuted">
              This is personal data of members and of their contacts. Use it only to run events, and do not share it
              outside the organizers.
            </Text>
          </View>
        )
      ) : null}
    </View>
  );
}
