import type { AttendanceSheetEntry } from '@/lib/database.types';

/** A sheet entry for tests: a member who said going and has no record yet. */
export function entry(
  id: string,
  name: string,
  overrides: Partial<AttendanceSheetEntry> = {},
): AttendanceSheetEntry {
  return {
    user_id: id,
    display_name: name,
    membership_status: 'active',
    rsvp_response: 'going',
    attendance_status: 'unrecorded',
    has_record: false,
    is_walk_in: false,
    had_rsvp_going: null,
    updated_at: null,
    ...overrides,
  };
}
