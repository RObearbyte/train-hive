import { useLocalSearchParams } from 'expo-router';

import { EventFeedScreen } from '@/features/eventFeed/components/EventFeedScreen';

/** Discussion of an event (also the target of the `/events/<id>/feed` notification link). */
export default function EventFeedRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <EventFeedScreen sessionId={id} />;
}
