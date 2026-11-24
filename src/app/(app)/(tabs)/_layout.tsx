import { Tabs } from 'expo-router/js-tabs';

import { OneTimePagesRedirect } from '@/features/onboarding/components/OneTimePagesRedirect';
import { TAB_LABEL_FONT_SIZE } from '@/features/communities/domain/communityTab';
import { badgeText } from '@/features/notifications/domain/unread';
import { useActivity } from '@/features/notifications/hooks/useActivity';
import { useLayout } from '@/features/shell/hooks/useLayout';
import { Icon, useTheme, type IconName } from '@/ui';

function tabIcon(name: IconName) {
  // Same tokens as the tab label tints below.
  function TabIcon({ focused, size }: { focused: boolean; size: number }) {
    return <Icon name={name} color={focused ? 'primary' : 'textMuted'} size={size} />;
  }
  return TabIcon;
}

export default function TabsLayout() {
  const { colors } = useTheme();
  // On wide screens the sidebar (see (app)/_layout) replaces the bottom tab bar.
  const { sidebar } = useLayout();
  // Display only: announcements and notifications the server says are unread.
  const unread = badgeText(useActivity().unreadCount);
  return (
    <OneTimePagesRedirect>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: sidebar
            ? { display: 'none' }
            : { backgroundColor: colors.surface, borderTopColor: colors.border },
          // Six tabs: 11 dp labels (see tabLabelFits) so none truncates on a 360 dp phone.
          tabBarLabelStyle: { fontSize: TAB_LABEL_FONT_SIZE, fontWeight: '600' },
          tabBarBadgeStyle: { backgroundColor: colors.accent, color: colors.onAccent },
          sceneStyle: { backgroundColor: colors.background },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: tabIcon('home') }} />
        <Tabs.Screen name="trainings" options={{ title: 'Events', tabBarIcon: tabIcon('calendar') }} />
        <Tabs.Screen
          name="communications"
          options={{
            title: 'Communications',
            // The full word does not fit a sixth of a 360 dp phone; the spoken label stays complete.
            tabBarLabel: 'Comms',
            tabBarIcon: tabIcon('bell'),
            tabBarBadge: unread ?? undefined,
            tabBarAccessibilityLabel: unread ? `Communications, ${unread} unread` : 'Communications',
          }}
        />
        <Tabs.Screen name="statistics" options={{ title: 'Statistics', tabBarIcon: tabIcon('chart') }} />
        <Tabs.Screen name="community" options={{ title: 'Community', tabBarIcon: tabIcon('people') }} />
        <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person') }} />
      </Tabs>
    </OneTimePagesRedirect>
  );
}
