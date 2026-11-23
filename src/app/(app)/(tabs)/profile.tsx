import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { aboutYouAvailable } from '@/features/aboutYou/domain/prompt';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { FEATURES } from '@/features/legal/constants';
import { myWorkoutsHref } from '@/features/notifications/components/routes';
import { NotificationSettings } from '@/features/notifications/components/NotificationSettings';
import { LegalLinks } from '@/features/legal/components/LegalLinks';
import { DisplayNameForm } from '@/features/profile/components/DisplayNameForm';
import { SignOutSection } from '@/features/profile/components/SignOutSection';
import { ScreenHeader } from '@/features/shell/components/ScreenHeader';
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
  const { community, membership, profile } = current;
  const [editing, setEditing] = useState(false);
  const appVersion = Constants.expoConfig?.version;

  const refresh = () => {
    current.refetch().catch((error: unknown) => reportError('profile.refresh', error));
  };

  if (!community || !membership) {
    return (
      <Screen edges={['top', 'left', 'right']}>
        <ScreenHeader title="Profile" />
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
      <ScreenHeader title="Profile" />

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

      {aboutYouAvailable() ? (
        <Card>
          <ListItem
            title="About you"
            subtitle="Birth year, gender, emergency contact and T-shirt size. All optional."
            leading={<Icon name="person" size={22} color="primary" />}
            onPress={() => router.push('/about-you' as Href)}
            testID="profile-about-you"
          />
        </Card>
      ) : null}

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Membership</Text>
        <Card>
          <ListItem title="Member since" subtitle={formatLongDate(membership.joined_at, zone)} />
          <Divider />
          <ListItem
            title="My attendance"
            subtitle="Events you attended, by month"
            leading={<Icon name="check-circle" size={22} color="primary" />}
            onPress={() => router.push('/attendance-history')}
          />
          {FEATURES.workoutLogs ? (
            <>
              <Divider />
              <ListItem
                title="My workouts"
                subtitle="Workouts you logged. Private to you."
                leading={<Icon name="edit" size={22} color="primary" />}
                onPress={() => router.push(myWorkoutsHref)}
                testID="profile-my-workouts"
              />
            </>
          ) : null}

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
