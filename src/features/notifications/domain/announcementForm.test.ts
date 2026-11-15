import { describe, expect, it } from 'vitest';

import {
  announcementFieldForServerError,
  announcementFormSchema,
  emptyAnnouncementForm,
  fromAnnouncement,
  toAnnouncementInput,
  type AnnouncementFormValues,
} from './announcementForm';

const ZONE = 'Europe/Bucharest';
// 10 Nov 2026 12:00 in Bucharest (UTC+2).
const NOW = new Date('2026-11-10T10:00:00Z');

function valid(overrides: Partial<AnnouncementFormValues> = {}): AnnouncementFormValues {
  return { ...emptyAnnouncementForm(), title: 'Route change', body: 'We meet at the north gate.', ...overrides };
}

function errorsOf(values: AnnouncementFormValues) {
  const result = announcementFormSchema({ timezone: ZONE, now: NOW }).safeParse(values);
  if (result.success) return {} as Record<string, string>;
  return Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
}

describe('announcementFormSchema', () => {
  it('accepts a publish-now announcement', () => {
    expect(errorsOf(valid())).toEqual({});
  });

  it('requires a title and a body, trimmed', () => {
    expect(errorsOf(valid({ title: '   ' })).title).toBeDefined();
    expect(errorsOf(valid({ body: '\n ' })).body).toBeDefined();
  });

  it('limits the title to 100 and the body to 2000 characters', () => {
    expect(errorsOf(valid({ title: 'a'.repeat(100) })).title).toBeUndefined();
    expect(errorsOf(valid({ title: 'a'.repeat(101) })).title).toBeDefined();
    expect(errorsOf(valid({ body: 'b'.repeat(2000) })).body).toBeUndefined();
    expect(errorsOf(valid({ body: 'b'.repeat(2001) })).body).toBeDefined();
  });

  it('counts characters, not UTF-16 units', () => {
    expect(errorsOf(valid({ title: '🐻'.repeat(100) })).title).toBeUndefined();
  });

  it('keeps the title on one line', () => {
    expect(errorsOf(valid({ title: 'a\nb' })).title).toBeDefined();
  });

  it('ignores date and time when publishing now', () => {
    expect(errorsOf(valid({ mode: 'now', date: 'garbage', time: 'x' }))).toEqual({});
  });

  describe('scheduling', () => {
    const schedule = (date: string, time: string) => valid({ mode: 'schedule', date, time });

    it('needs a valid date and time', () => {
      expect(errorsOf(schedule('', '')).date).toBeDefined();
      expect(errorsOf(schedule('', '')).time).toBeDefined();
      expect(errorsOf(schedule('2026-02-30', '10:00')).date).toBeDefined();
      expect(errorsOf(schedule('2026-11-12', '25:00')).time).toBeDefined();
    });

    it('must be in the future in the COMMUNITY zone, not the device zone', () => {
      // 13:59 Bucharest is 11:59Z: after NOW (10:00Z). 11:59 Bucharest is 09:59Z: before it.
      expect(errorsOf(schedule('2026-11-10', '13:00')).date).toBeUndefined();
      expect(errorsOf(schedule('2026-11-10', '11:59')).date).toMatch(/future/);
      expect(errorsOf(schedule('2026-11-10', '12:00')).date).toMatch(/future/);
    });

    it('allows at most 365 days ahead', () => {
      expect(errorsOf(schedule('2027-11-09', '10:00')).date).toBeUndefined();
      expect(errorsOf(schedule('2027-11-11', '10:00')).date).toMatch(/365/);
    });
  });
});

describe('toAnnouncementInput', () => {
  it('trims and sends null for publish now', () => {
    expect(toAnnouncementInput(valid({ title: ' Hi ', body: ' there ' }), ZONE)).toEqual({
      title: 'Hi',
      body: 'there',
      scheduledFor: null,
    });
  });

  it('converts the wall time in the community zone to UTC', () => {
    expect(
      toAnnouncementInput(valid({ mode: 'schedule', date: '2026-11-12', time: '09:30' }), ZONE)
        .scheduledFor,
    ).toBe('2026-11-12T07:30:00.000Z');
    // Summer time: UTC+3.
    expect(
      toAnnouncementInput(valid({ mode: 'schedule', date: '2027-07-01', time: '09:30' }), ZONE)
        .scheduledFor,
    ).toBe('2027-07-01T06:30:00.000Z');
  });
});

describe('fromAnnouncement', () => {
  it('shows the stored instant as wall time in the community zone', () => {
    expect(
      fromAnnouncement({ title: 'T', body: 'B', scheduled_for: '2026-11-12T07:30:00Z' }, ZONE),
    ).toEqual({ title: 'T', body: 'B', mode: 'schedule', date: '2026-11-12', time: '09:30' });
  });
});

describe('announcementFieldForServerError', () => {
  it('maps server fields to form fields', () => {
    expect(announcementFieldForServerError('scheduled_for')).toBe('date');
    expect(announcementFieldForServerError('title')).toBe('title');
    expect(announcementFieldForServerError('body')).toBe('body');
    expect(announcementFieldForServerError('other')).toBeNull();
    expect(announcementFieldForServerError(undefined)).toBeNull();
  });
});
