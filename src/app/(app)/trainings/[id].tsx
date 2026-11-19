import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';

import { isOrganizerOf, roleInCommunity } from '@/features/community/domain/sessionAccess';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import {
  AttendanceEntryPoint,
  MyAttendanceOutcome,
} from '@/features/attendance/components/AttendanceEntryPoint';
import { RsvpControl } from '@/features/rsvp/components/RsvpControl';
import { KindChip } from '@/features/trainings/components/KindChip';
import { OrganizerActions } from '@/features/trainings/components/OrganizerActions';
import { courseLine } from '@/features/trainings/domain/events';
import { buildMapsLink, type MapsPlatform } from '@/features/trainings/domain/maps';
import {
  groupParticipants,
  isProvisional,
  participationLines,
  statusBadgeLabel,
  statusExplanation,
} from '@/features/trainings/domain/presentation';
import {
  deriveDisplayStatus,
  participationSummary,
  type TrainingDisplayStatus,
} from '@/features/trainings/domain/status';
import {
  useMyResponse,
  useOrganizerName,
  useParticipants,
  useSubtypeLabel,
  useTraining,
} from '@/features/trainings/hooks/useTrainings';
import type { TrainingSession } from '@/lib/database.types';
import {
  deviceTimeZone,
  formatDateTime,
  formatDateTimeRange,
  isValidTimeZone,
  relativeDayLabel,
  zoneCityName,
  zonesDifferAt,
} from '@/lib/datetime';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { useNow } from '@/lib/useNow';
import {
  Avatar,
  Banner,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  Icon,
  ListItem,
  LoadingState,
  ProgressBar,
  Screen,
  StatusBadge,
  Text,
  useTheme,
  type BannerTone,
  type IconName,
} from '@/ui';

const MAPS_PLATFORM: MapsPlatform =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

function bannerTone(status: TrainingDisplayStatus): BannerTone {
  switch (status) {
    case 'confirmed':
      return 'success';
    case 'cancelled_insufficient':
    case 'cancelled_organizer':
      return 'error';
    case 'finalizing':
      return 'warning';
    default:
      return 'info';
  }
}

function InfoRow({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md }}>
      <View style={{ paddingTop: spacing.xxs }}>
        <Icon name={icon} size={20} color="textMuted" />
      </View>
      <View style={{ flex: 1, gap: spacing.xxs }}>{children}</View>
    </View>
  );
}

function Participants({ sessionId }: { sessionId: string }) {
  const { spacing } = useTheme();
  const participants = useParticipants(sessionId);

  if (participants.isPending) return <LoadingState message="Loading participants" />;
  if (participants.isError && !participants.data) {
    return (
      <ErrorState
        title="Could not load participants"
        message={userMessage(toAppError(participants.error).code)}
        onRetry={() => {
          participants
            .refetch()
            .catch((error: unknown) => reportError('training.participants', error));
        }}
      />
    );
  }

  const { going, notGoing } = groupParticipants(participants.data ?? []);
  const groups = [
    { title: `Going (${going.length})`, people: going, empty: 'Nobody yet.' },
    { title: `Not going (${notGoing.length})`, people: notGoing, empty: 'Nobody has declined.' },
  ];

  return (
    <View style={{ gap: spacing.lg }}>
      {groups.map((group) => (
        <View key={group.title} style={{ gap: spacing.sm }}>
          <Text variant="heading">{group.title}</Text>
          {group.people.length === 0 ? (
            <Text color="textMuted">{group.empty}</Text>
          ) : (
            <Card>
              {group.people.map((person, index) => (
                <View key={person.userId}>
                  {index > 0 ? <Divider /> : null}
                  <ListItem
                    title={person.displayName}
                    leading={<Avatar name={person.displayName} size={36} />}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>
      ))}
    </View>
  );
}

function TrainingDetails({ session, now }: { session: TrainingSession; now: Date }) {
  const router = useRouter();
  const { spacing } = useTheme();
  // Rights follow the training's own community, not the active one.
  const { communities } = useCurrentMembership();
  const isOrganizer = isOrganizerOf(communities, session.community_id);
  const myResponse = useMyResponse(session.id, session.community_id);
  const organizer = useOrganizerName(session.id, session.organizer_id);
  const subtypeText = useSubtypeLabel();
  const [mapsFailed, setMapsFailed] = useState(false);

  const zone = isValidTimeZone(session.timezone) ? session.timezone : 'UTC';
  const status = deriveDisplayStatus(session, now);
  const summary = participationSummary(session);
  const lines = participationLines(summary, status);
  const deadlineText = formatDateTime(session.rsvp_deadline, zone);
  const course = courseLine(session);
  const hasMinimum = summary.min !== null;
  const relativeDay = relativeDayLabel(session.starts_at, zone, now);
  const device = deviceTimeZone();
  const showZoneNote = device !== null && zonesDifferAt(session.starts_at, zone, device);

  const openMaps = async () => {
    const link = buildMapsLink(session, MAPS_PLATFORM);
    setMapsFailed(false);
    try {
      await Linking.openURL(link.url);
    } catch (error) {
      reportError('training.openMaps', error);
      try {
        // No app for the native scheme: the https link opens in the browser.
        await Linking.openURL(link.fallbackUrl);
      } catch (fallbackError) {
        reportError('training.openMapsFallback', fallbackError);
        setMapsFailed(true);
      }
    }
  };

  return (
    <>
      <View style={{ gap: spacing.sm }}>
        <Text variant="title">{session.title}</Text>
        <KindChip
          kind={session.event_kind}
          subtypeText={subtypeText(session.event_kind, session.event_subtype)}
        />
      </View>

      {/* Will it happen? */}
      <View style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm }}>
          <StatusBadge status={status} label={statusBadgeLabel(status, summary)} />
          {isProvisional(status) ? (
            <Text variant="caption" color="textMuted">
              Not final yet
            </Text>
          ) : null}
        </View>
        <Banner tone={bannerTone(status)} message={statusExplanation(status, summary, deadlineText)} />
      </View>

      {/* Organizers: record or correct attendance (the server authorizes it again). */}
      {isOrganizer ? <AttendanceEntryPoint session={session} now={now} /> : null}
      <MyAttendanceOutcome session={session} myResponse={myResponse} />

      {/* When and where */}
      <Card style={{ gap: spacing.lg }}>
        <InfoRow icon="calendar">
          <Text variant="label">
            {relativeDay ? `${relativeDay} · ` : ''}
            {formatDateTimeRange(session.starts_at, session.ends_at, zone)}
          </Text>
          {showZoneNote ? (
            <Text variant="caption" color="textMuted">
              Shown in {zoneCityName(zone)} time, which differs from this device.
            </Text>
          ) : null}
        </InfoRow>

        <InfoRow icon="map-pin">
          <Text variant="label">{session.location_name}</Text>
          {session.address ? <Text color="textMuted">{session.address}</Text> : null}
        </InfoRow>
        <Button
          label="Open in maps"
          variant="secondary"
          size="sm"
          icon="external-link"
          onPress={() => void openMaps()}
        />
        {mapsFailed ? (
          <Banner tone="error" message="Could not open a maps app on this device." />
        ) : null}

        {session.meeting_instructions ? (
          <InfoRow icon="info">
            <Text variant="label">Meeting point</Text>
            <Text>{session.meeting_instructions}</Text>
          </InfoRow>
        ) : null}

        {course ? (
          <InfoRow icon="flag">
            <Text variant="label">Course</Text>
            <Text>{course}</Text>
          </InfoRow>
        ) : null}

        <InfoRow icon="person">
          <Text variant="label">Organizer</Text>
          <Text color="textMuted">
            {session.organizer_id === null
              ? 'Former organizer'
              : organizer.isPending
                ? 'Loading'
                : (organizer.data ?? 'Former organizer')}
          </Text>
        </InfoRow>
      </Card>

      {session.description ? (
        <View style={{ gap: spacing.sm }}>
          <Text variant="heading">About</Text>
          <Text>{session.description}</Text>
        </View>
      ) : null}

      {session.event_notes ? (
        <View style={{ gap: spacing.sm }}>
          <Text variant="heading">Event notes</Text>
          <Text>{session.event_notes}</Text>
        </View>
      ) : null}

      {/* How many, and am I going? */}
      <Card style={{ gap: spacing.md }}>
        {hasMinimum || summary.max !== null ? (
          <ProgressBar
            value={summary.going}
            target={summary.max ?? Math.max(summary.min ?? 0, summary.going)}
            minimum={summary.min ?? undefined}
            unit={hasMinimum ? 'confirmed' : 'going'}
            showText={false}
          />
        ) : null}
        <View style={{ gap: spacing.xxs }}>
          <Text variant="label">{lines.count}</Text>
          {lines.need ? <Text color="textMuted">{lines.need}</Text> : null}
          <Text color="textMuted">
            {hasMinimum ? `Minimum ${summary.min}` : 'No minimum'}
            {summary.max === null ? ', no maximum' : `, maximum ${summary.max}`}
            {lines.spots ? ` (${lines.spots.toLowerCase()})` : ''}
          </Text>
        </View>
        <InfoRow icon="clock">
          <Text variant="label">
            {hasMinimum ? 'Answer by' : 'Registration closes'} {deadlineText}
          </Text>
        </InfoRow>
        <Divider />
        <RsvpControl session={session} myResponse={myResponse} now={now} />
      </Card>

      <Participants sessionId={session.id} />

      {/* Hidden from members; the server authorizes both actions again. */}
      {isOrganizer ? (
        <OrganizerActions
          session={session}
          onEdit={() => router.push(`/trainings/${session.id}/edit`)}
        />
      ) : null}
    </>
  );
}

export default function TrainingDetailsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const now = useNow();
  const training = useTraining(id);
  const { communities } = useCurrentMembership();

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/trainings');
  };
  const refetch = () => {
    training.refetch().catch((error: unknown) => reportError('training.refetch', error));
  };

  let body;
  // An event of a community I am not an active member of is not mine to see.
  if (training.data && roleInCommunity(communities, training.data.community_id) !== null) {
    body = <TrainingDetails session={training.data} now={now} />;
  } else if (training.isPending) {
    body = <LoadingState message="Loading event" style={{ flex: 1 }} />;
  } else if (training.isError) {
    body = (
      <ErrorState
        message={userMessage(toAppError(training.error).code)}
        onRetry={refetch}
        style={{ flex: 1 }}
      />
    );
  } else {
    // Loaded, and there is no such row for me: deleted, a wrong link, or I
    // am no longer a member (RLS hides it, the two look the same).
    body = (
      <EmptyState
        title="Event not found"
        message="It may have been removed, or you no longer have access to it."
        action={{ label: 'See all events', onPress: () => router.replace('/trainings') }}
        style={{ flex: 1 }}
      />
    );
  }

  return (
    <Screen scroll onRefresh={refetch} refreshing={training.isRefetching && !training.isPending}>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={goBack} />
      </View>
      {body}
    </Screen>
  );
}
