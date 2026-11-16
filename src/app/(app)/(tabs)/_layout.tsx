import { Tabs } from 'expo-router/js-tabs';

import { useLayout } from '@/features/shell/hooks/useLayout';
import { badgeText } from '@/features/notifications/domain/unread';
import { useActivity } from '@/features/notifications/hooks/useActivity';
import { Icon, useTheme, type IconName } from '@/ui';

function tabIcon(name: IconName) {
  // Same tokens as the tab label tints below.
  function TabIcon({ focused, size }: { focused: boolean; size: number }) {
    return <Icon name={name} color={focused ? 'primary' : 'textMuted'} size={size} />;
  }
  return TabIcon;
}

export default function TabsLayout() {
  const { colors, typography } = useTheme();
  // On wide screens the sidebar (see (app)/_layout) replaces the bottom tab bar.
  const { sidebar } = useLayout();
  // Display only: announcements and notifications the server says are unread.
  const unread = badgeText(useActivity().unreadCount);
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: sidebar
          ? { display: 'none' }
          : { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarLabelStyle: { fontSize: typography.caption.fontSize, fontWeight: '600' },
        tabBarBadgeStyle: { backgroundColor: colors.accent, color: colors.onAccent },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: tabIcon('home') }} />
      <Tabs.Screen name="trainings" options={{ title: 'Trainings', tabBarIcon: tabIcon('calendar') }} />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: tabIcon('bell'),
          tabBarBadge: unread ?? undefined,
          tabBarAccessibilityLabel: unread ? `Activity, ${unread} unread` : 'Activity',
        }}
      />
      <Tabs.Screen name="statistics" options={{ title: 'Statistics', tabBarIcon: tabIcon('chart') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person') }} />
    </Tabs>
  );
}
