export interface DateTimeFieldProps {
  label: string;
  mode: 'date' | 'time';
  /** `yyyy-MM-dd` for a date, 24-hour `HH:mm` for a time, '' when empty. A wall-clock value: no time zone is applied here. */
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  helper?: string;
  disabled?: boolean;
  /** Optional fields can be cleared. */
  optional?: boolean;
  /** Where the picker opens when the field is empty (same format as `value`). */
  suggestion?: string;
}
