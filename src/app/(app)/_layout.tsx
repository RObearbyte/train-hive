import { Stack } from 'expo-router';
import { View } from 'react-native';

import { PushProvider } from '@/features/notifications/hooks/PushProvider';
import { useActivityRealtime } from '@/features/notifications/hooks/useActivityRealtime';
import { useNotificationLinks } from '@/features/notifications/hooks/useNotificationLinks';
import { ContentColumn } from '@/features/shell/components/ContentColumn';
import { WebSidebar } from '@/features/shell/components/WebSidebar';
import { useLayout } from '@/features/shell/hooks/useLayout';
import { useTrainingsRealtime } from '@/features/trainings/hooks/useTrainingsRealtime';
import { useTheme } from '@/ui';

export const unstable_settings = { anchor: '(tabs)' };

function AppStack() {
  const { colors } = useTheme();
  // Live channels for the whole signed-in area; they close when this layout unmounts.
  useTrainingsRealtime();
  useActivityRealtime();
  // Notification taps (including a cold start) -> allowlisted deep links.
  useNotificationLinks();

  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    />
  );
}

/** Wide screens: a left sidebar next to a centred content column. Narrow: the screens alone (the tabs have their own bar). */
function AppShell() {
  const layout = useLayout();
  if (!layout.sidebar) return <AppStack />;
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <WebSidebar width={layout.sidebarWidth} />
      <View style={{ flex: 1 }}>
        <ContentColumn maxWidth={layout.contentMaxWidth}>
          <AppStack />
        </ContentColumn>
      </View>
    </View>
  );
}

/** Everything behind the membership gate. Detail and form screens are pushed above the tabs. */
export default function AppLayout() {
  return (
    <PushProvider>
      <AppShell />
    </PushProvider>
  );
}
