import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { ResponsiveModal } from '@/features/shell/components/ResponsiveModal';
import { FLOW_ROUTES } from '@/features/onboarding/domain/flowRoutes';
import { useNow } from '@/lib/useNow';
import { Button, Divider, Icon, ListItem, Text, useTheme } from '@/ui';

import { buildSwitcherItems, canSwitchCommunity, communityTitle } from '../domain/switcher';

/**
 * The community name at the top of Home. With several communities it is a
 * button that opens the switcher; with one it is plain text (no chevron, no
 * clutter: joining or creating another one lives in Profile).
 */
export function CommunityTitle() {
  const { spacing } = useTheme();
  const { community, communities, activeCommunityId } = useCurrentMembership();
  const { colors, radii } = useTheme();
  const [open, setOpen] = useState(false);
  // The name from the list is known before the community itself has loaded.
  const name = communityTitle(communities, activeCommunityId, community?.name);

  if (name === null) {
    return (
      <View
        accessible
        accessibilityLabel="Loading community name"
        style={{ height: 32, width: 180, borderRadius: radii.sm, backgroundColor: colors.border }}
      />
    );
  }
  if (!canSwitchCommunity(communities)) return <Text variant="title">{name}</Text>;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}. Switch community`}
        accessibilityHint="Opens the list of your communities"
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          minHeight: 44,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text variant="title" style={{ flexShrink: 1 }} numberOfLines={2}>
          {name}
        </Text>
        <View style={{ transform: [{ rotate: '90deg' }] }}>
          <Icon name="chevron-right" size={22} color="textMuted" />
        </View>
      </Pressable>
      <CommunitySwitcherSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Bottom sheet listing my communities, with the active one checked. */
export function CommunitySwitcherSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const now = useNow(30_000);
  const { communities, activeCommunityId, selectCommunity } = useCurrentMembership();
  const items = buildSwitcherItems(communities, activeCommunityId, now);

  const open = (route: string) => {
    onClose();
    router.push(route as Href);
  };

  return (
    <ResponsiveModal visible={visible} onClose={onClose} variant="sheet">
      <Text variant="heading">Your communities</Text>
      <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
        {items.map((item, index) => (
          <View key={item.id}>
            {index > 0 ? <Divider /> : null}
            <ListItem
              title={item.name}
              subtitle={`${item.roleLabel} · ${item.timezoneLabel}`}
              accessibilityLabel={item.accessibilityLabel}
              showChevron={false}
              trailing={
                item.isActive ? <Icon name="check" size={22} color="primary" /> : undefined
              }
              onPress={() => {
                if (!item.isActive) selectCommunity(item.id);
                onClose();
              }}
            />
          </View>
        ))}
      </ScrollView>
      <Divider />
      <Button
        label="Join another community"
        variant="secondary"
        icon="plus"
        fullWidth
        onPress={() => open(FLOW_ROUTES.signedIn.joinCode)}
      />
      <Button
        label="Have a creator code?"
        variant="ghost"
        size="sm"
        fullWidth
        onPress={() => open(FLOW_ROUTES.signedIn.createCode)}
      />
    </ResponsiveModal>
  );
}

