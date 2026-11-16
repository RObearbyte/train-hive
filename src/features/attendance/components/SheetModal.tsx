import type { ReactNode } from 'react';
import { View } from 'react-native';

import { ResponsiveModal } from '@/features/shell/components/ResponsiveModal';
import { Button, Text, useTheme } from '@/ui';

export interface SheetModalProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A full-height panel that slides over the screen (for the member search and
 * the audit trail); a centred card on desktop browsers.
 */
export function SheetModal({ visible, title, onClose, children }: SheetModalProps) {
  const { spacing } = useTheme();
  return (
    <ResponsiveModal visible={visible} onClose={onClose} variant="page" kind="panel">
      <View accessibilityViewIsModal style={{ flex: 1, padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <Text variant="title" style={{ flex: 1 }}>
            {title}
          </Text>
          <Button label="Close" variant="secondary" size="sm" onPress={onClose} />
        </View>
        {children}
      </View>
    </ResponsiveModal>
  );
}
