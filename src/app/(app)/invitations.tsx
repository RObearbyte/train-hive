import { useQueryClient } from '@tanstack/react-query';
import { Redirect, useRouter } from 'expo-router';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { InvitationsManager } from '@/features/invitations/components/InvitationsManager';
import { invitationKeys } from '@/features/invitations/hooks/useInvitations';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Button, ErrorState, LoadingState, Screen, Text } from '@/ui';

export default function InvitationsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const current = useCurrentMembership();
  const { community, isOrganizer } = current;

  // Organizers only. The server enforces it too: RLS shows a member no codes.
  if (community && !isOrganizer) return <Redirect href="/profile" />;

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/profile');
  };
  const refresh = () => {
    Promise.all([
      current.refetch(),
      queryClient.invalidateQueries({ queryKey: invitationKeys.all }),
    ]).catch((error: unknown) => reportError('invitations.refresh', error));
  };

  let body;
  if (community) {
    body = <InvitationsManager community={community} />;
  } else if (current.error) {
    body = (
      <ErrorState
        message={userMessage(current.error.code, current.error.field)}
        onRetry={refresh}
        style={{ flex: 1 }}
      />
    );
  } else {
    body = <LoadingState message="Loading your community" style={{ flex: 1 }} />;
  }

  return (
    <Screen scroll onRefresh={refresh} refreshing={current.isRefetching}>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={goBack} />
      </View>
      <Text variant="title">Invitations</Text>
      {body}
    </Screen>
  );
}
