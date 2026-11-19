import { Tabs } from 'expo-router/js-tabs';

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
  const { colors, typography } = useTheme();
  // On wide screens the sidebar (see (app)/_layout) replaces the bottom tab bar.
  const { sidebar } = useLayout();
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
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: tabIcon('home') }} />
      <Tabs.Screen name="trainings" options={{ title: 'Events', tabBarIcon: tabIcon('calendar') }} />
      <Tabs.Screen name="statistics" options={{ title: 'Statistics', tabBarIcon: tabIcon('chart') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person') }} />
    </Tabs>
  );
}
