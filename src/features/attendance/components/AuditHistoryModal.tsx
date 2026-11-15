import { FlatList, View } from 'react-native';

import { formatDateTime, isValidTimeZone } from '@/lib/datetime';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Card, EmptyState, ErrorState, LoadingState, Text, useTheme } from '@/ui';

import type { AuditTrailItem } from '../api/attendance';
import { statusLabel } from '../domain/sheet';
import { useAuditTrail } from '../hooks/useAttendanceSheet';
import { SheetModal } from './SheetModal';

export interface AuditHistoryModalProps {
  sessionId: string;
  /** The member whose history is shown; null closes the panel. */
  member: { userId: string; name: string } | null;
  /** IANA zone of the session, for the timestamps. */
  zone: string;
  onClose: () => void;
}

function actionText(item: AuditTrailItem): string {
  switch (item.action) {
    case 'walk_in_add':
      return 'Added as a walk-in';
    case 'correct':
      return 'Corrected';
    case 'record':
      return 'Recorded';
  }
}

/** The audit trail of one member for this session (organizers only, read from `attendance_audit_log`). */
export function AuditHistoryModal({ sessionId, member, zone, onClose }: AuditHistoryModalProps) {
  const { spacing } = useTheme();
  const trail = useAuditTrail(sessionId, member !== null);
  const safeZone = isValidTimeZone(zone) ? zone : 'UTC';
  const items = (trail.data ?? []).filter((item) => item.userId === member?.userId);

  let body;
  if (trail.isPending) {
    body = <LoadingState message="Loading history" style={{ flex: 1 }} />;
  } else if (trail.isError && !trail.data) {
    body = (
      <ErrorState
        title="Could not load history"
        message={userMessage(toAppError(trail.error).code)}
        onRetry={() => {
          trail.refetch().catch((error: unknown) => reportError('attendance.audit', error));
        }}
        style={{ flex: 1 }}
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        title="No changes yet"
        message="Nothing has been recorded for this member in this session."
        style={{ flex: 1 }}
      />
    );
  } else {
    body = (
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ gap: spacing.md }}
        renderItem={({ item }) => (
          <Card style={{ gap: spacing.xs }}>
            <Text variant="label">
              {actionText(item)}: {statusLabel(item.oldStatus)} to {statusLabel(item.newStatus)}
            </Text>
            <Text variant="caption" color="textMuted">
              {formatDateTime(item.changedAt, safeZone)} by {item.changedByName ?? 'a former organizer'}
            </Text>
            {item.reason ? <Text>Reason: {item.reason}</Text> : null}
          </Card>
        )}
      />
    );
  }

  return (
    <SheetModal visible={member !== null} title={member ? `History: ${member.name}` : 'History'} onClose={onClose}>
      <View style={{ flex: 1 }}>{body}</View>
    </SheetModal>
  );
}
