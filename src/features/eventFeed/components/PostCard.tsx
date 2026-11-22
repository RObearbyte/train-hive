import { useState } from 'react';
import { View } from 'react-native';

import type { EventFeed, EventFeedItem } from '@/lib/database.types';
import { formatSessionWhen } from '@/lib/datetime';
import { Avatar, Button, Card, Divider, Text, useTheme } from '@/ui';

import { authorLabel, roleLabel } from '../domain/feed';
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
  const { spacing } = useTheme();
  const name = authorLabel(item);
  const role = roleLabel(item);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <Avatar name={name} size={32} />
      <View style={{ flex: 1 }}>
        <Text variant="label">
          {name}
          {role ? ` · ${role}` : ''}
        </Text>
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
          accessibilityLabel={`Delete message from ${name}`}
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
  onReply: (postId: string, body: string) => Promise<unknown>;
  onDelete: (item: EventFeedItem) => void;
};

/** A top-level post with its replies (oldest first) and a reply box. */
export function PostCard({ post, newIds, zone, now, canReply, onReply, onDelete }: Props) {
  const { spacing, colors } = useTheme();
  const [replying, setReplying] = useState(false);

  return (
    <Card style={{ gap: spacing.md }}>
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
              onSubmit={(body) => onReply(post.id, body)}
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
