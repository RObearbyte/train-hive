import { Redirect, useRouter, type Href } from 'expo-router';
import { View } from 'react-native';

import { EmergencyListSection } from '@/features/aboutYou/components/EmergencyListSection';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { FEATURES } from '@/features/legal/constants';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Button, ErrorState, LoadingState, Screen, Text } from '@/ui';

import { useRoster } from '../hooks/useMembers';
import { MemberDirectory } from './MemberDirectory';

function goBack(router: ReturnType<typeof useRouter>) {
  if (router.canGoBack()) router.back();
  else router.replace('/community' as Href);
}

/** Community -> Manage members: organizers see everyone, including former members, and can change roles or remove people. The server checks every action again. */
export function MembersScreen() {
  const router = useRouter();
  const current = useCurrentMembership();
  const { community, isOrganizer } = current;
  // Same query as the directory's, so refreshing here refreshes the list.
  const roster = useRoster(community?.id ?? null, isOrganizer);

  // Organizers only; members see the list on the Community tab and the server refuses them here anyway.
  if (community && !isOrganizer) return <Redirect href={'/community' as Href} />;

  const header = (
    <>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={() => goBack(router)} />
      </View>
      <Text variant="title" accessibilityRole="header">
        Members
      </Text>
    </>
  );

  if (!community) {
    return (
      <Screen>
        {header}
        {current.error ? (
          <ErrorState
            message={userMessage(current.error.code, current.error.field)}
            onRetry={() => {
              current.refetch().catch((error: unknown) => reportError('members.retryCommunity', error));
            }}
            style={{ flex: 1 }}
          />
        ) : (
          <LoadingState message="Loading your community" style={{ flex: 1 }} />
        )}
      </Screen>
    );
  }

  return (
    <Screen
      scroll
      onRefresh={() => {
        roster.refetch().catch((error: unknown) => reportError('members.refresh', error));
      }}
      refreshing={roster.isRefetching}
    >
      {header}
      <Text color="textMuted">{`Everyone in ${community.name}. Tap a person to see what they shared with organizers, change their role or remove them.`}</Text>
      {/* Keyed by community so a switch never shows one community's people under another's name. */}
      <MemberDirectory
        key={community.id}
        communityId={community.id}
        communityName={community.name}
        zone={community.timezone}
        isOrganizer
        showFormer
        emptyMessage="Invite people with a code from the Community tab, Invite members."
      />
      {FEATURES.emergencyContact && roster.data && roster.data.some((entry) => entry.status === 'active') ? (
        <EmergencyListSection communityId={community.id} communityName={community.name} />
      ) : null}
    </Screen>
  );
}
