import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { formatDateTime, isValidTimeZone } from '@/lib/datetime';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text, useTheme } from '@/ui';

import { scheduledNote } from '../domain/presentation';
import { useAnnouncement } from '../hooks/useActivity';
import { useCancelAnnouncement, useMarkAnnouncementRead } from '../hooks/useActivityMutations';
import { announcementEditHref, announcementsListHref } from './routes';
import { StatusChip } from './parts';

/** One announcement. Opening a published one marks it read (and its notification). */
export function AnnouncementDetailScreen({ id }: { id: string }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const { community, isOrganizer } = useCurrentMembership();
  const query = useAnnouncement(id);
  const markRead = useMarkAnnouncementRead();
  const cancel = useCancelAnnouncement(id);
  const [confirming, setConfirming] = useState(false);
  const announcement = query.data ?? null;
  const published = announcement?.status === 'published';
  const markedFor = useRef<string | null>(null);

  const zone = community && isValidTimeZone(community.timezone) ? community.timezone : 'UTC';

  // Once per opened announcement; the call is idempotent on the server.
  useEffect(() => {
    if (!published || markedFor.current === id) return;
    markedFor.current = id;
    markRead.mutate(id);
  }, [published, id, markRead]);

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace(announcementsListHref);
  };

  let body;
  if (announcement) {
    body = (
      <>
        {isOrganizer ? <StatusChip status={announcement.status} /> : null}
        <Text variant="title">{announcement.title}</Text>
        {published && announcement.published_at ? (
          <Text variant="caption" color="textMuted">
            Published {formatDateTime(announcement.published_at, zone)} ({zone})
          </Text>
        ) : null}
        {announcement.status === 'scheduled' ? (
          <Banner tone="info" message={scheduledNote(announcement, zone)} />
        ) : null}
        {announcement.status === 'cancelled' ? (
          <Banner tone="warning" message="This announcement was cancelled and was never published." />
        ) : null}
        <Card>
          <Text>{announcement.body}</Text>
        </Card>
        {markRead.error ? (
          <Banner tone="warning" message={userMessage(markRead.error.code, markRead.error.field)} />
        ) : null}
        {isOrganizer && announcement.status === 'scheduled' ? (
          <View style={{ gap: spacing.sm }}>
            <Button
              label="Edit"
              variant="secondary"
              icon="edit"
              fullWidth
              onPress={() => router.push(announcementEditHref(announcement.id))}
            />
            <Button
              label="Cancel announcement"
              variant="danger"
              fullWidth
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
      </>
    );
  } else if (query.isPending) {
    body = <LoadingState message="Loading announcement" style={{ flex: 1 }} />;
  } else if (query.isError) {
    body = (
      <ErrorState
        message={userMessage(toAppError(query.error).code)}
        onRetry={() => {
          query.refetch().catch((error: unknown) => reportError('announcement.refetch', error));
        }}
        style={{ flex: 1 }}
      />
    );
  } else {
    body = (
      <EmptyState
        title="Announcement not found"
        message="It may have been cancelled, or you no longer have access to it."
        action={{ label: 'See all announcements', onPress: () => router.replace(announcementsListHref) }}
        style={{ flex: 1 }}
      />
    );
  }

  return (
    <Screen scroll>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={back} />
      </View>
      {body}
    </Screen>
  );
}
