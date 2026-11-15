import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { EditTrainingForm } from '@/features/trainings/components/TrainingForm';
import { isEditable } from '@/features/trainings/domain/schema';
import { useTraining } from '@/features/trainings/hooks/useTrainings';
import { isValidTimeZone } from '@/lib/datetime';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Button, EmptyState, ErrorState, LoadingState, Screen } from '@/ui';

export default function EditTrainingScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isOrganizer, isLoading: membershipLoading } = useCurrentMembership();
  const training = useTraining(id);
  const session = training.data;

  // Back to the details screen when it is underneath, otherwise (opened by a
  // link) it replaces this screen. Plain back() could land on a tab instead.
  const toDetails = () => router.dismissTo(`/trainings/${id}`);

  if (!membershipLoading && !isOrganizer) return <Redirect href={`/trainings/${id}`} />;

  if (session && isOrganizer && isEditable(session.status) && isValidTimeZone(session.timezone)) {
    return <EditTrainingForm session={session} onSaved={toDetails} onClose={toDetails} />;
  }

  let body;
  if (session && !isEditable(session.status)) {
    body = (
      <EmptyState
        title="This training can no longer be edited"
        message={
          session.status === 'cancelled'
            ? 'It has been cancelled.'
            : 'It has already taken place.'
        }
        action={{ label: 'Back to the training', onPress: toDetails }}
        style={{ flex: 1 }}
      />
    );
  } else if (session && !isValidTimeZone(session.timezone)) {
    body = (
      <ErrorState
        title="Time zone not supported"
        message={`This device does not know the training's time zone (${session.timezone}), so its times cannot be edited safely.`}
        style={{ flex: 1 }}
      />
    );
  } else if (training.isPending || membershipLoading) {
    body = <LoadingState message="Loading training" style={{ flex: 1 }} />;
  } else if (training.isError) {
    body = (
      <ErrorState
        message={userMessage(toAppError(training.error).code)}
        onRetry={() => {
          training.refetch().catch((error: unknown) => reportError('training.edit', error));
        }}
        style={{ flex: 1 }}
      />
    );
  } else {
    body = (
      <EmptyState
        title="Training not found"
        message="It may have been removed, or you no longer have access to it."
        action={{ label: 'See all trainings', onPress: () => router.replace('/trainings') }}
        style={{ flex: 1 }}
      />
    );
  }

  return (
    <Screen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={toDetails} />
      </View>
      {body}
    </Screen>
  );
}
