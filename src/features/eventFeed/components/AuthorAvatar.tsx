import { StyleSheet, View } from 'react-native';

import { Avatar, Text, useTheme } from '@/ui';

import { aliasInitials, aliasTint } from '../domain/feed';

type Props = { name: string; anonymous: boolean; size?: number };

/**
 * A named author gets the usual avatar; an anonymous nickname gets a circle in a
 * color derived from the nickname (stable, theme tokens only) with a dashed border,
 * so it differs from a named avatar without relying on color.
 */
export function AuthorAvatar({ name, anonymous, size = 32 }: Props) {
  const { colors } = useTheme();
  if (!anonymous) return <Avatar name={name} size={size} />;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${name}, anonymous`}
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors[aliasTint(name)],
          borderColor: colors.borderStrong,
        },
      ]}
    >
      <Text variant="label" style={{ fontSize: Math.round(size * 0.38), lineHeight: Math.round(size * 0.5) }}>
        {aliasInitials(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderStyle: 'dashed' },
});
