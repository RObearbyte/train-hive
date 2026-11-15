import { useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';

import { Button, Card, Text, TextField, useTheme } from '@/ui';

/** `record_attendance` rejects a reason longer than this (`validation_failed:reason`). */
export const REASON_MAX_LENGTH = 200;

export interface ReasonDialogProps {
  visible: boolean;
  /** e.g. "Mark Ann as Absent". */
  title: string;
  onConfirm: (reason: string | null) => void;
  onCancel: () => void;
}

/**
 * Shown when changing a value after attendance was finalized. The reason is
 * optional; leaving it empty saves the correction without one.
 */
export function ReasonDialog({ visible, title, onConfirm, onCancel }: ReasonDialogProps) {
  const { colors, spacing } = useTheme();
  const [reason, setReason] = useState('');

  const close = () => {
    setReason('');
    onCancel();
  };
  const confirm = () => {
    const trimmed = reason.trim();
    setReason('');
    onConfirm(trimmed === '' ? null : trimmed);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={close}>
      <View style={[styles.fill, { padding: spacing.xl }]} accessibilityViewIsModal>
        <View style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: colors.hero }]} />
        <Card style={[styles.card, { gap: spacing.lg }]}>
          <View style={{ gap: spacing.sm }}>
            <Text variant="heading">{title}</Text>
            <Text color="textMuted">
              This changes a finalized record. The change is kept in the audit log with your name.
            </Text>
          </View>
          <TextField
            label="Reason (optional)"
            value={reason}
            onChangeText={setReason}
            maxLength={REASON_MAX_LENGTH}
            helper={`${reason.length} / ${REASON_MAX_LENGTH}`}
            returnKeyType="done"
            autoCapitalize="sentences"
          />
          <View style={{ gap: spacing.sm }}>
            <Button label="Save correction" onPress={confirm} fullWidth />
            <Button label="Cancel" variant="ghost" onPress={close} fullWidth />
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
