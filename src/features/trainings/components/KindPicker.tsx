import { Pressable, View } from 'react-native';

import type { EventKind } from '@/lib/database.types';
import { Icon, Text, useTheme } from '@/ui';

import { EVENT_KINDS, kindInfo } from '../domain/events';

export interface KindPickerProps {
  onPick: (kind: EventKind) => void;
}

/** Four large cards, one per kind: icon, name and a one-line description. */
export function KindPicker({ onPick }: KindPickerProps) {
  const { colors, radii, spacing, minTouchTarget } = useTheme();
  return (
    <View style={{ gap: spacing.md }} accessibilityRole="menu">
      {EVENT_KINDS.map((kind) => {
        const info = kindInfo(kind);
        return (
          <Pressable
            key={kind}
            onPress={() => onPick(kind)}
            accessibilityRole="button"
            accessibilityLabel={`${info.label}. ${info.description}`}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.lg,
              minHeight: Math.max(minTouchTarget, 88),
              padding: spacing.lg,
              borderRadius: radii.lg,
              borderWidth: 1.5,
              borderColor: colors.borderStrong,
              backgroundColor: pressed ? colors.primarySoft : colors.surfaceRaised,
            })}
          >
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: radii.pill,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.primarySoft,
              }}
            >
              <Icon name={info.icon} size={26} color="onPrimarySoft" />
            </View>
            <View style={{ flex: 1, gap: spacing.xxs }}>
              <Text variant="heading">{info.label}</Text>
              <Text color="textMuted">{info.description}</Text>
            </View>
            <Icon name="chevron-right" size={20} color="textMuted" />
          </Pressable>
        );
      })}
    </View>
  );
}
