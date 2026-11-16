import { useId, useState, type CSSProperties } from 'react';
import { View } from 'react-native';

import { Icon, Text, useTheme } from '@/ui';

import type { DateTimeFieldProps } from './DateTimeField.types';

/**
 * Web: the browser's own `<input type="date">` / `<input type="time">`. They
 * give a real picker on phones and desktops, and their value is exactly what
 * the form stores (`yyyy-MM-dd`, 24-hour `HH:mm`, '' when empty or
 * incomplete), whatever the display locale. The form schema still validates
 * the value. Android and iOS use `DateTimeField.native.tsx`.
 */
export function DateTimeField({
  label,
  mode,
  value,
  onChange,
  onBlur,
  error,
  helper,
  disabled = false,
  optional = false,
}: DateTimeFieldProps) {
  const { colors, radii, spacing, typography, minTouchTarget, scheme } = useTheme();
  const id = useId();
  const hintId = `${id}-hint`;
  const [focused, setFocused] = useState(false);

  const hint = error ?? helper ?? (optional ? 'Optional' : undefined);
  const borderColor = error ? colors.danger : focused ? colors.primary : colors.borderStrong;

  return (
    <View style={{ alignSelf: 'stretch', gap: spacing.xs }}>
      <Text variant="label">{label}</Text>
      <input
        id={id}
        type={mode}
        aria-label={label}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint ? hintId : undefined}
        // Opened by keyboard users too: the browser shows its picker from the field itself.
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        style={
          {
            fontSize: typography.body.fontSize,
            fontFamily: 'inherit',
            boxSizing: 'border-box',
            width: '100%',
            minHeight: minTouchTarget + 6,
            borderRadius: radii.md,
            borderStyle: 'solid',
            borderWidth: focused || error ? 2 : 1,
            borderColor,
            padding: `${spacing.sm}px ${spacing.md}px`,
            color: colors.text,
            backgroundColor: disabled ? colors.background : colors.surface,
            // Dark pickers in the dark theme.
            colorScheme: scheme,
            outline: 'none',
          } satisfies CSSProperties
        }
      />
      {error ? (
        <View
          nativeID={hintId}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          accessibilityLiveRegion="polite"
        >
          <Icon name="alert" size={16} color="danger" />
          <Text variant="caption" color="danger" style={{ flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : hint ? (
        <Text variant="caption" color="textMuted" nativeID={hintId}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
