import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  calendarDaysFromNow,
  defaultRsvpDeadline,
  deviceTimeZone,
  formatDateTime,
  formatDateTimeRange,
  formatLongDate,
  formatSessionWhen,
  formatShortDate,
  formatTime,
  formatWeekdayTime,
  hasPassed,
  isValidDateString,
  isValidTimeString,
  isValidTimeZone,
  relativeDayLabel,
  utcToWallTime,
  wallTimeToUtc,
  zoneCityName,
  zonesDifferAt,
} from '@/lib/datetime';

const BUCHAREST = 'Europe/Bucharest';
const TOKYO = 'Asia/Tokyo';
const NEW_YORK = 'America/New_York';

// Saturday 14 November 2026, 09:00 in Bucharest (EET, UTC+2).
const SAT_0900 = '2026-11-14T07:00:00.000Z';

describe('isValidTimeZone', () => {
  it('accepts IANA names', () => {
    expect(isValidTimeZone(BUCHAREST)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidTimeZone('Europe/Bucuresti')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(' Europe/Bucharest ')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(120)).toBe(false);
  });
});

describe('date and time string checks', () => {
  it('validates calendar dates', () => {
    expect(isValidDateString('2026-11-14')).toBe(true);
    expect(isValidDateString('2028-02-29')).toBe(true);
    expect(isValidDateString('2026-02-29')).toBe(false);
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('2026-1-5')).toBe(false);
    expect(isValidDateString('14/11/2026')).toBe(false);
    expect(isValidDateString('')).toBe(false);
  });

  it('validates 24-hour times', () => {
    expect(isValidTimeString('00:00')).toBe(true);
    expect(isValidTimeString('23:59')).toBe(true);
    expect(isValidTimeString('24:00')).toBe(false);
    expect(isValidTimeString('9:00')).toBe(false);
    expect(isValidTimeString('09:60')).toBe(false);
    expect(isValidTimeString('')).toBe(false);
  });
});

describe('wallTimeToUtc / utcToWallTime', () => {
  it('converts winter and summer times in Bucharest', () => {
    expect(wallTimeToUtc('2026-11-14', '09:00', BUCHAREST)).toBe(SAT_0900); // EET, +2
    expect(wallTimeToUtc('2026-07-15', '09:00', BUCHAREST)).toBe('2026-07-15T06:00:00.000Z'); // EEST, +3
  });

  it('converts in zones on both sides of UTC, including a date change', () => {
    expect(wallTimeToUtc('2026-11-14', '09:00', TOKYO)).toBe('2026-11-14T00:00:00.000Z');
    expect(wallTimeToUtc('2026-11-14', '06:00', TOKYO)).toBe('2026-11-13T21:00:00.000Z');
    expect(wallTimeToUtc('2026-11-14', '21:00', NEW_YORK)).toBe('2026-11-15T02:00:00.000Z');
    expect(wallTimeToUtc('2026-11-14', '09:00', 'UTC')).toBe('2026-11-14T09:00:00.000Z');
    expect(wallTimeToUtc('2026-11-14', '09:00', 'Asia/Kolkata')).toBe('2026-11-14T03:30:00.000Z');
  });

  it('reads an instant back in the given zone', () => {
    expect(utcToWallTime(SAT_0900, BUCHAREST)).toEqual({ date: '2026-11-14', time: '09:00' });
    expect(utcToWallTime(SAT_0900, TOKYO)).toEqual({ date: '2026-11-14', time: '16:00' });
    expect(utcToWallTime(SAT_0900, NEW_YORK)).toEqual({ date: '2026-11-14', time: '02:00' });
    expect(utcToWallTime('2026-11-14T22:30:00Z', BUCHAREST)).toEqual({
      date: '2026-11-15',
      time: '00:30',
    });
  });

  it('accepts the +00:00 form Postgres returns and Date objects', () => {
    expect(utcToWallTime('2026-11-14T07:00:00+00:00', BUCHAREST).time).toBe('09:00');
    expect(utcToWallTime(new Date(SAT_0900), BUCHAREST).time).toBe('09:00');
  });

  it('throws on malformed input instead of guessing', () => {
    expect(() => wallTimeToUtc('2026-02-30', '09:00', BUCHAREST)).toThrow(RangeError);
    expect(() => wallTimeToUtc('2026-11-14', '25:00', BUCHAREST)).toThrow(RangeError);
    expect(() => wallTimeToUtc('2026-11-14', '09:00', 'Nope/Zone')).toThrow(RangeError);
    expect(() => utcToWallTime('not a date', BUCHAREST)).toThrow(RangeError);
    expect(() => utcToWallTime(SAT_0900, 'Nope/Zone')).toThrow(RangeError);
  });

  describe('Europe/Bucharest spring forward (29 March 2026, 03:00 → 04:00)', () => {
    it('converts times just before and after the gap', () => {
      expect(wallTimeToUtc('2026-03-29', '02:59', BUCHAREST)).toBe('2026-03-29T00:59:00.000Z');
      expect(wallTimeToUtc('2026-03-29', '04:00', BUCHAREST)).toBe('2026-03-29T01:00:00.000Z');
      expect(wallTimeToUtc('2026-03-29', '09:00', BUCHAREST)).toBe('2026-03-29T06:00:00.000Z');
      expect(wallTimeToUtc('2026-03-28', '09:00', BUCHAREST)).toBe('2026-03-28T07:00:00.000Z');
    });

    it('moves a skipped time forward past the gap', () => {
      const utc = wallTimeToUtc('2026-03-29', '03:30', BUCHAREST);
      expect(utc).toBe('2026-03-29T01:30:00.000Z');
      expect(utcToWallTime(utc, BUCHAREST)).toEqual({ date: '2026-03-29', time: '04:30' });
    });

    it('reads instants on both sides of the change', () => {
      expect(utcToWallTime('2026-03-29T00:59:00Z', BUCHAREST).time).toBe('02:59');
      expect(utcToWallTime('2026-03-29T01:00:00Z', BUCHAREST).time).toBe('04:00');
    });
  });

  describe('Europe/Bucharest fall back (25 October 2026, 04:00 → 03:00)', () => {
    it('converts times before and after the repeated hour', () => {
      expect(wallTimeToUtc('2026-10-25', '02:30', BUCHAREST)).toBe('2026-10-24T23:30:00.000Z');
      expect(wallTimeToUtc('2026-10-25', '04:30', BUCHAREST)).toBe('2026-10-25T02:30:00.000Z');
      expect(wallTimeToUtc('2026-10-25', '09:00', BUCHAREST)).toBe('2026-10-25T07:00:00.000Z');
      expect(wallTimeToUtc('2026-10-24', '09:00', BUCHAREST)).toBe('2026-10-24T06:00:00.000Z');
    });

    it('resolves a repeated time to its first occurrence', () => {
      expect(wallTimeToUtc('2026-10-25', '03:30', BUCHAREST)).toBe('2026-10-25T00:30:00.000Z');
    });

    it('shows the same wall time for both occurrences', () => {
      expect(utcToWallTime('2026-10-25T00:30:00Z', BUCHAREST).time).toBe('03:30');
      expect(utcToWallTime('2026-10-25T01:30:00Z', BUCHAREST).time).toBe('03:30');
    });
  });

  it('handles DST in the southern hemisphere and in New York', () => {
    // Sydney: clocks go forward on 4 October 2026, 02:00 → 03:00.
    expect(wallTimeToUtc('2026-10-04', '09:00', 'Australia/Sydney')).toBe(
      '2026-10-03T22:00:00.000Z',
    );
    expect(wallTimeToUtc('2026-10-03', '09:00', 'Australia/Sydney')).toBe(
      '2026-10-02T23:00:00.000Z',
    );
    // New York: clocks go back on 1 November 2026.
    expect(wallTimeToUtc('2026-10-31', '09:00', NEW_YORK)).toBe('2026-10-31T13:00:00.000Z');
    expect(wallTimeToUtc('2026-11-01', '09:00', NEW_YORK)).toBe('2026-11-01T14:00:00.000Z');
  });

  it('round-trips every half hour across a whole year, except skipped times', () => {
    const start = Date.UTC(2026, 0, 1);
    for (let step = 0; step < 365 * 48; step += 1) {
      const instant = new Date(start + step * 30 * 60_000);
      const wall = utcToWallTime(instant, BUCHAREST);
      const back = wallTimeToUtc(wall.date, wall.time, BUCHAREST);
      const diffMinutes = (new Date(back).getTime() - instant.getTime()) / 60_000;
      // Only the second pass through the repeated hour maps to the first one.
      const inRepeatedHour = wall.date === '2026-10-25' && wall.time.startsWith('03:');
      expect([wall, diffMinutes]).toEqual([wall, inRepeatedHour && diffMinutes !== 0 ? -60 : 0]);
    }
  });
});

describe('defaultRsvpDeadline', () => {
  it('is exactly two hours before the start', () => {
    expect(defaultRsvpDeadline(SAT_0900)).toBe('2026-11-14T05:00:00.000Z');
    expect(defaultRsvpDeadline(new Date(SAT_0900))).toBe('2026-11-14T05:00:00.000Z');
    expect(defaultRsvpDeadline('2026-11-14T07:00:00+00:00')).toBe('2026-11-14T05:00:00.000Z');
  });

  it('stays two real hours across spring forward (three hours on the clock)', () => {
    const start = wallTimeToUtc('2026-03-29', '04:30', BUCHAREST);
    const deadline = defaultRsvpDeadline(start);
    expect(new Date(start).getTime() - new Date(deadline).getTime()).toBe(2 * 3_600_000);
    expect(utcToWallTime(deadline, BUCHAREST)).toEqual({ date: '2026-03-29', time: '01:30' });
  });

  it('stays two real hours across fall back (one hour on the clock)', () => {
    const start = wallTimeToUtc('2026-10-25', '04:30', BUCHAREST);
    const deadline = defaultRsvpDeadline(start);
    expect(new Date(start).getTime() - new Date(deadline).getTime()).toBe(2 * 3_600_000);
    expect(utcToWallTime(deadline, BUCHAREST)).toEqual({ date: '2026-10-25', time: '03:30' });
  });

  it('throws on an invalid start', () => {
    expect(() => defaultRsvpDeadline('nope')).toThrow(RangeError);
  });
});

describe('formatting in the session zone', () => {
  it('formats the pieces', () => {
    expect(formatTime(SAT_0900, BUCHAREST)).toBe('09:00');
    expect(formatWeekdayTime(SAT_0900, BUCHAREST)).toBe('Saturday, 09:00');
    expect(formatShortDate(SAT_0900, BUCHAREST)).toBe('Sat 14 Nov');
    expect(formatLongDate(SAT_0900, BUCHAREST)).toBe('Saturday 14 November 2026');
    expect(formatDateTime(SAT_0900, BUCHAREST)).toBe('Sat 14 Nov, 09:00');
  });

  it('uses the zone it is given, not a fixed one', () => {
    expect(formatWeekdayTime(SAT_0900, TOKYO)).toBe('Saturday, 16:00');
    expect(formatDateTime(SAT_0900, NEW_YORK)).toBe('Sat 14 Nov, 02:00');
    expect(formatDateTime('2026-11-14T22:30:00Z', BUCHAREST)).toBe('Sun 15 Nov, 00:30');
    expect(formatDateTime('2026-11-14T03:00:00Z', NEW_YORK)).toBe('Fri 13 Nov, 22:00');
  });

  it('formats a same-day range', () => {
    expect(formatDateTimeRange(SAT_0900, '2026-11-14T08:30:00Z', BUCHAREST)).toBe(
      'Sat 14 Nov, 09:00–10:30',
    );
  });

  it('formats a range without an end', () => {
    expect(formatDateTimeRange(SAT_0900, null, BUCHAREST)).toBe('Sat 14 Nov, 09:00');
    expect(formatDateTimeRange(SAT_0900, undefined, BUCHAREST)).toBe('Sat 14 Nov, 09:00');
  });

  it('formats a range that ends on another day in the session zone', () => {
    expect(
      formatDateTimeRange('2026-11-14T21:00:00Z', '2026-11-14T23:00:00Z', BUCHAREST),
    ).toBe('Sat 14 Nov, 23:00 – Sun 15 Nov, 01:00');
    // The same instants are a same-day range in UTC.
    expect(formatDateTimeRange('2026-11-14T21:00:00Z', '2026-11-14T23:00:00Z', 'UTC')).toBe(
      'Sat 14 Nov, 21:00–23:00',
    );
  });

  it('formats a range across the spring-forward change', () => {
    expect(
      formatDateTimeRange('2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z', BUCHAREST),
    ).toBe('Sun 29 Mar, 02:30–04:30');
  });
});

describe('relative days are computed in the session zone', () => {
  it('labels today, tomorrow and yesterday', () => {
    const now = new Date('2026-11-14T05:00:00Z'); // Sat 07:00 in Bucharest
    expect(relativeDayLabel(SAT_0900, BUCHAREST, now)).toBe('Today');
    expect(relativeDayLabel('2026-11-15T07:00:00Z', BUCHAREST, now)).toBe('Tomorrow');
    expect(relativeDayLabel('2026-11-13T07:00:00Z', BUCHAREST, now)).toBe('Yesterday');
    expect(relativeDayLabel('2026-11-16T07:00:00Z', BUCHAREST, now)).toBeNull();
    expect(relativeDayLabel('2026-11-12T07:00:00Z', BUCHAREST, now)).toBeNull();
  });

  it('gives different answers for the same instants in different zones', () => {
    // 00:30 on Saturday in Bucharest, still Friday in UTC and New York.
    const now = new Date('2026-11-13T22:30:00Z');
    expect(relativeDayLabel(SAT_0900, BUCHAREST, now)).toBe('Today');
    expect(relativeDayLabel(SAT_0900, 'UTC', now)).toBe('Tomorrow');
    expect(relativeDayLabel(SAT_0900, NEW_YORK, now)).toBe('Tomorrow');
    // Already Saturday morning in Tokyo.
    expect(relativeDayLabel(SAT_0900, TOKYO, now)).toBe('Today');
  });

  it('flips exactly at local midnight', () => {
    const sunday = '2026-11-15T07:00:00Z';
    expect(relativeDayLabel(sunday, BUCHAREST, new Date('2026-11-14T21:59:59Z'))).toBe('Tomorrow');
    expect(relativeDayLabel(sunday, BUCHAREST, new Date('2026-11-14T22:00:00Z'))).toBe('Today');
  });

  it('counts calendar days across DST changes (23 and 25 hour days)', () => {
    // Spring forward: 28 March 23:30 local → 29 March 23:30 local is 23 real hours.
    expect(
      calendarDaysFromNow('2026-03-29T20:30:00Z', BUCHAREST, new Date('2026-03-28T21:30:00Z')),
    ).toBe(1);
    // Fall back: 25 October 00:10 local → 26 October 00:10 local is 25 real hours.
    expect(
      calendarDaysFromNow('2026-10-25T22:10:00Z', BUCHAREST, new Date('2026-10-24T21:10:00Z')),
    ).toBe(1);
    // 23:50 on the 25-hour day is still the same day as 00:10.
    expect(
      calendarDaysFromNow('2026-10-25T21:50:00Z', BUCHAREST, new Date('2026-10-24T21:10:00Z')),
    ).toBe(0);
    expect(
      calendarDaysFromNow('2026-11-07T07:00:00Z', BUCHAREST, new Date('2026-11-14T07:00:00Z')),
    ).toBe(-7);
  });

  it('formats "when" relative to now', () => {
    const monday = new Date('2026-11-09T10:00:00Z');
    expect(formatSessionWhen('2026-11-09T16:00:00Z', BUCHAREST, monday)).toBe('Today, 18:00');
    expect(formatSessionWhen('2026-11-10T07:00:00Z', BUCHAREST, monday)).toBe('Tomorrow, 09:00');
    expect(formatSessionWhen('2026-11-08T07:00:00Z', BUCHAREST, monday)).toBe('Yesterday, 09:00');
    expect(formatSessionWhen('2026-11-11T07:00:00Z', BUCHAREST, monday)).toBe('Wednesday, 09:00');
    expect(formatSessionWhen(SAT_0900, BUCHAREST, monday)).toBe('Saturday, 09:00');
    expect(formatSessionWhen('2026-11-15T07:00:00Z', BUCHAREST, monday)).toBe('Sunday, 09:00');
    // A week or more ahead, or in the past: full date so the weekday is not ambiguous.
    expect(formatSessionWhen('2026-11-16T07:00:00Z', BUCHAREST, monday)).toBe('Mon 16 Nov, 09:00');
    expect(formatSessionWhen('2026-11-07T07:00:00Z', BUCHAREST, monday)).toBe('Sat 7 Nov, 09:00');
    expect(formatSessionWhen('2027-01-09T07:00:00Z', BUCHAREST, monday)).toBe(
      'Sat 9 Jan 2027, 09:00',
    );
  });

  it('formats "when" in the session zone when it differs from where now was read', () => {
    const now = new Date('2026-11-13T22:30:00Z');
    expect(formatSessionWhen(SAT_0900, BUCHAREST, now)).toBe('Today, 09:00');
    expect(formatSessionWhen(SAT_0900, NEW_YORK, now)).toBe('Tomorrow, 02:00');
  });
});

describe('hasPassed', () => {
  it('is true at and after the instant', () => {
    expect(hasPassed(SAT_0900, new Date('2026-11-14T06:59:59.999Z'))).toBe(false);
    expect(hasPassed(SAT_0900, new Date(SAT_0900))).toBe(true);
    expect(hasPassed(SAT_0900, new Date('2026-11-14T07:00:00.001Z'))).toBe(true);
  });
});

// The device zone must never leak into results. Node re-reads TZ when it changes.
describe.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Europe/Bucharest', 'Pacific/Auckland'])(
  'with the device in %s',
  (deviceZone) => {
    const originalTz = process.env.TZ;

    beforeAll(() => {
      process.env.TZ = deviceZone;
    });

    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('really runs in that device zone', () => {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(deviceZone);
    });

    it('gives the same results for the session zone', () => {
      expect(wallTimeToUtc('2026-11-14', '09:00', BUCHAREST)).toBe(SAT_0900);
      expect(wallTimeToUtc('2026-03-29', '03:30', BUCHAREST)).toBe('2026-03-29T01:30:00.000Z');
      expect(wallTimeToUtc('2026-10-25', '03:30', BUCHAREST)).toBe('2026-10-25T00:30:00.000Z');
      expect(wallTimeToUtc('2026-11-14', '09:00', TOKYO)).toBe('2026-11-14T00:00:00.000Z');
      expect(utcToWallTime(SAT_0900, BUCHAREST)).toEqual({ date: '2026-11-14', time: '09:00' });
      expect(utcToWallTime(SAT_0900, NEW_YORK)).toEqual({ date: '2026-11-14', time: '02:00' });
      expect(formatWeekdayTime(SAT_0900, BUCHAREST)).toBe('Saturday, 09:00');
      expect(formatDateTimeRange(SAT_0900, '2026-11-14T08:30:00Z', BUCHAREST)).toBe(
        'Sat 14 Nov, 09:00–10:30',
      );
      expect(formatDateTime('2026-11-14T22:30:00Z', BUCHAREST)).toBe('Sun 15 Nov, 00:30');
      expect(relativeDayLabel(SAT_0900, BUCHAREST, new Date('2026-11-13T22:30:00Z'))).toBe('Today');
      expect(relativeDayLabel(SAT_0900, NEW_YORK, new Date('2026-11-13T22:30:00Z'))).toBe(
        'Tomorrow',
      );
      expect(formatSessionWhen(SAT_0900, BUCHAREST, new Date('2026-11-09T10:00:00Z'))).toBe(
        'Saturday, 09:00',
      );
    });
  },
);

describe('zone comparison', () => {
  it('compares by offset at that instant, not by name', () => {
    expect(zonesDifferAt(SAT_0900, BUCHAREST, 'Europe/Athens')).toBe(false);
    expect(zonesDifferAt(SAT_0900, BUCHAREST, BUCHAREST)).toBe(false);
    expect(zonesDifferAt(SAT_0900, BUCHAREST, 'Europe/Berlin')).toBe(true);
    expect(zonesDifferAt(SAT_0900, BUCHAREST, TOKYO)).toBe(true);
  });

  it('follows DST: Bucharest and Johannesburg only match for part of the year', () => {
    // Winter: both UTC+2.
    expect(zonesDifferAt('2026-01-15T12:00:00Z', BUCHAREST, 'Africa/Johannesburg')).toBe(false);
    // Summer: Bucharest is UTC+3, Johannesburg stays UTC+2.
    expect(zonesDifferAt('2026-07-15T12:00:00Z', BUCHAREST, 'Africa/Johannesburg')).toBe(true);
  });

  it('throws on an invalid zone', () => {
    expect(() => zonesDifferAt(SAT_0900, BUCHAREST, 'Nope/Zone')).toThrow(RangeError);
  });

  it('names a zone by its city', () => {
    expect(zoneCityName(BUCHAREST)).toBe('Bucharest');
    expect(zoneCityName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneCityName('UTC')).toBe('UTC');
  });

  it('reports the device zone as a valid zone or null', () => {
    const zone = deviceTimeZone();
    expect(zone === null || isValidTimeZone(zone)).toBe(true);
  });
});
