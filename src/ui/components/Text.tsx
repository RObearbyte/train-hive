import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { useTheme, type ColorToken, type TextVariant } from '../theme';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  /** Semantic color token. */
  color?: ColorToken;
  align?: 'left' | 'center' | 'right';
}

export function Text({
  variant = 'body',
  color = 'text',
  align,
  style,
  accessibilityRole,
  ...rest
}: TextProps) {
  const { colors, typography } = useTheme();
  const isHeading = variant === 'display' || variant === 'title' || variant === 'heading';
  return (
    <RNText
      accessibilityRole={accessibilityRole ?? (isHeading ? 'header' : undefined)}
      maxFontSizeMultiplier={1.6}
      {...rest}
      style={[typography[variant], { color: colors[color] }, align ? { textAlign: align } : null, style]}
    />
  );
}
