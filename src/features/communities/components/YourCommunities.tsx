import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { useNow } from '@/lib/useNow';
import { Divider, Icon, ListItem, Text, useTheme } from '@/ui';

import { buildSwitcherItems, type SwitcherItem } from '../domain/switcher';

/** "Organizer" / "Member" pill; the role is also in the row's spoken label. */
export function RoleBadge({ role }: { role: SwitcherItem['roleLabel'] }) {
  const { colors, radii, spacing } = useTheme();
  const organizer = role === 'Organizer';
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{
        backgroundColor: organizer ? colors.primarySoft : colors.surface,
        borderColor: organizer ? colors.primarySoft : colors.border,
        borderWidth: 1,
        borderRadius: radii.sm,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xxs,
      }}
    >
      <Text variant="caption" color={organizer ? 'onPrimarySoft' : 'textMuted'}>
        {role}
      </Text>
    </View>
  );
}

/** Rows of my communities with their role; tapping one makes it the active community. */
export function YourCommunities() {
  const { spacing } = useTheme();
  const now = useNow(30_000);
  const { communities, activeCommunityId, selectCommunity } = useCurrentMembership();
  const items = buildSwitcherItems(communities, activeCommunityId, now);

  return (
    <>
      {items.map((item) => (
        <View key={item.id}>
          <ListItem
            title={item.name}
            subtitle={item.timezoneLabel}
            accessibilityLabel={`${item.accessibilityLabel}${item.isActive ? '' : '. Switch to this community'}`}
            showChevron={false}
            trailing={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <RoleBadge role={item.roleLabel} />
                {item.isActive ? <Icon name="check" size={22} color="primary" /> : null}
              </View>
            }
            onPress={() => {
              if (!item.isActive) selectCommunity(item.id);
            }}
          />
          <Divider />
        </View>
      ))}
    </>
  );
}
