import { Redirect, useRouter } from 'expo-router';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { CreateEventFlow } from '@/features/trainings/components/CreateEventFlow';
import { isValidTimeZone } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Button, ErrorState, LoadingState, Screen } from '@/ui';

export default function NewTrainingScreen() {
  const router = useRouter();
  const current = useCurrentMembership();
  const { community, isOrganizer } = current;

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/trainings');
  };

  if (community && !isOrganizer) return <Redirect href="/trainings" />;

  if (community && isValidTimeZone(community.timezone)) {
    return (
      <CreateEventFlow
        communityId={community.id}
        timezone={community.timezone}
        onSaved={(session) => router.replace(`/trainings/${session.id}`)}
        onClose={goBack}
      />
    );
  }

  let body;
  if (community) {
    body = (
      <ErrorState
        title="Time zone not supported"
        message={`This device does not know the community's time zone (${community.timezone}), so times cannot be entered safely.`}
        style={{ flex: 1 }}
      />
    );
  } else if (current.error) {
    body = (
      <ErrorState
        message={userMessage(current.error.code, current.error.field)}
        onRetry={() => {
          current.refetch().catch((error: unknown) => reportError('training.new', error));
        }}
        style={{ flex: 1 }}
      />
    );
  } else {
    body = <LoadingState message="Loading your community" style={{ flex: 1 }} />;
  }

  return (
    <Screen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={goBack} />
      </View>
      {body}
    </Screen>
  );
}
