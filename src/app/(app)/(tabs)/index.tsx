import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { EmptyState, Screen, Text, useTheme } from '@/ui';

// The next training and one-tap RSVP arrive with M1-A2.
export default function HomeScreen() {
  const { spacing } = useTheme();
  const { community, profile, isOrganizer } = useCurrentMembership();

  return (
    <Screen scroll edges={['top', 'left', 'right']}>
      <View style={{ gap: spacing.xs }}>
        <Text variant="title">{profile ? `Hi, ${profile.display_name}` : 'Home'}</Text>
        {community ? <Text color="textMuted">{community.name}</Text> : null}
      </View>
      <EmptyState
        title="No trainings yet"
        message={
          isOrganizer
            ? 'Trainings you create will show up here for the whole community.'
            : 'When your organizer plans a training, it will show up here.'
        }
        style={{ flex: 1 }}
      />
    </Screen>
  );
}
