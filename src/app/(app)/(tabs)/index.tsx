import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { CommunityTitle } from '@/features/communities/components/CommunitySwitcher';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { useRemovalNotice } from '@/features/community/hooks/useRemovalNotice';
import { NeedsAttendanceCue } from '@/features/attendance/components/AttendanceEntryPoint';
import { needsAttendance } from '@/features/attendance/domain/sheet';
import { PushPromptCard } from '@/features/notifications/components/PushPromptCard';
import { RecentAnnouncements } from '@/features/notifications/components/RecentAnnouncements';
import { TrainingCard } from '@/features/trainings/components/TrainingCard';
import { kindLabel } from '@/features/trainings/domain/events';
import { statusBadgeLabel } from '@/features/trainings/domain/presentation';
import { deriveDisplayStatus, participationSummary } from '@/features/trainings/domain/status';
import { useCommunityTrainings } from '@/features/trainings/hooks/useTrainings';
import { formatSessionWhen, isValidTimeZone } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { useNow } from '@/lib/useNow';
import {
  Banner,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  ListItem,
  LoadingState,
  Screen,
  StatusBadge,
  Text,
  useTheme,
} from '@/ui';

const THEN_COUNT = 3;
const ATTENDANCE_COUNT = 3;

export default function HomeScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const now = useNow();
  const { profile, isOrganizer } = useCurrentMembership();
  const trainings = useCommunityTrainings(now);
  const removal = useRemovalNotice();

  const next = trainings.next;
  const then = trainings.upcoming.filter((session) => session.id !== next?.id).slice(0, THEN_COUNT);
  const hasUpcoming = next !== null || then.length > 0;
  // Organizers: confirmed trainings that are over and still need their attendance recorded.
  const toRecord = isOrganizer
    ? trainings.past.filter((session) => needsAttendance(session, now))
    : [];

  const attendanceSection =
    toRecord.length > 0 ? (
      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Needs attendance</Text>
        <Card>
          {toRecord.slice(0, ATTENDANCE_COUNT).map((session, index) => {
            const zone = isValidTimeZone(session.timezone) ? session.timezone : 'UTC';
            return (
              <View key={session.id}>
                {index > 0 ? <Divider /> : null}
                <ListItem
                  title={formatSessionWhen(session.starts_at, zone, now)}
                  subtitle={`${kindLabel(session.event_kind)} · ${session.title} · ${session.location_name}`}
                  trailing={<NeedsAttendanceCue />}
                  onPress={() => router.push(`/trainings/${session.id}/attendance`)}
                />
              </View>
            );
          })}
        </Card>
        {toRecord.length > ATTENDANCE_COUNT ? (
          <Text variant="caption" color="textMuted">
            {toRecord.length - ATTENDANCE_COUNT} more in the Past list.
          </Text>
        ) : null}
      </View>
    ) : null;

  // Ask for push permission only after the member has answered at least one RSVP.
  const hasAnswered = [...trainings.upcoming, ...trainings.past].some(
    (session) => trainings.myResponse(session.id) !== 'no_response',
  );

  let body;
  if (trainings.error && !hasUpcoming) {
    body = (
      <ErrorState
        message={userMessage(trainings.error.code, trainings.error.field)}
        onRetry={trainings.refetch}
        style={{ flex: 1 }}
      />
    );
  } else if (trainings.isLoading) {
    body = <LoadingState message="Loading events" style={{ flex: 1 }} />;
  } else if (!hasUpcoming) {
    body = (
      <EmptyState
        title="No events yet"
        message={
          isOrganizer
            ? 'Events you plan will show up here for the whole community.'
            : 'When your organizer plans an event, it will show up here.'
        }
        action={
          isOrganizer
            ? { label: 'Create an event', onPress: () => router.push('/trainings/new') }
            : undefined
        }
        style={{ flex: 1 }}
      />
    );
  } else {
    body = (
      <>
        {trainings.error ? (
          <Banner
            tone="warning"
            message={userMessage(trainings.error.code, trainings.error.field)}
            action={{ label: 'Try again', onPress: trainings.refetch }}
          />
        ) : null}

        {next ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="heading">Next event</Text>
            <TrainingCard
              featured
              session={next}
              myResponse={trainings.myResponse(next.id)}
              now={now}
              onPress={() => router.push(`/trainings/${next.id}`)}
            />
          </View>
        ) : null}

        {then.length > 0 ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="heading">{next ? 'Then' : 'Upcoming'}</Text>
            <Card>
              {then.map((session, index) => {
                const zone = isValidTimeZone(session.timezone) ? session.timezone : 'UTC';
                const status = deriveDisplayStatus(session, now);
                return (
                  <View key={session.id}>
                    {index > 0 ? <Divider /> : null}
                    <ListItem
                      title={formatSessionWhen(session.starts_at, zone, now)}
                      subtitle={`${kindLabel(session.event_kind)} · ${session.title} · ${session.location_name}`}
                      trailing={
                        <StatusBadge
                          size="sm"
                          status={status}
                          label={statusBadgeLabel(status, participationSummary(session))}
                        />
                      }
                      onPress={() => router.push(`/trainings/${session.id}`)}
                    />
                  </View>
                );
              })}
            </Card>
          </View>
        ) : null}
      </>
    );
  }

  return (
    <Screen
      scroll
      edges={['top', 'left', 'right']}
      onRefresh={trainings.refetch}
      refreshing={trainings.isRefetching}
    >
      <View style={{ gap: spacing.xs }}>
        <CommunityTitle />
        {profile ? <Text color="textMuted">Hi, {profile.display_name}</Text> : null}
      </View>
      {removal.message ? (
        <Banner
          tone="info"
          message={removal.message}
          action={{ label: 'Dismiss', onPress: removal.dismiss }}
        />
      ) : null}
      {attendanceSection}
      {body}
      <RecentAnnouncements />
      {hasAnswered ? <PushPromptCard /> : null}
    </Screen>
  );
}
