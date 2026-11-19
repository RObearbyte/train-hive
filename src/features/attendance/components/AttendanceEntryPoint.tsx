import { useRouter } from 'expo-router';
import { View } from 'react-native';

import type { RsvpResponse, TrainingSession } from '@/lib/database.types';
import { useSession } from '@/features/community/hooks/SessionProvider';
import { Banner, Button, Card, Icon, Text, useTheme } from '@/ui';

import { myOutcomeText } from '../domain/history';
import { needsAttendance } from '../domain/sheet';
import { useMyRecord } from '../hooks/useAttendanceSheet';

/**
 * Organizer entry to the attendance screen on the training details.
 * Shown for confirmed and completed trainings only. `now` only decides which
 * call to action to show; the server decides whether recording is allowed.
 */
export function AttendanceEntryPoint({
  session,
  now,
}: {
  session: Pick<TrainingSession, 'id' | 'status' | 'starts_at' | 'ends_at'>;
  now: Date;
}) {
  const router = useRouter();
  const { spacing } = useTheme();
  const open = () => router.push(`/trainings/${session.id}/attendance`);

  if (session.status === 'completed') {
    return (
      <Button
        label="View / correct attendance"
        variant="secondary"
        icon="people"
        onPress={open}
        fullWidth
      />
    );
  }
  if (session.status !== 'confirmed') return null;

  if (needsAttendance(session, now)) {
    return (
      <View style={{ gap: spacing.sm }}>
        <Banner
          tone="warning"
          title="Needs attendance"
          message="This event is over. Record who came, then finalize."
        />
        <Button label="Record attendance" size="lg" icon="check" onPress={open} fullWidth />
      </View>
    );
  }
  return <Button label="Attendance" variant="secondary" icon="people" onPress={open} fullWidth />;
}

/**
 * "Needs attendance" cue for organizers on lists. Display only: a glyph plus
 * text, never color alone.
 */
export function NeedsAttendanceCue() {
  const { spacing } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="Needs attendance"
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}
    >
      <Icon name="alert" size={16} color="warning" />
      <Text variant="label" color="warning">
        Needs attendance
      </Text>
    </View>
  );
}

/**
 * My own outcome in a completed training, from my own attendance row (RLS
 * shows members only their own). A member who said going and has no row sees
 * "Attendance not recorded"; someone who was never part of it sees nothing.
 */
export function MyAttendanceOutcome({
  session,
  myResponse,
}: {
  session: Pick<TrainingSession, 'id' | 'status'>;
  myResponse: RsvpResponse;
}) {
  const { userId } = useSession();
  const { spacing } = useTheme();
  const completed = session.status === 'completed';
  const mine = useMyRecord(session.id, userId, completed);

  if (!completed || mine.isPending) return null;
  if (mine.isError) {
    return (
      <Text variant="caption" color="textMuted">
        Your attendance could not be loaded. Pull down to refresh.
      </Text>
    );
  }
  if (mine.data === null && myResponse !== 'going') return null;

  const status = mine.data?.status ?? 'unrecorded';
  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
      <Icon
        name={status === 'present' ? 'check-circle' : status === 'absent' ? 'close' : 'circle'}
        size={22}
        color={status === 'present' ? 'success' : status === 'absent' ? 'danger' : 'textMuted'}
      />
      <Text variant="label" style={{ flex: 1 }}>
        {myOutcomeText(status)}
      </Text>
    </Card>
  );
}
