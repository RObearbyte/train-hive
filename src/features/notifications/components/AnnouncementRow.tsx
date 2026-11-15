import type { Announcement } from '@/lib/database.types';
import { ListItem } from '@/ui';

import { bodyPreview, publishedWhen } from '../domain/presentation';
import { DotSlot } from './parts';

type Props = {
  announcement: Announcement;
  unread: boolean;
  zone: string;
  now: Date;
  onPress: () => void;
};

/** One published announcement in a list: unread dot, title, when and a preview. */
export function AnnouncementRow({ announcement, unread, zone, now, onPress }: Props) {
  const when = publishedWhen(announcement, zone, now);
  const subtitle = [when, bodyPreview(announcement.body)].filter((part) => part !== '').join(' · ');
  return (
    <ListItem
      title={announcement.title}
      subtitle={subtitle}
      leading={<DotSlot unread={unread} />}
      onPress={onPress}
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${announcement.title}. ${subtitle}`}
    />
  );
}
