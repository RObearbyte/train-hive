import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { useTraining } from '@/features/trainings/hooks/useTrainings';
import type { EventFeed, EventFeedItem } from '@/lib/database.types';
import { deviceTimeZone, formatDateTime, isValidTimeZone } from '@/lib/datetime';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { useNow } from '@/lib/useNow';
import { Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text, useTheme } from '@/ui';

import { accumulateNewIds, feedErrorMessage } from '../domain/feed';
import {
  useCreateEventComment,
  useCreateEventPost,
  useDeleteEventPost,
  useEventFeed,
  useMarkEventFeedRead,
  useReplyToEventPost,
} from '../hooks/useEventFeed';
import { PostCard } from './PostCard';
import { PostComposer } from './PostComposer';

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The discussion of one event. Organizers write posts, every member replies.
 * Opening it (and every later change while it is open) marks it read on the
 * server; posts that were unread keep a "New" cue until the screen closes.
 */
export function EventFeedScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const now = useNow();
  const training = useTraining(sessionId);
  const feed = useEventFeed(sessionId);
  const createPost = useCreateEventPost(sessionId);
  const createComment = useCreateEventComment(sessionId);
  const reply = useReplyToEventPost(sessionId);
  const remove = useDeleteEventPost(sessionId);
  const markRead = useMarkEventFeedRead(sessionId);
  const [toDelete, setToDelete] = useState<EventFeedItem | null>(null);
  const [seen, setSeen] = useState<{ source: EventFeed | undefined; ids: ReadonlySet<string> }>({
    source: undefined,
    ids: NO_IDS,
  });

  const data = feed.data;
  const zoneCandidate = training.data?.timezone ?? deviceTimeZone() ?? 'UTC';
  const zone = isValidTimeZone(zoneCandidate) ? zoneCandidate : 'UTC';

  // Remember what was unread when it arrived (adjusted while rendering, not in an effect)...
  if (data && data !== seen.source) setSeen({ source: data, ids: accumulateNewIds(seen.ids, data) });
  const newIds = seen.ids;

  // ...then tell the server it was seen.
  const markReadRef = useRef(markRead.mutate);
  useEffect(() => {
    markReadRef.current = markRead.mutate;
  });
  const unread = data?.unread_count ?? 0;
  useEffect(() => {
    if (!data) return;
    if (data.unread_count > 0) markReadRef.current();
  }, [data, unread]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(`/trainings/${sessionId}`);
  };
  const refetch = () => {
    feed.refetch().catch((error: unknown) => reportError('eventFeed.refetch', error));
  };

  let body;
  if (data) {
    body = (
      <>
        {!data.is_open ? (
          <Banner
            tone="info"
            title="Discussion closed"
            message={`New messages were accepted until ${formatDateTime(data.closes_at, zone)}. You can still read everything.`}
          />
        ) : null}

        {data.can_post ? (
          <PostComposer
            label="Post to everyone going"
            submitLabel="Post"
            onSubmit={(text) => createPost.mutateAsync(text)}
          />
        ) : null}

        {data.posts.length === 0 ? (
          <EmptyState
            title="No messages yet"
            message={
              data.can_post
                ? 'Post an update, a question or a reminder. Members going to the event are notified.'
                : data.can_comment
                  ? 'Organizers post updates here. Write a comment below or reply to a message.'
                  : 'Organizers post updates here, and you can reply to them.'
            }
          />
        ) : (
          <View style={{ gap: spacing.md }}>
            {data.posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                newIds={newIds}
                zone={zone}
                now={now}
                canReply={data.can_reply}
                canReplyAnonymously={data.can_comment_anonymously}
                onReply={(postId, text, anonymous) =>
                  reply.mutateAsync({ postId, body: text, anonymous })
                }
                onDelete={(item) => {
                  remove.reset();
                  setToDelete(item);
                }}
              />
            ))}
          </View>
        )}
        {data.can_comment ? (
          <Card>
            <PostComposer
              label="Write a comment"
              submitLabel="Comment"
              allowAnonymous={data.can_comment_anonymously}
              onSubmit={(text, anonymous) => createComment.mutateAsync({ body: text, anonymous })}
            />
          </Card>
        ) : null}
        {feed.isError ? (
          <Banner tone="warning" message="Could not refresh. Showing the last messages we loaded." />
        ) : null}
      </>
    );
  } else if (feed.isPending) {
    body = <LoadingState message="Loading discussion" style={{ flex: 1 }} />;
  } else {
    const code = toAppError(feed.error).code;
    body =
      code === 'not_a_member' || code === 'not_found' ? (
        <EmptyState
          title="Discussion not available"
          message={`${userMessage(code)} It may have been removed, or you no longer have access to it.`}
          action={{ label: 'See all events', onPress: () => router.replace('/trainings') }}
          style={{ flex: 1 }}
        />
      ) : (
        <ErrorState message={userMessage(code)} onRetry={refetch} style={{ flex: 1 }} />
      );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen scroll onRefresh={refetch} refreshing={feed.isRefetching && !feed.isPending}>
        <View style={{ alignItems: 'flex-start' }}>
          <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={goBack} />
        </View>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">Discussion</Text>
          {training.data ? <Text color="textMuted">{training.data.title}</Text> : null}
        </View>
        {body}
      </Screen>

      <ConfirmDialog
        visible={toDelete !== null}
        title={`Delete this ${toDelete?.kind ?? 'message'}?`}
        message={
          toDelete?.parent_id === null
            ? `The ${toDelete.kind} and all replies under it are removed for everyone. This cannot be undone.`
            : 'The reply is removed for everyone. This cannot be undone.'
        }
        confirmLabel="Delete"
        cancelLabel="Keep"
        destructive
        pending={remove.isPending}
        error={remove.error ? feedErrorMessage(remove.error, 'delete') : null}
        onConfirm={() => {
          if (toDelete === null) return;
          remove.mutate(toDelete.id, { onSuccess: () => setToDelete(null) });
        }}
        onCancel={() => setToDelete(null)}
      />
    </KeyboardAvoidingView>
  );
}
