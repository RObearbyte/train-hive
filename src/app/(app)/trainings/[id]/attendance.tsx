import { Redirect, useLocalSearchParams } from 'expo-router';

import { AttendanceScreen } from '@/features/attendance/components/AttendanceScreen';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { LoadingState, Screen } from '@/ui';

/** Organizer-only attendance for one training. Members are sent back to the details screen. */
export default function AttendanceRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isOrganizer, isLoading } = useCurrentMembership();

  if (isLoading) {
    return (
      <Screen>
        <LoadingState message="Loading" style={{ flex: 1 }} />
      </Screen>
    );
  }
  if (!isOrganizer) return <Redirect href={`/trainings/${id}`} />;
  return <AttendanceScreen sessionId={id} />;
}
