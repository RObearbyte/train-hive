import { Pressable, View } from 'react-native';

import { NeedsAttendanceCue } from '@/features/attendance/components/AttendanceEntryPoint';
import { RsvpControl } from '@/features/rsvp/components/RsvpControl';
import type { RsvpResponse, TrainingSession } from '@/lib/database.types';
import { formatDateTimeRange, formatSessionWhen, isValidTimeZone } from '@/lib/datetime';
import { Card, Divider, Icon, ProgressBar, StatusBadge, Text, statusMeta, useTheme } from '@/ui';

import { courseLine, kindInfo } from '../domain/events';
import {
  cardAccessibilityLabel,
  isProvisional,
  myRsvpText,
  participationLines,
  statusBadgeLabel,
} from '../domain/presentation';
import { deriveDisplayStatus, participationSummary } from '../domain/status';
import { useSubtypeLabel } from '../hooks/useTrainings';
import { KindChip } from './KindChip';

export interface TrainingCardProps {
  session: TrainingSession;
  myResponse: RsvpResponse;
  /** For display only (Today / Tomorrow, Finalizing). */
  now: Date;
  onPress: () => void;
  /** Show the one-tap answer under the summary. Off for past sessions. */
  showRsvp?: boolean;
  /** Larger "when" line for the featured card on Home. */
  featured?: boolean;
  /** Organizer cue: confirmed, over, attendance not finalized. Display only. */
  needsAttendance?: boolean;
}

/**
 * The five answers, top to bottom: When? Where? How many? Will it happen?
 * Am I going? The summary is one button that opens the details; the RSVP
 * control sits below it as its own control, so neither is nested in the other.
 */
export function TrainingCard({
  session,
  myResponse,
  now,
  onPress,
  showRsvp = true,
  featured = false,
  needsAttendance = false,
}: TrainingCardProps) {
  const { spacing, radii } = useTheme();
  const subtypeText = useSubtypeLabel();

  const zone = isValidTimeZone(session.timezone) ? session.timezone : 'UTC';
  const status = deriveDisplayStatus(session, now);
  const summary = participationSummary(session);
  const when = formatSessionWhen(session.starts_at, zone, now);
  const badgeLabel = statusBadgeLabel(status, summary);
  const lines = participationLines(summary, status);
  const course = courseLine(session);
  const participation = [lines.count, lines.need, lines.spots]
    .filter((part): part is string => part !== null)
    .join(', ');

  return (
    <Card>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityHint="Opens the event details"
        accessibilityLabel={cardAccessibilityLabel({
          title: `${kindInfo(session.event_kind).label}: ${session.title}`,
          when: formatDateTimeRange(session.starts_at, session.ends_at, zone),
          location: session.location_name,
          participation,
          statusLabel: `${badgeLabel ?? statusMeta[status].label}${isProvisional(status) ? ', not final' : ''}`,
          myRsvp: myRsvpText(myResponse),
        }) + (needsAttendance ? '. Needs attendance' : '')}
        style={({ pressed }) => ({
          gap: spacing.md,
          opacity: pressed ? 0.7 : 1,
          borderRadius: radii.md,
        })}
      >
        {/* When */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
          <View style={{ flex: 1, gap: spacing.xxs }}>
            <Text variant={featured ? 'title' : 'heading'} accessibilityRole="text">
              {when}
            </Text>
            <Text variant="label">{session.title}</Text>
          </View>
          <Icon name="chevron-right" size={20} color="textMuted" />
        </View>

        {/* Where and what */}
        <View style={{ gap: spacing.xs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Icon name="map-pin" size={18} color="textMuted" />
            <Text style={{ flex: 1 }} numberOfLines={2}>
              {session.location_name}
            </Text>
          </View>
          <KindChip
            kind={session.event_kind}
            subtypeText={subtypeText(session.event_kind, session.event_subtype)}
          />
          {course ? (
            <Text variant="label" color="textMuted">
              {course}
            </Text>
          ) : null}
        </View>

        {/* How many */}
        <View style={{ gap: spacing.xs }}>
          {summary.min !== null || summary.max !== null ? (
            <ProgressBar
              value={summary.going}
              target={summary.max ?? Math.max(summary.min ?? 0, summary.going)}
              minimum={summary.min ?? undefined}
              unit={summary.min === null ? 'going' : 'confirmed'}
              showText={false}
            />
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md }}>
            <Text variant="label">{lines.count}</Text>
            {lines.need ? <Text color="textMuted">{lines.need}</Text> : null}
            {lines.spots ? <Text color="textMuted">{lines.spots}</Text> : null}
          </View>
        </View>

        {/* Will it happen */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm }}>
          <StatusBadge status={status} label={badgeLabel} />
          {isProvisional(status) ? (
            <Text variant="caption" color="textMuted">
              Not final yet
            </Text>
          ) : null}
          {needsAttendance ? <NeedsAttendanceCue /> : null}
        </View>

        {/* Am I going (as text when there is no control below) */}
        {showRsvp ? null : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Icon
              name={
                myResponse === 'going' ? 'check' : myResponse === 'not_going' ? 'close' : 'circle'
              }
              size={18}
              color="textMuted"
            />
            <Text variant="label" color="textMuted">
              {myRsvpText(myResponse)}
            </Text>
          </View>
        )}
      </Pressable>

      {showRsvp ? (
        <View style={{ gap: spacing.md, marginTop: spacing.md }}>
          <Divider />
          <RsvpControl session={session} myResponse={myResponse} now={now} />
        </View>
      ) : null}
    </Card>
  );
}
