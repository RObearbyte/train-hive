import { View } from 'react-native';

import type { AppNotification, NotificationKind } from '@/lib/database.types';
import { formatSessionWhen, isValidTimeZone } from '@/lib/datetime';
import { Icon, ListItem, type IconName } from '@/ui';

import { bodyPreview } from '../domain/presentation';
import { DotSlot } from './parts';

const KIND_ICON: Record<NotificationKind, IconName> = {
  training_created: 'calendar',
  training_updated: 'edit',
  training_confirmed: 'check-circle',
  training_cancelled: 'ban',
  training_reminder: 'clock',
  announcement_published: 'megaphone',
  event_post: 'megaphone',
  event_reply: 'people',
  workout_log_prompt: 'edit',
};

type Props = {
  notification: AppNotification;
  zone: string;
  now: Date;
  onPress: () => void;
};

export function NotificationRow({ notification, zone, now, onPress }: Props) {
  const unread = notification.read_at === null;
  const safeZone = isValidTimeZone(zone) ? zone : 'UTC';
  const when = formatSessionWhen(notification.created_at, safeZone, now);
  const subtitle = [bodyPreview(notification.body, 140), when].filter((part) => part !== '').join(' · ');
  return (
    <ListItem
      title={notification.title}
      subtitle={subtitle}
      leading={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <DotSlot unread={unread} />
          <Icon name={KIND_ICON[notification.kind]} size={22} color={unread ? 'primary' : 'textMuted'} />
        </View>
      }
      onPress={onPress}
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${notification.title}. ${subtitle}`}
    />
  );
}
