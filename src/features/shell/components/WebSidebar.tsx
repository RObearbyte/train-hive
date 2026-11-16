import { usePathname, useRouter, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { badgeText } from '@/features/notifications/domain/unread';
import { useActivity } from '@/features/notifications/hooks/useActivity';
import { Icon, Text, useTheme } from '@/ui';

import { activeNavKey, NAV_ITEMS, type NavItem } from '../domain/navItems';

function SidebarLink({ item, active, badge }: { item: NavItem; active: boolean; badge: string | null }) {
  const { colors, radii, spacing } = useTheme();
  const router = useRouter();
  return (
      <Pressable
        onPress={() => router.navigate(item.href as Href)}
        accessibilityRole="link"
        accessibilityLabel={badge ? `${item.label}, ${badge} unread` : item.label}
        accessibilityState={{ selected: active }}
        // The accessibility role "link" renders an anchor; "current page" marks the active one.
        aria-current={active ? 'page' : undefined}
        style={({ pressed, hovered, focused }: { pressed: boolean; hovered?: boolean; focused?: boolean }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.md,
          minHeight: 44,
          paddingHorizontal: spacing.md,
          borderRadius: radii.md,
          backgroundColor: active ? colors.primarySoft : hovered || pressed ? colors.border : 'transparent',
          borderWidth: 2,
          borderColor: focused ? colors.primary : 'transparent',
        })}
      >
        <Icon name={item.icon} size={22} color={active ? 'onPrimarySoft' : 'textMuted'} />
        <Text variant="label" color={active ? 'onPrimarySoft' : 'text'} style={{ flex: 1 }}>
          {item.label}
        </Text>
        {badge ? (
          <View
            accessibilityElementsHidden
            style={{
              minWidth: 22,
              height: 22,
              paddingHorizontal: spacing.xs,
              borderRadius: radii.pill,
              backgroundColor: colors.accent,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text variant="caption" color="onAccent" style={{ fontWeight: '700' }}>
              {badge}
            </Text>
          </View>
        ) : null}
      </Pressable>
  );
}

/** Left navigation for wide screens; replaces the bottom tab bar. Shown on every signed-in screen. */
export function WebSidebar({ width }: { width: number }) {
  const { colors, spacing } = useTheme();
  const active = activeNavKey(usePathname());
  const unread = badgeText(useActivity().unreadCount);

  return (
    <SafeAreaView
      edges={['top', 'bottom', 'left']}
      style={{ width, backgroundColor: colors.surface, borderRightWidth: 1, borderRightColor: colors.border }}
    >
      <View accessibilityRole="navigation" aria-label="Main" style={{ padding: spacing.md, gap: spacing.xs }}>
        <Text variant="heading" style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.md }}>
          TrainHive
        </Text>
        {NAV_ITEMS.map((item) => (
          <SidebarLink
            key={item.key}
            item={item}
            active={active === item.key}
            badge={item.key === 'activity' ? unread : null}
          />
        ))}
      </View>
    </SafeAreaView>
  );
}
