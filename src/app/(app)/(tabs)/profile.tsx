import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { YourCommunities } from '@/features/communities/components/YourCommunities';
import { FLOW_ROUTES } from '@/features/onboarding/domain/flowRoutes';
import { NotificationSettings } from '@/features/notifications/components/NotificationSettings';
import { LeaveCommunitySection } from '@/features/members/components/LeaveCommunitySection';
import { LegalLinks } from '@/features/legal/components/LegalLinks';
import { DisplayNameForm } from '@/features/profile/components/DisplayNameForm';
import { SignOutSection } from '@/features/profile/components/SignOutSection';
import { formatLongDate, isValidTimeZone, zoneCityName } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import {
  Avatar,
  Banner,
  Button,
  Card,
  Divider,
  ErrorState,
  Icon,
  ListItem,
  LoadingState,
  Screen,
  Text,
  useTheme,
} from '@/ui';

export default function ProfileScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const current = useCurrentMembership();
  const { community, membership, profile, isOrganizer } = current;
  const [editing, setEditing] = useState(false);
  const appVersion = Constants.expoConfig?.version;

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

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Community</Text>
        <Card>
          <ListItem title="Name" subtitle={community.name} />
          <Divider />
          <ListItem
            title="Time zone"
            subtitle={`${zoneCityName(community.timezone)} (${community.timezone}). Training times are shown in this zone.`}
          />
        </Card>
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Membership</Text>
        <Card>
          <ListItem
            title="Role"
            subtitle={membership.role === 'organizer' ? 'Organizer' : 'Member'}
          />
          <Divider />
          <ListItem title="Member since" subtitle={formatLongDate(membership.joined_at, zone)} />
          <Divider />
          <ListItem
            title="My attendance"
            subtitle="Trainings you attended, by month"
            leading={<Icon name="check-circle" size={22} color="primary" />}
            onPress={() => router.push('/attendance-history')}
          />
          {isOrganizer ? (
            <>
              <Divider />
              <ListItem
                title="Invitations"
                subtitle="Create and manage invitation codes"
                leading={<Icon name="people" size={22} color="primary" />}
                onPress={() => router.push('/invitations')}
              />
              <Divider />
              <ListItem
                title="Members"
                subtitle="See everyone, change roles or remove people"
                leading={<Icon name="person" size={22} color="primary" />}
                onPress={() => router.push('/members' as Href)}
              />
              <Divider />
              <ListItem
                title="Community settings"
                subtitle="Change the name and time zone"
                leading={<Icon name="edit" size={22} color="primary" />}
                onPress={() => router.push('/community-settings' as Href)}
              />
            </>
          ) : null}
          <Divider />
          <LeaveCommunitySection communityId={community.id} communityName={community.name} />
        </Card>
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Your communities</Text>
        <Card>
          <YourCommunities />
          <ListItem
            title="Join another community"
            subtitle="With an invitation code. Your name is shared across communities."
            leading={<Icon name="plus" size={22} color="primary" />}
            onPress={() => router.push(FLOW_ROUTES.signedIn.joinCode as Href)}
          />
          <Divider />
          <ListItem
            title="Create a community"
            subtitle="Needs a creator code"
            leading={<Icon name="people" size={22} color="primary" />}
            onPress={() => router.push(FLOW_ROUTES.signedIn.createCode as Href)}
          />
        </Card>
      </View>

      <NotificationSettings />

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Privacy</Text>
        <Card>
          <ListItem
            title="Privacy settings"
            subtitle="Choose what TrainHive may do with optional information"
            leading={<Icon name="info" size={22} color="primary" />}
            onPress={() => router.push('/privacy' as Href)}
          />
        </Card>
        <LegalLinks />
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Your account</Text>
        <Card style={{ gap: spacing.sm }}>
          <Text>
            Your account lives on this device only. There is no password or email to sign in
            with somewhere else.
          </Text>
          <Text color="textMuted">
            If you uninstall TrainHive or clear its data, the account is lost. To come back you
            would need a new invitation code from your organizer, and you would join as a new
            member.
          </Text>
        </Card>
        <SignOutSection />
      </View>

      <Text variant="caption" color="textMuted" align="center">
        TrainHive {appVersion ? `version ${appVersion}` : 'version not available'}
      </Text>
    </Screen>
  );
}
