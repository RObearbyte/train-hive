import { TextField } from '@/ui';

import type { DateTimeFieldProps } from './DateTimeField.types';

/**
 * Web fallback: the native date-time picker has no web implementation, so the
 * value is typed and checked by the form schema. Android and iOS use
 * `DateTimeField.native.tsx`.
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
  const format = mode === 'date' ? 'YYYY-MM-DD' : 'HH:MM, 24-hour';
  const hint = optional ? `${format}. Optional` : format;
  return (
    <TextField
      label={label}
      value={value}
      onChangeText={onChange}
      onBlur={onBlur}
      error={error}
      helper={helper ? `${helper} (${format})` : hint}
      editable={!disabled}
      placeholder={mode === 'date' ? '2026-11-14' : '18:30'}
      inputMode="numeric"
      autoCorrect={false}
      autoCapitalize="none"
      maxLength={mode === 'date' ? 10 : 5}
    />
  );
}
