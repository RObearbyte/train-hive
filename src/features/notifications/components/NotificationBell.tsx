import { useRouter, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Icon, Text, useTheme } from '@/ui';

import { bellAccessibilityLabel, bellBadgeText } from '../domain/bell';
import { NOTIFICATIONS_ROUTE } from '../domain/legacyRoutes';
import { useActivity } from '../hooks/useActivity';

/**
 * The bell at the top right of every main screen. The badge is display only
 * (the server decides what is unread); a tap opens the notification centre.
 */
export function NotificationBell() {
  const router = useRouter();
  const { colors, radii, minTouchTarget } = useTheme();
  const { unreadCount } = useActivity();
  const badge = bellBadgeText(unreadCount);

  return (
    <Pressable
      onPress={() => router.push(NOTIFICATIONS_ROUTE as Href)}
      accessibilityRole="button"
      accessibilityLabel={bellAccessibilityLabel(unreadCount)}
      accessibilityHint="Opens your notifications"
      hitSlop={4}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({
        width: minTouchTarget,
        height: minTouchTarget,
        borderRadius: radii.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? colors.primarySoft : 'transparent',
        borderWidth: 2,
        // Visible keyboard focus on the web.
        borderColor: focused ? colors.primary : 'transparent',
      })}
    >
      <Icon name="bell" size={24} color="text" />
      {badge ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            minWidth: 20,
            height: 20,
            paddingHorizontal: 4,
            borderRadius: radii.pill,
            backgroundColor: colors.accent,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            color="onAccent"
            style={{ fontSize: 11, lineHeight: 14, fontWeight: '700' }}
          >
            {badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
