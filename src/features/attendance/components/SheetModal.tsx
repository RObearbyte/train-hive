import type { ReactNode } from 'react';
import { Modal, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Text, useTheme } from '@/ui';

export interface SheetModalProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** A full-height panel that slides over the screen (for the member search and the audit trail). */
export function SheetModal({ visible, title, onClose, children }: SheetModalProps) {
  const { colors, spacing } = useTheme();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <View
          accessibilityViewIsModal
          style={{ flex: 1, padding: spacing.lg, gap: spacing.lg }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <Text variant="title" style={{ flex: 1 }}>
              {title}
            </Text>
            <Button label="Close" variant="secondary" size="sm" onPress={onClose} />
          </View>
          {children}
        </View>
      </SafeAreaView>
    </Modal>
  );
}
