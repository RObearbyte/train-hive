import { useState } from 'react';
import { View } from 'react-native';

import type { EventFeed, EventFeedItem } from '@/lib/database.types';
import { formatSessionWhen } from '@/lib/datetime';
import { Button, Card, Divider, Text, useTheme } from '@/ui';

import { authorLabel, roleLabel } from '../domain/feed';
import { AuthorAvatar } from './AuthorAvatar';
import { PostComposer } from './PostComposer';

type Post = EventFeed['posts'][number];

type ItemProps = {
  item: EventFeedItem;
  isNew: boolean;
  zone: string;
  now: Date;
  onDelete: (item: EventFeedItem) => void;
};

function PostHeader({ item, isNew, zone, now, onDelete }: ItemProps) {
  const { spacing, radii, colors } = useTheme();
  const name = authorLabel(item);
  const role = roleLabel(item);
  const nickname = item.author_name ?? name;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <AuthorAvatar name={item.is_anonymous ? nickname : name} anonymous={item.is_anonymous} size={32} />
      <View style={{ flex: 1, gap: spacing.xxs }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs }}>
          <Text variant="label">
            {name}
            {role ? ` · ${role}` : ''}
          </Text>
          {item.is_anonymous ? (
            <View
              style={{
                borderRadius: radii.pill,
                borderWidth: 1,
                borderColor: colors.borderStrong,
                paddingHorizontal: spacing.sm,
                paddingVertical: 1,
              }}
            >
              <Text variant="caption" color="textMuted">
                Anonymous
              </Text>
            </View>
          ) : null}
        </View>
        <Text variant="caption" color="textMuted">
          {formatSessionWhen(item.created_at, zone, now)}
        </Text>
      </View>
      {isNew ? (
        <Text variant="caption" color="primary" accessibilityLabel="New">
          New
        </Text>
      ) : null}
      {item.can_delete ? (
        <Button
          label="Delete"
          variant="ghost"
          size="sm"
          icon="trash"
          accessibilityLabel={`Delete ${item.kind} from ${name}`}
          onPress={() => onDelete(item)}
        />
      ) : null}
    </View>
  );
}

type Props = {
  post: Post;
  newIds: ReadonlySet<string>;
  zone: string;
  now: Date;
  canReply: boolean;
  /** Show the "Post anonymously" switch in the reply box. */
  canReplyAnonymously: boolean;
  onReply: (postId: string, body: string, anonymous: boolean) => Promise<unknown>;
  onDelete: (item: EventFeedItem) => void;
};

/**
 * A top-level item (organizer post or member comment) with its replies (oldest
 * first) and a reply box. Organizer posts have an accent edge; replies are
 * indented under a thin line.
 */
export function PostCard({
  post,
  newIds,
  zone,
  now,
  canReply,
  canReplyAnonymously,
  onReply,
  onDelete,
}: Props) {
  const { spacing, colors } = useTheme();
  const [replying, setReplying] = useState(false);
  const isOrganizerPost = post.kind === 'post';

  return (
    <Card
      style={[
        { gap: spacing.md },
        isOrganizerPost ? { borderLeftWidth: 4, borderLeftColor: colors.primary } : null,
      ]}
    >
      {isOrganizerPost ? (
        <Text variant="caption" color="primary">
          Announcement from an organizer
        </Text>
      ) : null}
      <PostHeader item={post} isNew={newIds.has(post.id)} zone={zone} now={now} onDelete={onDelete} />
      <Text>{post.body}</Text>

      {post.replies.length > 0 ? (
        <View
          style={{
            gap: spacing.md,
            paddingLeft: spacing.md,
            borderLeftWidth: 2,
            borderLeftColor: colors.border,
          }}
        >
          {post.replies.map((reply) => (
            <View key={reply.id} style={{ gap: spacing.xs }}>
              <PostHeader item={reply} isNew={newIds.has(reply.id)} zone={zone} now={now} onDelete={onDelete} />
              <Text>{reply.body}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {canReply ? (
        <>
          <Divider />
          {replying ? (
            <PostComposer
              label="Your reply"
              submitLabel="Reply"
              autoFocus
              allowAnonymous={canReplyAnonymously}
              onSubmit={(body, anonymous) => onReply(post.id, body, anonymous)}
              onDone={() => setReplying(false)}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <View style={{ alignItems: 'flex-start' }}>
              <Button
                label="Reply"
                variant="ghost"
                size="sm"
                accessibilityLabel={`Reply to ${authorLabel(post)}`}
                onPress={() => setReplying(true)}
              />
            </View>
          )}
        </>
      ) : null}
    </Card>
  );
}
