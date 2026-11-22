import { describe, expect, it } from 'vitest';

import { attendanceListText } from './attendanceText';
import { entry } from './testFixtures';

describe('attendanceListText', () => {
  it('groups by status, sorts by name and marks walk-ins', () => {
    const text = attendanceListText({
      title: 'Tuesday run',
      when: 'Tue 3 Nov, 18:00 - 19:00',
      entries: [
        entry('1', 'Zed', { attendance_status: 'present' }),
        entry('2', 'Ana', { attendance_status: 'present' }),
        entry('3', 'Walker', { attendance_status: 'present', is_walk_in: true }),
        entry('4', 'Bo', { attendance_status: 'absent' }),
        entry('5', 'Cy'),
      ],
    });
    expect(text).toBe(
      [
        'Attendance: Tuesday run',
        'Tue 3 Nov, 18:00 - 19:00',
        'Present 3 · Absent 1 · Unrecorded 1 · of 4 who said going (+1 walk-in)',
        '',
        'Present (3)',
        '- Ana',
        '- Zed',
        '- Walker (walk-in)',
        '',
        'Absent (1)',
        '- Bo',
        '',
        'Not recorded (1)',
        '- Cy',
      ].join('\n'),
    );
  });

  it('omits empty groups and a missing title or time', () => {
    const text = attendanceListText({ title: null, when: null, entries: [entry('1', 'Ana', { attendance_status: 'absent' })] });
    expect(text.split('\n')).toEqual([
      'Attendance',
      'Present 0 · Absent 1 · Unrecorded 0 · of 1 who said going',
      '',
      'Absent (1)',
      '- Ana',
    ]);
  });

  it('handles an empty list', () => {
    expect(attendanceListText({ title: 'X', when: null, entries: [] })).toBe(
      'Attendance: X\nPresent 0 · Absent 0 · Unrecorded 0 · of 0 who said going',
    );
  });
});
