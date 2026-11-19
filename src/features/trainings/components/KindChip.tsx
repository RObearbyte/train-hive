import { View } from 'react-native';

import type { EventKind } from '@/lib/database.types';
import { Icon, Text, useTheme } from '@/ui';

import { kindInfo } from '../domain/events';

export interface KindChipProps {
  kind: EventKind;
  /** Subtype label shown after the kind, e.g. "Trail running". */
  subtypeText?: string;
}

/** Kind of an event: glyph + words, never colour alone. */
export function KindChip({ kind, subtypeText }: KindChipProps) {
  const { colors, radii, spacing } = useTheme();
  const info = kindInfo(kind);
  const text = subtypeText ? `${info.label} · ${subtypeText}` : info.label;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={subtypeText ? `Kind: ${info.label}, ${subtypeText}` : `Kind: ${info.label}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: spacing.xs,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xxs + 1,
        borderRadius: radii.pill,
        backgroundColor: colors.primarySoft,
      }}
    >
      <Icon name={info.icon} size={14} color="onPrimarySoft" />
      <Text variant="caption" color="onPrimarySoft" style={{ fontWeight: '700' }}>
        {text}
      </Text>
    </View>
  );
}
