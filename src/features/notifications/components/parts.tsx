import { View } from 'react-native';

import type { AnnouncementStatus } from '@/lib/database.types';
import { Icon, Text, useTheme, type ColorToken, type IconName } from '@/ui';

import { ANNOUNCEMENT_STATUS_LABEL } from '../domain/presentation';

/** A filled dot marking something unread. Decorative: the row's label says "Unread". */
export function UnreadDot() {
  const { colors } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary }}
    />
  );
}

/** Keeps the leading column the same width whether or not the dot shows. */
export function DotSlot({ unread }: { unread: boolean }) {
  return <View style={{ width: 10, alignItems: 'center' }}>{unread ? <UnreadDot /> : null}</View>;
}

const CHIP: Record<AnnouncementStatus, { icon: IconName; fg: ColorToken; bg: ColorToken }> = {
  scheduled: { icon: 'clock', fg: 'info', bg: 'infoSoft' },
  published: { icon: 'check-circle', fg: 'success', bg: 'successSoft' },
  cancelled: { icon: 'ban', fg: 'danger', bg: 'dangerSoft' },
};

/** Glyph plus label, never colour alone. */
export function StatusChip({ status }: { status: AnnouncementStatus }) {
  const { colors, radii, spacing } = useTheme();
  const chip = CHIP[status];
  return (
    <View
      accessible
      accessibilityLabel={`Status: ${ANNOUNCEMENT_STATUS_LABEL[status]}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        alignSelf: 'flex-start',
        backgroundColor: colors[chip.bg],
        borderRadius: radii.pill,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xxs,
      }}
    >
      <Icon name={chip.icon} size={14} color={chip.fg} />
      <Text variant="caption" color="text" style={{ fontWeight: '700' }}>
        {ANNOUNCEMENT_STATUS_LABEL[status]}
      </Text>
    </View>
  );
}
