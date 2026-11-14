import { useState, type ComponentRef, type Ref } from 'react';
import { StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import { Icon } from './Icon';
import { Text } from './Text';

export interface TextFieldProps extends TextInputProps {
  label: string;
  helper?: string;
  /** When set the field is shown in its error state. */
  error?: string;
  containerStyle?: StyleProp<ViewStyle>;
  /** React 19 ref-as-prop: pass the RHF Controller `field.ref` straight through. */
  ref?: Ref<ComponentRef<typeof TextInput>>;
}

/**
 * Labelled input. Props `value`, `onChangeText`, `onBlur` and the forwarded `ref`
 * match what React Hook Form's `Controller` render prop provides.
 */
export function TextField({
  label,
  helper,
  error,
  containerStyle,
  onFocus,
  onBlur,
  editable = true,
  style,
  ref,
  ...rest
}: TextFieldProps) {
  const { colors, radii, spacing, typography, minTouchTarget } = useTheme();
  const [focused, setFocused] = useState(false);

  const borderColor = error ? colors.danger : focused ? colors.primary : colors.borderStrong;
  const hint = error ?? helper;

  return (
    <View style={[styles.container, { gap: spacing.xs }, containerStyle]}>
      <Text variant="label">{label}</Text>
      <TextInput
        ref={ref}
        editable={editable}
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: !editable }}
        placeholderTextColor={colors.textMuted}
        maxFontSizeMultiplier={1.6}
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={[
          typography.body,
          {
            minHeight: minTouchTarget + 6,
            borderRadius: radii.md,
            borderWidth: focused || error ? 2 : 1,
            borderColor,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            color: colors.text,
            backgroundColor: editable ? colors.surface : colors.background,
          },
          style,
        ]}
      />
      {error ? (
        <View style={styles.row} accessibilityLiveRegion="polite">
          <Icon name="alert" size={16} color="danger" />
          <Text variant="caption" color="danger" style={styles.flex}>
            {error}
          </Text>
        </View>
      ) : helper ? (
        <Text variant="caption" color="textMuted">
          {helper}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flex: { flex: 1 },
});
