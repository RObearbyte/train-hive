import { Tabs } from 'expo-router/js-tabs';

import { Icon, useTheme, type IconName } from '@/ui';

function tabIcon(name: IconName) {
  // Same tokens as the tab label tints below.
  function TabIcon({ focused, size }: { focused: boolean; size: number }) {
    return <Icon name={name} color={focused ? 'primary' : 'textMuted'} size={size} />;
  }
  return TabIcon;
}

// Activity and Statistics tabs are added when Milestones 3 and 4 are functional.
export default function TabsLayout() {
  const { colors, typography } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarLabelStyle: { fontSize: typography.caption.fontSize, fontWeight: '600' },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: tabIcon('home') }} />
      <Tabs.Screen name="trainings" options={{ title: 'Trainings', tabBarIcon: tabIcon('calendar') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person') }} />
    </Tabs>
  );
}
