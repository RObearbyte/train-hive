import { useQueryClient } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';

import { EmergencyListSection } from '@/features/aboutYou/components/EmergencyListSection';
import { membershipKeys } from '@/features/community/api/keys';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { QuickInvite } from '@/features/invitations/components/QuickInvite';
import { FAB_CLEARANCE } from '@/features/invitations/domain/quickInvite';
import { FEATURES } from '@/features/legal/constants';
import { LeaveCommunitySection } from '@/features/members/components/LeaveCommunitySection';
import { MemberDirectory } from '@/features/members/components/MemberDirectory';
import { splitRoster } from '@/features/members/domain/memberActions';
import { useRoster } from '@/features/members/hooks/useMembers';
import { FLOW_ROUTES } from '@/features/onboarding/domain/flowRoutes';
import { ScreenHeader } from '@/features/shell/components/ScreenHeader';
import { isValidTimeZone, zoneCityName } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Card, Divider, ErrorState, Icon, ListItem, LoadingState, Screen, Text, useTheme } from '@/ui';

import { communityTabSections, managementLinks, memberCountText } from '../domain/communityTab';
import { RoleBadge, YourCommunities } from './YourCommunities';

/**
 * The Community tab. Everyone: the current community (name, time zone, my
 * role, member count), my communities with join / create, the member list and
 * leaving. Organizers also get the management shortcuts and the emergency
 * list. The server checks every organizer action again.
 */
export function CommunityTabScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { spacing } = useTheme();
  const current = useCurrentMembership();
  const { community, membership, isOrganizer } = current;
  const roster = useRoster(community?.id ?? null);
  const sections = communityTabSections(isOrganizer);
  const links = managementLinks(isOrganizer);

  const refresh = () => {
    Promise.all([current.refetch(), queryClient.invalidateQueries({ queryKey: membershipKeys.all })]).catch(
      (error: unknown) => reportError('communityTab.refresh', error),
    );
  };

  if (!community || !membership) {
    return (
      <Screen edges={['top', 'left', 'right']}>
        <ScreenHeader title="Community" />
        {current.error ? (
          <ErrorState
            message={userMessage(current.error.code, current.error.field)}
            onRetry={refresh}
            style={{ flex: 1 }}
          />
        ) : (
          <LoadingState message="Loading your community" style={{ flex: 1 }} />
        )}
      </Screen>
    );
  }

  const zone = isValidTimeZone(community.timezone) ? community.timezone : 'UTC';
  const role = membership.role === 'organizer' ? 'Organizer' : 'Member';
  const activeCount = roster.data ? splitRoster(roster.data).active.length : null;
  const countText = activeCount !== null ? memberCountText(activeCount) : roster.isError ? 'Member count not available' : 'Loading members';

  return (
    <View style={{ flex: 1 }}>
      <Screen
        scroll
        edges={['top', 'left', 'right']}
        onRefresh={refresh}
        refreshing={current.isRefetching || roster.isRefetching}
        contentContainerStyle={isOrganizer ? { paddingBottom: FAB_CLEARANCE } : undefined}
      >
        <ScreenHeader title="Community" />

        {/* Showing cached data while the latest refresh failed. */}
        {current.error ? (
          <Banner
            tone="warning"
            message={userMessage(current.error.code, current.error.field)}
            action={{ label: 'Try again', onPress: refresh }}
          />
        ) : null}

        <Card style={{ gap: spacing.sm }} testID="community-summary">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Text variant="title" accessibilityRole="header" style={{ flex: 1 }}>
              {community.name}
            </Text>
            <RoleBadge role={role} />
          </View>
          <Text color="textMuted">{`${countText} · ${zoneCityName(community.timezone)} (${community.timezone}). Event times are shown in this zone.`}</Text>
        </Card>

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

        {sections.management ? (
          <View style={{ gap: spacing.sm }} testID="community-management">
            <Text variant="heading">Manage the community</Text>
            <Card>
              {links.map((link, index) => (
                <View key={link.key}>
                  {index > 0 ? <Divider /> : null}
                  <ListItem
                    title={link.title}
                    subtitle={link.subtitle}
                    leading={<Icon name={LINK_ICONS[link.key]} size={22} color="primary" />}
                    onPress={() => (link.key === 'statistics' ? router.navigate(link.href as Href) : router.push(link.href as Href))}
                    testID={`community-link-${link.key}`}
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        <View style={{ gap: spacing.sm }}>
          <Text variant="heading">Members</Text>
          <Text color="textMuted">
            {isOrganizer
              ? 'Tap a person to see what they shared with you, change their role or remove them.'
              : 'Everyone in this community. Organizers are marked.'}
          </Text>
          {/* Keyed by community so a switch never shows one community's people under another's name. */}
          <MemberDirectory
            key={community.id}
            communityId={community.id}
            communityName={community.name}
            zone={zone}
            isOrganizer={isOrganizer}
            emptyMessage={isOrganizer ? 'Use Invite members above to share a code.' : undefined}
          />
        </View>

        {isOrganizer && FEATURES.emergencyContact ? (
          <EmergencyListSection communityId={community.id} communityName={community.name} />
        ) : null}

        <Card>
          <LeaveCommunitySection communityId={community.id} communityName={community.name} />
        </Card>
      </Screen>
      <QuickInvite />
    </View>
  );
}

const LINK_ICONS = {
  invite: 'plus',
  settings: 'edit',
  'new-announcement': 'megaphone',
  announcements: 'bell',
  members: 'person',
  statistics: 'chart',
} as const;
