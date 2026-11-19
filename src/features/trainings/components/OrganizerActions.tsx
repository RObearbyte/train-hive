import { useState } from 'react';
import { View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import type { TrainingSession } from '@/lib/database.types';
import { userMessage } from '@/lib/errors';
import { Banner, Button, Text, useTheme } from '@/ui';

import { isEditable } from '../domain/schema';
import { useCancelTraining } from '../hooks/useTrainingMutations';

export interface OrganizerActionsProps {
  session: Pick<TrainingSession, 'id' | 'status' | 'title'>;
  onEdit: () => void;
}

/**
 * Edit and Cancel for organizers. Render it only for organizers; the server
 * authorizes both actions again. Renders nothing once neither is possible.
 */
export function OrganizerActions({ session, onEdit }: OrganizerActionsProps) {
  const { spacing } = useTheme();
  const cancel = useCancelTraining(session.id);
  const [confirming, setConfirming] = useState(false);

  const canEdit = isEditable(session.status);
  const canCancel = session.status === 'scheduled' || session.status === 'confirmed';
  // A failed cancel is explained in the dialog while it is open, here afterwards.
  const failure = cancel.error ? userMessage(cancel.error.code, cancel.error.field) : null;

  if (!canEdit && !canCancel && failure === null) return null;

  const closeDialog = () => setConfirming(false);
  const confirmCancel = () => {
    if (cancel.isPending) return;
    cancel.mutate(undefined, {
      onSuccess: closeDialog,
      onError: (error) => {
        // Completed or already has attendance: nothing to retry, so close and explain on the
        // screen (the hook has already refetched the session).
        if (error.code === 'session_not_cancellable' || error.code === 'session_has_attendance') closeDialog();
      },
    });
  };

  return (
    <View style={{ gap: spacing.md }}>
      <Text variant="heading">Organizer</Text>
      {failure !== null && !confirming ? (
        <Banner
          tone="error"
          title="The event was not cancelled"
          message={failure}
          action={{ label: 'Dismiss', onPress: cancel.reset }}
        />
      ) : null}
      {canEdit ? (
        <Button label="Edit event" variant="secondary" icon="edit" onPress={onEdit} fullWidth />
      ) : null}
      {canCancel ? (
        <Button
          label="Cancel event"
          variant="danger"
          icon="ban"
          onPress={() => {
            cancel.reset();
            setConfirming(true);
          }}
          fullWidth
        />
      ) : null}

      <ConfirmDialog
        visible={confirming}
        title="Cancel this event?"
        message={`Members will see "${session.title}" as cancelled by the organizer and can no longer answer. This cannot be undone.`}
        confirmLabel="Cancel event"
        cancelLabel="Keep training"
        destructive
        pending={cancel.isPending}
        error={failure}
        onConfirm={confirmCancel}
        onCancel={closeDialog}
      />
    </View>
  );
}
