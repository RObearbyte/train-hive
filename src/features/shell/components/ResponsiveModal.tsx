import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/ui';

import { useDialogLayout } from '../hooks/useLayout';

export interface ResponsiveModalProps {
  visible: boolean;
  onClose: () => void;
  /**
   * `sheet`: a bottom sheet on narrow screens (content is wrapped in the sheet surface).
   * `page`: a full-screen page on narrow screens (content brings its own padding).
   * On wide web windows both become a centred card.
   */
  variant: 'sheet' | 'page';
  /** Wider card for panels with lists; ordinary dialogs stay <= 480 px. */
  kind?: 'dialog' | 'panel';
  /** `page` on phones: wrap the content in a safe-area view (turn off when the content is a `Screen`, which has its own). */
  safeArea?: boolean;
  children: ReactNode;
}

/**
 * Modal chrome that adapts to the window: bottom sheet or full-screen page on
 * phones, a centred card (<= 480 / 640 px, closes on a scrim click or Escape)
 * on desktop. The content stays the caller's.
 */
export function ResponsiveModal({ visible, onClose, variant, kind = 'dialog', safeArea = true, children }: ResponsiveModalProps) {
  const { colors, radii, spacing } = useTheme();
  const dialog = useDialogLayout(kind);

  if (dialog.centered) {
    return (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.center} accessibilityViewIsModal>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.hero, opacity: 0.55 }]}
          />
          <View
            style={{
              width: '100%',
              maxWidth: dialog.maxWidth ?? undefined,
              maxHeight: '85%',
              // Pages fill the card so lists can scroll; sheets size to their content.
              height: variant === 'page' ? '85%' : undefined,
              backgroundColor: variant === 'page' ? colors.background : colors.surface,
              borderRadius: radii.lg,
              borderWidth: 1,
              borderColor: colors.border,
              overflow: 'hidden',
              padding: variant === 'sheet' ? spacing.lg : 0,
              gap: variant === 'sheet' ? spacing.md : 0,
            }}
          >
            {children}
          </View>
        </View>
      </Modal>
    );
  }

  if (variant === 'page') {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        {safeArea ? (
          <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>{children}</SafeAreaView>
        ) : (
          children
        )}
      </Modal>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.bottom} accessibilityViewIsModal>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.hero, opacity: 0.55 }]}
        />
        <View
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radii.xl,
            borderTopRightRadius: radii.xl,
            padding: spacing.lg,
            gap: spacing.md,
            maxHeight: '80%',
          }}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  bottom: { flex: 1, justifyContent: 'flex-end' },
});
