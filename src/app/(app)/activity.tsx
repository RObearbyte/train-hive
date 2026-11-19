import { Redirect, type Href } from 'expo-router';

import { NOTIFICATIONS_ROUTE } from '@/features/notifications/domain/legacyRoutes';

/** The old Activity tab. Still a valid link (push data, stored deep links); it opens the notification centre. */
export default function ActivityRedirect() {
  return <Redirect href={NOTIFICATIONS_ROUTE as Href} />;
}
