import { useRouter } from 'expo-router';
import { Pressable } from 'react-native';

import { eventFeedHref } from '@/features/notifications/components/routes';
import { Icon, Text, useTheme } from '@/ui';

import { useDiscussionChip } from '../hooks/useDiscussionChip';

/**
 * Small chip on an event card: accent with "3 new" when there are unread
 * messages, quiet with the post count otherwise, nothing without posts.
 * Opens the discussion directly. Render it outside the card's main button.
 */
export function DiscussionChip({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { colors, radii, spacing, minTouchTarget } = useTheme();
  const chip = useDiscussionChip(sessionId);
  if (chip === null) return null;

  return (
    <Pressable
      onPress={() => router.push(eventFeedHref(sessionId))}
      accessibilityRole="button"
      accessibilityLabel={chip.label}
      accessibilityHint="Opens the discussion"
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: spacing.xs,
        minHeight: Math.min(minTouchTarget, 32),
        paddingHorizontal: spacing.sm,
        borderRadius: radii.pill,
        marginTop: spacing.sm,
        backgroundColor: chip.unread ? colors.accent : 'transparent',
        borderWidth: 1,
        borderColor: chip.unread ? colors.accent : colors.border,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name="megaphone" size={14} color={chip.unread ? 'onAccent' : 'textMuted'} />
      <Text
        variant="caption"
        color={chip.unread ? 'onAccent' : 'textMuted'}
        style={{ fontWeight: '700' }}
      >
        {chip.text}
      </Text>
    </Pressable>
  );
}
