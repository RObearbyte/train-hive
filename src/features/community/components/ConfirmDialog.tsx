import { Modal, StyleSheet, View } from 'react-native';

import { Banner, Button, Card, Text, useTheme } from '@/ui';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** The confirm action destroys or cancels something: shown as a danger button. */
  destructive?: boolean;
  /** The confirmed action is running: the confirm button spins and the dialog stays open. */
  pending?: boolean;
  /** Why the confirmed action failed, shown inside the dialog. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A blocking yes / no question. Built on `Modal` rather than `Alert.alert`
 * because `Alert` does nothing on web.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  pending = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { colors, spacing } = useTheme();
  const dismiss = pending ? undefined : onCancel;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={dismiss}
    >
      <View style={[styles.fill, { padding: spacing.xl }]} accessibilityViewIsModal>
        <View style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: colors.hero }]} />
        <Card style={[styles.card, { gap: spacing.lg }]}>
          <View style={{ gap: spacing.sm }}>
            <Text variant="heading">{title}</Text>
            <Text color="textMuted">{message}</Text>
          </View>
          {error ? <Banner tone="error" message={error} /> : null}
          <View style={{ gap: spacing.sm }}>
            <Button
              label={confirmLabel}
              variant={destructive ? 'danger' : 'primary'}
              onPress={onConfirm}
              loading={pending}
              fullWidth
            />
            <Button
              label={cancelLabel}
              variant="ghost"
              onPress={onCancel}
              disabled={pending}
              fullWidth
            />
          </View>
        </Card>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scrim: { opacity: 0.6 },
  card: { maxWidth: 480, width: '100%' },
});
