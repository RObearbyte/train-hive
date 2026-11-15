import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import type { Announcement } from '@/lib/database.types';
import { userMessage } from '@/lib/errors';
import { Button, Card, Text, useTheme } from '@/ui';

import { useCancelAnnouncement } from '../hooks/useActivityMutations';
import { bodyPreview, scheduledNote } from '../domain/presentation';
import { announcementEditHref, announcementHref } from './routes';
import { StatusChip } from './parts';

type Props = { announcement: Announcement; zone: string };

/** An organizer's scheduled (or cancelled) announcement with Edit and Cancel. */
export function ManagedAnnouncementCard({ announcement, zone }: Props) {
  const router = useRouter();
  const { spacing } = useTheme();
  const cancel = useCancelAnnouncement(announcement.id);
  const [confirming, setConfirming] = useState(false);
  const scheduled = announcement.status === 'scheduled';

  return (
    <Card
      style={{ gap: spacing.sm }}
      onPress={() => router.push(announcementHref(announcement.id))}
      accessibilityLabel={`${announcement.title}. ${announcement.status}`}
    >
      <StatusChip status={announcement.status} />
      <View style={{ gap: spacing.xxs }}>
        <Text variant="heading">{announcement.title}</Text>
        <Text color="textMuted">{bodyPreview(announcement.body, 140)}</Text>
      </View>
      {scheduled ? (
        <Text variant="caption" color="textMuted">
          {scheduledNote(announcement, zone)}
        </Text>
      ) : null}
      {scheduled ? (
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button
            label="Edit"
            variant="secondary"
            size="sm"
            icon="edit"
            onPress={() => router.push(announcementEditHref(announcement.id))}
          />
          <Button
            label="Cancel"
            variant="ghost"
            size="sm"
            onPress={() => {
              cancel.reset();
              setConfirming(true);
            }}
          />
        </View>
      ) : null}
      <ConfirmDialog
        visible={confirming}
        title="Cancel this announcement?"
        message="It will not be published. Nobody has been notified, and you cannot undo this."
        confirmLabel="Cancel announcement"
        cancelLabel="Keep it"
        destructive
        pending={cancel.isPending}
        error={cancel.error ? userMessage(cancel.error.code, cancel.error.field) : null}
        onConfirm={() => cancel.mutate(undefined, { onSuccess: () => setConfirming(false) })}
        onCancel={() => setConfirming(false)}
      />
    </Card>
  );
}
