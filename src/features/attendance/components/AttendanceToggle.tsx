import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { AttendanceStatus } from '@/lib/database.types';
import { Icon, Text, useTheme, type ColorToken, type IconName } from '@/ui';

type Choice = Exclude<AttendanceStatus, 'unrecorded'>;

export interface AttendanceToggleProps {
  status: AttendanceStatus;
  /** The member's name, for the spoken labels. */
  name: string;
  onTap: (tapped: Choice) => void;
  /** A change to this row is being saved: taps are ignored and a spinner shows. */
  pending?: boolean;
  disabled?: boolean;
}

const OPTIONS: readonly { value: Choice; label: string; icon: IconName }[] = [
  { value: 'present', label: 'Present', icon: 'check' },
  { value: 'absent', label: 'Absent', icon: 'close' },
];

/**
 * Present / Absent as two large buttons. With neither selected the row is
 * unrecorded, and both look the same neutral outlined way; a selected one is
 * filled and has a glyph (never color alone). Tapping the selected one clears
 * it back to unrecorded.
 */
export function AttendanceToggle({
  status,
  name,
  onTap,
  pending = false,
  disabled = false,
}: AttendanceToggleProps) {
  const { colors, radii, spacing, minTouchTarget } = useTheme();
  const locked = pending || disabled;

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={`Attendance of ${name}`}
      style={[styles.row, { gap: spacing.sm }]}
    >
      {OPTIONS.map((option) => {
        const selected = status === option.value;
        const bg = selected ? (option.value === 'present' ? colors.primary : colors.danger) : colors.surface;
        const fg: ColorToken = selected
          ? option.value === 'present'
            ? 'onPrimary'
            : 'onDanger'
          : 'text';
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={`${option.label}, ${name}`}
            accessibilityHint={selected ? 'Tap again to clear this mark' : undefined}
            accessibilityState={{ checked: selected, disabled: locked, busy: pending }}
            onPress={locked ? undefined : () => onTap(option.value)}
            style={({ pressed }) => [
              styles.option,
              {
                minHeight: minTouchTarget + 8,
                borderRadius: radii.md,
                backgroundColor: bg,
                borderColor: selected ? bg : colors.borderStrong,
                opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
              },
            ]}
          >
            <Icon name={selected ? 'check-circle' : option.icon} size={20} color={fg} />
            <Text variant="label" color={fg}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
      {pending ? (
        <View style={styles.spinner}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  option: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
  },
  spinner: { width: 24, alignItems: 'center' },
});
