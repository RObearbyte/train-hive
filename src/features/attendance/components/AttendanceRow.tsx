import { StyleSheet, View } from 'react-native';

import type { AppError } from '@/lib/errors';
import { userMessage } from '@/lib/errors';
import type { AttendanceSheetEntry, AttendanceStatus } from '@/lib/database.types';
import { Avatar, Banner, Button, Card, Icon, Text, useTheme, type ColorToken, type IconName } from '@/ui';

import { originLabel, statusLabel } from '../domain/sheet';
import { AttendanceToggle } from './AttendanceToggle';

export interface AttendanceRowProps {
  entry: AttendanceSheetEntry;
  /** False for read-only states: the toggle is disabled. */
  editable: boolean;
  pending: boolean;
  error: AppError | null;
  onTap: (tapped: Exclude<AttendanceStatus, 'unrecorded'>) => void;
  onDismissError: () => void;
  /** Opens the audit trail for this member; only offered once they have a record. */
  onHistory: () => void;
}

const STATUS_STYLE: Record<AttendanceStatus, { icon: IconName; color: ColorToken }> = {
  present: { icon: 'check-circle', color: 'success' },
  absent: { icon: 'close', color: 'danger' },
  unrecorded: { icon: 'circle', color: 'textMuted' },
};

/**
 * One member: name, why they are on the list, what is recorded, and the
 * Present / Absent control. "Not recorded" has a dashed chip so it can never
 * be mistaken for "Absent".
 */
export function AttendanceRow({
  entry,
  editable,
  pending,
  error,
  onTap,
  onDismissError,
  onHistory,
}: AttendanceRowProps) {
  const { colors, spacing, radii } = useTheme();
  const status = entry.attendance_status;
  const style = STATUS_STYLE[status];
  const former = entry.membership_status !== 'active';

  return (
    <Card
      style={{ gap: spacing.md }}
    >
      <View style={[styles.head, { gap: spacing.md }]}>
        <Avatar name={entry.display_name} size={40} />
        <View style={styles.name}>
          <Text variant="label" numberOfLines={2}>
            {entry.display_name}
          </Text>
          <Text variant="caption" color="textMuted">
            {originLabel(entry)}
            {former ? ' · No longer a member' : ''}
          </Text>
        </View>
        <View
          accessible
          accessibilityLabel={`Status: ${statusLabel(status)}`}
          style={[
            styles.chip,
            {
              borderRadius: radii.pill,
              borderColor: status === 'unrecorded' ? colors.borderStrong : colors[style.color],
              borderStyle: status === 'unrecorded' ? 'dashed' : 'solid',
              backgroundColor:
                status === 'present'
                  ? colors.successSoft
                  : status === 'absent'
                    ? colors.dangerSoft
                    : 'transparent',
            },
          ]}
        >
          <Icon name={style.icon} size={14} color={style.color} />
          <Text variant="caption" color={status === 'unrecorded' ? 'textMuted' : 'text'}>
            {statusLabel(status)}
          </Text>
        </View>
      </View>

      <AttendanceToggle
        status={status}
        name={entry.display_name}
        onTap={onTap}
        pending={pending}
        disabled={!editable}
      />

      {entry.has_record ? (
        <View style={styles.footer}>
          <Button
            label="History"
            variant="ghost"
            size="sm"
            icon="clock"
            onPress={onHistory}
            accessibilityLabel={`History of ${entry.display_name}`}
          />
        </View>
      ) : null}

      {error ? (
        <Banner
          tone="error"
          title="Not saved"
          message={`${userMessage(error.code, error.field)} The previous value is back.`}
          action={{ label: 'Dismiss', onPress: onDismissError }}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  name: { flex: 1, gap: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  footer: { flexDirection: 'row', justifyContent: 'flex-end' },
});
