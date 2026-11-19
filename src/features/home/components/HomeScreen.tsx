import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';

import { NeedsAttendanceCue } from '@/features/attendance/components/AttendanceEntryPoint';
import { needsAttendance } from '@/features/attendance/domain/sheet';
import { CommunityTitle } from '@/features/communities/components/CommunitySwitcher';
import { useSession } from '@/features/community/hooks/SessionProvider';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { useRemovalNotice } from '@/features/community/hooks/useRemovalNotice';
import { QuickInvite } from '@/features/invitations/components/QuickInvite';
import { FAB_CLEARANCE } from '@/features/invitations/domain/quickInvite';
import { AnnouncementRow } from '@/features/notifications/components/AnnouncementRow';
import { PushPromptCard } from '@/features/notifications/components/PushPromptCard';
import { announcementHref, announcementsListHref } from '@/features/notifications/components/routes';
import { unreadAnnouncements } from '@/features/notifications/domain/unread';
import { useActivity } from '@/features/notifications/hooks/useActivity';
import { ScreenHeader } from '@/features/shell/components/ScreenHeader';
import { TrainingCard } from '@/features/trainings/components/TrainingCard';
import { kindLabel } from '@/features/trainings/domain/events';
import { useCommunityTrainings } from '@/features/trainings/hooks/useTrainings';
import { formatSessionWhen, isValidTimeZone } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { useNow } from '@/lib/useNow';
import {
  Banner,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  ListItem,
  LoadingState,
  Screen,
  Text,
  useTheme,
} from '@/ui';

import { buildHomeFeed } from '../domain/homeFeed';

const ATTENDANCE_COUNT = 3;

/** Home: community header with the bell, then one vertical feed of events and announcements. */
export function HomeScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const now = useNow();
  const { userId } = useSession();
  const { community, profile, isOrganizer } = useCurrentMembership();
  const trainings = useCommunityTrainings(now);
  const activity = useActivity();
  const removal = useRemovalNotice();

  const feed = buildHomeFeed(
    [...trainings.upcoming, ...trainings.past],
    activity.announcements,
    now,
  );
  const next = feed.nextUp;
  const hasEvents = next !== null || feed.comingUp.length > 0;
  // Organizers: confirmed events that are over and still need their attendance recorded.
  const toRecord = isOrganizer
    ? trainings.past.filter((session) => needsAttendance(session, now))
    : [];
  const zone = community && isValidTimeZone(community.timezone) ? community.timezone : 'UTC';
  const unreadIds = new Set(
    unreadAnnouncements(activity.announcements, activity.readIds, userId).map((item) => item.id),
  );

  // Ask for push permission only after the member has answered at least one RSVP.
  const hasAnswered = [...trainings.upcoming, ...trainings.past].some(
    (session) => trainings.myResponse(session.id) !== 'no_response',
  );

  const refresh = () => {
    trainings.refetch();
    activity.refetch();
  };

  const attendanceSection =
    toRecord.length > 0 ? (
      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Needs attendance</Text>
        <Card>
          {toRecord.slice(0, ATTENDANCE_COUNT).map((session, index) => {
            const sessionZone = isValidTimeZone(session.timezone) ? session.timezone : 'UTC';
            return (
              <View key={session.id}>
                {index > 0 ? <Divider /> : null}
                <ListItem
                  title={formatSessionWhen(session.starts_at, sessionZone, now)}
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

  const announcementsSection =
    feed.latestAnnouncements.length > 0 ? (
      <View style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="heading">Latest announcements</Text>
          <Button
            label="See all announcements"
            variant="ghost"
            size="sm"
            onPress={() => router.push(announcementsListHref)}
          />
        </View>
        <Card>
          {feed.latestAnnouncements.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? <Divider /> : null}
              <AnnouncementRow
                announcement={item}
                unread={unreadIds.has(item.id)}
                zone={zone}
                now={now}
                onPress={() => router.push(announcementHref(item.id))}
              />
            </View>
          ))}
        </Card>
      </View>
    ) : activity.announcementsError ? (
      <Banner
        tone="warning"
        message={`Announcements could not be loaded. ${userMessage(activity.announcementsError.code, activity.announcementsError.field)}`}
        action={{ label: 'Try again', onPress: activity.refetch }}
      />
    ) : null;

  let events;
  if (trainings.error && !hasEvents) {
    events = (
      <ErrorState
        message={userMessage(trainings.error.code, trainings.error.field)}
        onRetry={trainings.refetch}
      />
    );
  } else if (trainings.isLoading) {
    events = <LoadingState message="Loading events" />;
  } else if (!hasEvents) {
    events = (
      <EmptyState
        title="No upcoming events yet"
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
      />
    );
  } else {
    events = (
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
            <Text variant="heading">Next up</Text>
            <TrainingCard
              featured
              session={next}
              myResponse={trainings.myResponse(next.id)}
              now={now}
              onPress={() => router.push(`/trainings/${next.id}`)}
            />
          </View>
        ) : null}

        {feed.comingUp.length > 0 ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="heading">Coming up</Text>
            {feed.comingUp.map((session) => (
              <TrainingCard
                key={session.id}
                compact
                session={session}
                myResponse={trainings.myResponse(session.id)}
                now={now}
                onPress={() => router.push(`/trainings/${session.id}`)}
              />
            ))}
          </View>
        ) : null}

        <View style={{ alignItems: 'flex-start' }}>
          <Button
            label="See all events"
            variant="ghost"
            size="sm"
            icon="chevron-right"
            onPress={() => router.navigate('/trainings' as Href)}
          />
        </View>
      </>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Screen
        scroll
        edges={['top', 'left', 'right']}
        onRefresh={refresh}
        refreshing={trainings.isRefetching || activity.isRefetching}
        contentContainerStyle={isOrganizer ? { paddingBottom: FAB_CLEARANCE } : undefined}
      >
        <ScreenHeader
          left={
            <View>
              <CommunityTitle />
              {profile ? <Text color="textMuted">Hi, {profile.display_name}</Text> : null}
            </View>
          }
        />
        {removal.message ? (
          <Banner
            tone="info"
            message={removal.message}
            action={{ label: 'Dismiss', onPress: removal.dismiss }}
          />
        ) : null}
        {hasAnswered ? <PushPromptCard /> : null}
        {attendanceSection}
        {events}
        {announcementsSection}
      </Screen>
      <QuickInvite />
    </View>
  );
}
