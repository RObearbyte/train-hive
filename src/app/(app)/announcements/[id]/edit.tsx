import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { EditAnnouncementForm } from '@/features/notifications/components/AnnouncementForm';
import { useAnnouncement } from '@/features/notifications/hooks/useActivity';
import { announcementHref, announcementsListHref } from '@/features/notifications/components/routes';
import { isValidTimeZone } from '@/lib/datetime';
import { toAppError, userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Button, EmptyState, ErrorState, LoadingState, Screen } from '@/ui';

export default function EditAnnouncementScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { community, isOrganizer, isLoading: membershipLoading } = useCurrentMembership();
  const query = useAnnouncement(id);
  const announcement = query.data ?? null;

  // Back to the details underneath, or replace this screen when opened by a link.
  const toDetails = () => router.dismissTo(announcementHref(id));

  if (!membershipLoading && !isOrganizer) return <Redirect href={announcementHref(id)} />;

  if (
    announcement &&
    announcement.status === 'scheduled' &&
    isOrganizer &&
    community &&
    isValidTimeZone(community.timezone)
  ) {
    return (
      <EditAnnouncementForm
        announcement={announcement}
        timezone={community.timezone}
        onSaved={toDetails}
        onClose={toDetails}
      />
    );
  }

  let body;
  if (announcement && announcement.status !== 'scheduled') {
    body = (
      <EmptyState
        title="This announcement can no longer be edited"
        message={
          announcement.status === 'cancelled'
            ? 'It was cancelled.'
            : 'It has already been published.'
        }
        action={{ label: 'Back to the announcement', onPress: toDetails }}
        style={{ flex: 1 }}
      />
    );
  } else if (announcement && community && !isValidTimeZone(community.timezone)) {
    body = (
      <ErrorState
        title="Time zone not supported"
        message={`This device does not know the community's time zone (${community.timezone}), so the publish time cannot be edited safely.`}
        style={{ flex: 1 }}
      />
    );
  } else if (query.isPending || membershipLoading) {
    body = <LoadingState message="Loading announcement" style={{ flex: 1 }} />;
  } else if (query.isError) {
    body = (
      <ErrorState
        message={userMessage(toAppError(query.error).code)}
        onRetry={() => {
          query.refetch().catch((error: unknown) => reportError('announcement.edit', error));
        }}
        style={{ flex: 1 }}
      />
    );
  } else {
    body = (
      <EmptyState
        title="Announcement not found"
        message="It may have been removed, or you no longer have access to it."
        action={{ label: 'See all announcements', onPress: () => router.replace(announcementsListHref) }}
        style={{ flex: 1 }}
      />
    );
  }

  return (
    <Screen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={toDetails} />
      </View>
      {body}
    </Screen>
  );
}
