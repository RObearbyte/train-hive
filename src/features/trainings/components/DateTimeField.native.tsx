import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { format } from 'date-fns';
import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import { isValidDateString, isValidTimeString } from '@/lib/datetime';
import { Button, Icon, IconButton, Text, useTheme } from '@/ui';

import type { DateTimeFieldProps } from './DateTimeField.types';

/**
 * The picker works on a device-local Date, used only as a carrier for the
 * wall-clock parts (year / month / day, or hour / minute). No time zone
 * conversion happens here: the form turns wall time into an instant in the
 * session's zone.
 */
function toPickerDate(mode: 'date' | 'time', value: string, suggestion: string | undefined): Date {
  const text = value !== '' ? value : (suggestion ?? '');
  if (mode === 'date') {
    if (isValidDateString(text)) {
      const [year, month, day] = text.split('-').map(Number);
      // Noon keeps the date stable across any daylight-saving change.
      return new Date(year, month - 1, day, 12, 0, 0, 0);
    }
    // Only where the calendar opens; the server checks the chosen date.
    return new Date();
  }
  const [hour, minute] = isValidTimeString(text) ? text.split(':').map(Number) : [9, 0];
  // A fixed winter date, so the time is never inside a daylight-saving gap.
  return new Date(2000, 0, 1, hour, minute, 0, 0);
}

function fromPickerDate(mode: 'date' | 'time', picked: Date): string {
  return format(picked, mode === 'date' ? 'yyyy-MM-dd' : 'HH:mm');
}

function displayValue(mode: 'date' | 'time', value: string): string {
  if (mode === 'date' && isValidDateString(value)) {
    return format(toPickerDate('date', value, undefined), 'EEE d MMM yyyy');
  }
  return value;
}

/** Date or time field that opens the platform picker (dialog on Android, inline on iOS). */
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
  suggestion,
}: DateTimeFieldProps) {
  const { colors, radii, spacing, minTouchTarget } = useTheme();
  const [open, setOpen] = useState(false);

  const openPicker = () => {
    if (disabled) return;
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: toPickerDate(mode, value, suggestion),
        mode,
        is24Hour: true,
        onValueChange: (_event, picked) => {
          onChange(fromPickerDate(mode, picked));
          onBlur?.();
        },
        onDismiss: () => onBlur?.(),
      });
      return;
    }
    setOpen((current) => !current);
  };

  const placeholder = mode === 'date' ? 'Choose a date' : 'Choose a time';
  const shown = displayValue(mode, value);
  const hint = error ?? helper;
  const canClear = optional && value !== '' && !disabled;

  return (
    <View style={{ alignSelf: 'stretch', gap: spacing.xs }}>
      <Text variant="label">{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
        <Pressable
          onPress={openPicker}
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${shown === '' ? 'not set' : shown}`}
          accessibilityHint={hint}
          accessibilityState={{ disabled, expanded: Platform.OS === 'ios' ? open : undefined }}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            minHeight: minTouchTarget + 6,
            borderRadius: radii.md,
            borderWidth: error ? 2 : 1,
            borderColor: error ? colors.danger : colors.borderStrong,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            backgroundColor: disabled
              ? colors.background
              : pressed
                ? colors.primarySoft
                : colors.surface,
          })}
        >
          <Icon name={mode === 'date' ? 'calendar' : 'clock'} size={20} color="textMuted" />
          <Text
            style={{ flex: 1 }}
            color={shown === '' || disabled ? 'textMuted' : 'text'}
            numberOfLines={1}
          >
            {shown === '' ? placeholder : shown}
          </Text>
        </Pressable>
        {canClear ? (
          <IconButton
            icon="close"
            accessibilityLabel={`Clear ${label}`}
            onPress={() => {
              setOpen(false);
              onChange('');
              onBlur?.();
            }}
          />
        ) : null}
      </View>

      {Platform.OS === 'ios' && open && !disabled ? (
        <View style={{ gap: spacing.sm }}>
          <DateTimePicker
            value={toPickerDate(mode, value, suggestion)}
            mode={mode}
            display={mode === 'date' ? 'inline' : 'spinner'}
            onValueChange={(_event, picked) => onChange(fromPickerDate(mode, picked))}
          />
          <Button
            label="Done"
            variant="secondary"
            size="sm"
            onPress={() => {
              // A spinner left on its starting value still counts as a choice.
              if (value === '') onChange(fromPickerDate(mode, toPickerDate(mode, value, suggestion)));
              setOpen(false);
              onBlur?.();
            }}
          />
        </View>
      ) : null}

      {error ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}
          accessibilityLiveRegion="polite"
        >
          <Icon name="alert" size={16} color="danger" />
          <Text variant="caption" color="danger" style={{ flex: 1 }}>
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
