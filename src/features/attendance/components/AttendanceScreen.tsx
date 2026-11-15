import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { useCommunityMembers } from '@/features/community/hooks/useCommunityMembers';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { useTraining } from '@/features/trainings/hooks/useTrainings';
import type { AttendanceSheet, AttendanceSheetEntry, TrainingSession } from '@/lib/database.types';
import { formatDateTime, formatDateTimeRange, isValidTimeZone } from '@/lib/datetime';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { useNow } from '@/lib/useNow';
import { Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text, useTheme } from '@/ui';

import { markAllSummary, runMarkAll, type MarkAllProgress, type MarkAllResult } from '../domain/markAll';
import {
  countEntries,
  countsText,
  deviceSaysEnded,
  isEditableMode,
  markAllTargets,
  nextStatusOnTap,
  sheetMode,
  sortEntries,
  type SheetMode,
} from '../domain/sheet';
import { useFinalizeAttendance, useRecordAttendance } from '../hooks/useAttendanceMutations';
import { useAttendanceSheet } from '../hooks/useAttendanceSheet';
import { AddAttendeeModal } from './AddAttendeeModal';
import { AttendanceRow } from './AttendanceRow';
import { AuditHistoryModal } from './AuditHistoryModal';
import { ReasonDialog } from './ReasonDialog';

type MarkAllState =
  | { phase: 'idle' }
  | { phase: 'running'; progress: MarkAllProgress }
  | { phase: 'done'; result: MarkAllResult<string> };

function unavailableCopy(
  mode: Exclude<SheetMode, { kind: 'record' } | { kind: 'correct' }>,
  session: TrainingSession | null | undefined,
  zone: string,
): { title: string; message: string } {
  switch (mode.kind) {
    case 'not_confirmed':
      return {
        title: 'Attendance is not open',
        message:
          'This training is not confirmed, so there is nothing to record yet. Attendance opens after a confirmed training has ended.',
      };
    case 'cancelled':
      return {
        title: 'This training was cancelled',
        message: 'A cancelled training never takes attendance and does not count in anyone’s history.',
      };
    case 'not_ended':
      return mode.hint === 'server_behind'
        ? {
            title: 'Waiting for the server',
            message:
              'This phone says the training is over, but the server has not registered its end yet. Check that the date and time on your phone are right, then pull down to refresh.',
          }
        : {
            title: 'This training has not ended yet',
            message: session
              ? `Attendance opens once it is over (${formatDateTime(session.ends_at ?? session.starts_at, zone)}).`
              : 'Attendance opens once the training is over.',
          };
  }
}

/**
 * The organizer's attendance screen. Three situations share it:
 * - record: the session ended and is not finalized; mark, add walk-ins, finalize;
 * - correct: finalized; the same list stays editable, every change is audited;
 * - unavailable: not confirmed / cancelled / not ended, explained from the server's state.
 *
 * Segment taps are optimistic and one-per-row at a time. Tapping the active
 * segment clears the mark back to Unrecorded.
 */
export function AttendanceScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { spacing, colors } = useTheme();
  const now = useNow();
  const { community } = useCurrentMembership();
  const training = useTraining(sessionId);
  const sheetQuery = useAttendanceSheet(sessionId, true);
  const record = useRecordAttendance(sessionId);
  const finalize = useFinalizeAttendance(sessionId);

  const [addOpen, setAddOpen] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [markAllOpen, setMarkAllOpen] = useState(false);
  const [markAll, setMarkAll] = useState<MarkAllState>({ phase: 'idle' });
  const [historyFor, setHistoryFor] = useState<{ userId: string; name: string } | null>(null);
  const [reasonFor, setReasonFor] = useState<{ entry: AttendanceSheetEntry; next: 'present' | 'absent' | 'unrecorded' } | null>(null);

  const sheet: AttendanceSheet | undefined = sheetQuery.data;
  const session = training.data;
  const zone = session && isValidTimeZone(session.timezone) ? session.timezone : 'UTC';
  const mode = sheet
    ? sheetMode(sheet, session ? deviceSaysEnded(session, now) : false)
    : null;
  const editable = mode !== null && isEditableMode(mode);

  const entries = useMemo(() => sortEntries(sheet?.entries ?? []), [sheet]);
  const counts = useMemo(() => countEntries(sheet?.entries ?? []), [sheet]);
  const targets = useMemo(() => markAllTargets(sheet?.entries ?? []), [sheet]);

  const finalizedBy = useCommunityMembers(community?.id ?? null, sheet?.status === 'completed');

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(`/trainings/${sessionId}`);
  };
  const refetch = () => {
    sheetQuery.refetch().catch((error: unknown) => reportError('attendance.refetch', error));
    training.refetch().catch((error: unknown) => reportError('attendance.refetchSession', error));
  };

  const onTap = (entry: AttendanceSheetEntry, tapped: 'present' | 'absent') => {
    const next = nextStatusOnTap(entry.attendance_status, tapped);
    if (mode?.kind === 'correct') {
      // A finalized record: offer an optional reason before saving the correction.
      setReasonFor({ entry, next });
      return;
    }
    record.mark({ userId: entry.user_id, next, reason: null });
  };

  const startMarkAll = () => {
    setMarkAllOpen(false);
    const ids = targets.map((entry) => entry.user_id);
    setMarkAll({ phase: 'running', progress: { done: 0, total: ids.length } });
    runMarkAll(
      ids,
      (userId) => record.markAsync({ userId, next: 'present', reason: null }),
      (progress) => setMarkAll({ phase: 'running', progress }),
    )
      .then((result) => setMarkAll({ phase: 'done', result }))
      .catch((error: unknown) => {
        reportError('attendance.markAll', error);
        setMarkAll({ phase: 'idle' });
      });
  };

  const confirmFinalize = () => {
    if (finalize.isPending) return;
    finalize.mutate(undefined, { onSuccess: () => setFinalizeOpen(false) });
  };

  // ---- body states ----------------------------------------------------------------------
  const back = (
    <View style={{ alignItems: 'flex-start' }}>
      <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={goBack} />
    </View>
  );

  if (sheetQuery.isPending) {
    return (
      <Screen>
        {back}
        <LoadingState message="Loading attendance" style={{ flex: 1 }} />
      </Screen>
    );
  }

  if (!sheet || mode === null) {
    const error = toAppError(sheetQuery.error);
    return (
      <Screen>
        {back}
        <ErrorState
          title="Could not load attendance"
          message={userMessage(error.code, error.field)}
          onRetry={refetch}
          style={{ flex: 1 }}
        />
      </Screen>
    );
  }

  if (mode.kind !== 'record' && mode.kind !== 'correct') {
    const copy = unavailableCopy(mode, session, zone);
    return (
      <Screen scroll onRefresh={refetch} refreshing={sheetQuery.isRefetching}>
        {back}
        <EmptyState
          title={copy.title}
          message={copy.message}
          action={{ label: 'Back to the training', onPress: goBack }}
          style={{ flex: 1 }}
        />
      </Screen>
    );
  }

  const finalizedByName =
    sheet.attendance_finalized_by === null
      ? 'a former organizer'
      : (finalizedBy.data?.find((member) => member.userId === sheet.attendance_finalized_by)
          ?.displayName ?? 'an organizer');
  const busy = record.pendingUserIds.size > 0 || markAll.phase === 'running';
  const finalizeError = finalize.error ? userMessage(finalize.error.code, finalize.error.field) : null;
  const nameOf = (userId: string) =>
    sheet.entries.find((entry) => entry.user_id === userId)?.display_name ?? 'Member';

  const header = (
    <View style={{ gap: spacing.md }}>
      {back}
      <View style={{ gap: spacing.xs }}>
        <Text variant="title">Attendance</Text>
        {session ? (
          <>
            <Text variant="label">{session.title}</Text>
            <Text color="textMuted">
              {formatDateTimeRange(session.starts_at, session.ends_at, zone)}
            </Text>
          </>
        ) : null}
      </View>

      {sheetQuery.isError ? (
        <Banner
          tone="warning"
          message={`${userMessage(toAppError(sheetQuery.error).code)} Showing the last list that loaded.`}
          action={{ label: 'Try again', onPress: refetch }}
        />
      ) : null}

      {mode.kind === 'correct' && sheet.attendance_finalized_at ? (
        <Banner
          tone="info"
          title="Attendance is finalized"
          message={`Finalized on ${formatDateTime(sheet.attendance_finalized_at, zone)} by ${finalizedByName}. Changes are recorded in the audit log.`}
        />
      ) : null}

      <Card style={{ gap: spacing.xs }}>
        <Text variant="label" accessibilityLabel={countsText(counts)}>
          {countsText(counts)}
        </Text>
        <Text variant="caption" color="textMuted">
          Not recorded means nobody marked the member. It is never counted as absent.
        </Text>
      </Card>

      {mode.kind === 'record' ? (
        <View style={{ gap: spacing.sm }}>
          <Button
            label={targets.length > 0 ? `Mark all present (${targets.length})` : 'Mark all present'}
            variant="secondary"
            icon="check"
            disabled={targets.length === 0 || busy}
            onPress={() => setMarkAllOpen(true)}
            fullWidth
          />
        </View>
      ) : null}
      <Button
        label="Add attendee"
        variant="secondary"
        icon="plus"
        onPress={() => setAddOpen(true)}
        fullWidth
      />

      {markAll.phase === 'running' ? (
        <Banner
          tone="info"
          title="Marking present"
          message={`${markAll.progress.done} of ${markAll.progress.total} done. Keep this screen open.`}
        />
      ) : null}
      {markAll.phase === 'done' ? (
        <Banner
          tone={markAll.result.failed.length > 0 || markAll.result.skipped.length > 0 ? 'warning' : 'success'}
          title={markAllSummary(markAll.result)}
          message={
            markAll.result.failed.length === 0
              ? 'You can change any of them below.'
              : markAll.result.failed
                  .map((failure) => `${nameOf(failure.id)}: ${userMessage(failure.code)}`)
                  .join('\n')
          }
          action={{ label: 'Dismiss', onPress: () => setMarkAll({ phase: 'idle' }) }}
        />
      ) : null}
    </View>
  );

  const footer =
    mode.kind === 'record' ? (
      <View style={{ gap: spacing.sm, paddingTop: spacing.md }}>
        <Button
          label="Finalize attendance"
          icon="flag"
          disabled={busy}
          onPress={() => {
            finalize.reset();
            setFinalizeOpen(true);
          }}
          fullWidth
        />
        <Text variant="caption" color="textMuted" align="center">
          {busy
            ? 'Saving your marks. Finalize when they are done.'
            : 'The training becomes Completed. You can still correct attendance afterwards.'}
        </Text>
      </View>
    ) : null;

  return (
    <Screen padded={false}>
      <FlatList
        data={entries}
        extraData={[record.pendingUserIds, record.rowErrors, mode.kind]}
        keyExtractor={(entry) => entry.user_id}
        renderItem={({ item }) => (
          <AttendanceRow
            entry={item}
            editable={editable}
            pending={record.pendingUserIds.has(item.user_id)}
            error={record.rowErrors[item.user_id] ?? null}
            onTap={(tapped) => onTap(item, tapped)}
            onDismissError={() => record.clearRowError(item.user_id)}
            onHistory={() => setHistoryFor({ userId: item.user_id, name: item.display_name })}
          />
        )}
        ListHeaderComponent={header}
        ListFooterComponent={footer ?? undefined}
        ListEmptyComponent={
          <EmptyState
            title="Nobody said they were going"
            message="Add members who came anyway with Add attendee."
          />
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, padding: spacing.lg, gap: spacing.md }}
        refreshControl={
          <RefreshControl
            refreshing={sheetQuery.isRefetching}
            onRefresh={refetch}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      />

      <ConfirmDialog
        visible={markAllOpen}
        title="Mark everyone not yet recorded as present?"
        message={`${targets.length} ${targets.length === 1 ? 'person is' : 'people are'} not recorded yet. They will be marked Present. You can change any of them afterwards.`}
        confirmLabel="Mark all present"
        cancelLabel="Cancel"
        onConfirm={startMarkAll}
        onCancel={() => setMarkAllOpen(false)}
      />

      <ConfirmDialog
        visible={finalizeOpen}
        title="Finalize attendance?"
        message={`The training becomes Completed and shows in members' attendance history. ${
          counts.unrecorded === 0
            ? 'Everyone has a mark.'
            : `${counts.unrecorded} ${counts.unrecorded === 1 ? 'person stays' : 'people stay'} Not recorded and ${counts.unrecorded === 1 ? 'is' : 'are'} NOT counted as absent.`
        } You can still correct attendance later; every correction is recorded in an audit log.`}
        confirmLabel="Finalize"
        cancelLabel="Not yet"
        pending={finalize.isPending}
        error={finalizeError}
        onConfirm={confirmFinalize}
        onCancel={() => setFinalizeOpen(false)}
      />

      <ReasonDialog
        visible={reasonFor !== null}
        title={
          reasonFor
            ? `${reasonFor.next === 'unrecorded' ? 'Clear the mark of' : `Mark ${reasonFor.next === 'present' ? 'Present:' : 'Absent:'}`} ${reasonFor.entry.display_name}`
            : ''
        }
        onCancel={() => setReasonFor(null)}
        onConfirm={(reason) => {
          if (reasonFor) {
            record.mark({ userId: reasonFor.entry.user_id, next: reasonFor.next, reason });
          }
          setReasonFor(null);
        }}
      />

      <AddAttendeeModal
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        sessionId={sessionId}
        communityId={community?.id ?? null}
        entries={sheet.entries}
      />

      <AuditHistoryModal
        sessionId={sessionId}
        member={historyFor}
        zone={zone}
        onClose={() => setHistoryFor(null)}
      />
    </Screen>
  );
}
