import { useState } from 'react';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { DisplayNameForm } from '@/features/profile/components/DisplayNameForm';
import { formatLongDate, isValidTimeZone } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import {
  Avatar,
  Banner,
  Button,
  Card,
  Divider,
  ErrorState,
  ListItem,
  LoadingState,
  Screen,
  Text,
  useTheme,
} from '@/ui';

export default function ProfileScreen() {
  const { spacing } = useTheme();
  const current = useCurrentMembership();
  const { community, membership, profile } = current;
  const [editing, setEditing] = useState(false);

  const refresh = () => {
    current.refetch().catch((error: unknown) => reportError('profile.refresh', error));
  };

  if (!community || !membership) {
    return (
      <Screen edges={['top', 'left', 'right']}>
        <Text variant="title">Profile</Text>
        {current.error ? (
          <ErrorState
            message={userMessage(current.error.code, current.error.field)}
            onRetry={refresh}
            style={{ flex: 1 }}
          />
        ) : (
          <LoadingState message="Loading your profile" style={{ flex: 1 }} />
        )}
      </Screen>
    );
  }

  const name = profile?.display_name ?? '';
  const zone = isValidTimeZone(community.timezone) ? community.timezone : 'UTC';

  return (
    <Screen
      scroll
      edges={['top', 'left', 'right']}
      onRefresh={refresh}
      refreshing={current.isRefetching}
    >
      <Text variant="title">Profile</Text>

      {/* Showing cached data while the latest refresh failed. */}
      {current.error ? (
        <Banner
          tone="warning"
          message={userMessage(current.error.code, current.error.field)}
          action={{ label: 'Try again', onPress: refresh }}
        />
      ) : null}

      <Card>
        {editing ? (
          <DisplayNameForm currentName={name} onDone={() => setEditing(false)} />
        ) : (
          <View style={{ gap: spacing.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Avatar name={name} size={56} />
              <View style={{ flex: 1, gap: spacing.xxs }}>
                <Text variant="caption" color="textMuted">
                  Your name
                </Text>
                <Text variant="heading">{name === '' ? 'No name set' : name}</Text>
              </View>
            </View>
            <Button
              label="Change name"
              variant="secondary"
              size="sm"
              onPress={() => setEditing(true)}
            />
          </View>
        )}
      </Card>

      <Card>
        <ListItem title="Community" subtitle={community.name} />
        <Divider />
        <ListItem
          title="Role"
          subtitle={membership.role === 'organizer' ? 'Organizer' : 'Member'}
        />
        <Divider />
        <ListItem title="Member since" subtitle={formatLongDate(membership.joined_at, zone)} />
      </Card>

      <Text variant="caption" color="textMuted" align="center">
        Your account lives on this device. Deleting the app or its data removes it.
      </Text>
    </Screen>
  );
}
