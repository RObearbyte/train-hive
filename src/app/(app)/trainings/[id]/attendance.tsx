import { Redirect, useLocalSearchParams } from 'expo-router';

import { AttendanceScreen } from '@/features/attendance/components/AttendanceScreen';
import { isOrganizerOf } from '@/features/community/domain/sessionAccess';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { useTraining } from '@/features/trainings/hooks/useTrainings';
import { LoadingState, Screen } from '@/ui';

/**
 * Organizer-only attendance for one training. Members are sent back to the details screen. The role is the
 * one in the training's own community, not in the active one.
 */
export default function AttendanceRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isOrganizer: isOrganizerHere, communities, isLoading } = useCurrentMembership();
  const training = useTraining(id);
  const session = training.data;

  if (isLoading || (!session && training.isPending)) {
    return (
      <Screen>
        <LoadingState message="Loading" style={{ flex: 1 }} />
      </Screen>
    );
  }
  const isOrganizer = session ? isOrganizerOf(communities, session.community_id) : isOrganizerHere;
  if (!isOrganizer) return <Redirect href={`/trainings/${id}`} />;
  return <AttendanceScreen sessionId={id} />;
}
