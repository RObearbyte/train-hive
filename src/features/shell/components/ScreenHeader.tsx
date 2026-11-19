import type { ReactNode } from 'react';
import { View } from 'react-native';

import { NotificationBell } from '@/features/notifications/components/NotificationBell';
import { Text, useTheme } from '@/ui';

export interface ScreenHeaderProps {
  /** Plain title text. Ignored when `left` is given. */
  title?: string;
  /** Replaces the title (Home shows the community name and switcher). */
  left?: ReactNode;
  /** Extra controls between the title and the bell. */
  actions?: ReactNode;
  /** The bell is the default; the notification centre itself turns it off. */
  showBell?: boolean;
}

/** Title (or custom content) on the left, the notification bell on the right: the same place on every main screen. */
export function ScreenHeader({ title, left, actions, showBell = true }: ScreenHeaderProps) {
  const { spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={{ flex: 1 }}>
        {left ?? (
          <Text variant="title" accessibilityRole="header">
            {title}
          </Text>
        )}
      </View>
      {actions}
      {showBell ? <NotificationBell /> : null}
    </View>
  );
}
