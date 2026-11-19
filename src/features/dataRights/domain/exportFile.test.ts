import { describe, expect, it } from 'vitest';

import type { MyDataExport } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';

import {
  exportErrorMessage,
  exportFileName,
  exportSuccessMessage,
  exportTruncatedWarning,
  parseExport,
  serializeExport,
  summarizeExport,
} from './exportFile';

function payload(overrides: Record<string, unknown> = {}): MyDataExport {
  return {
    format_version: 1,
    generated_at: '2026-11-20T08:15:00.123+00:00',
    README: 'readme',
    account: { user_id: 'u1', created_at: '2026-01-01T00:00:00Z', is_anonymous: true },
    profile: { display_name: 'Ana', created_at: '', updated_at: '' },
    memberships: [{}, {}],
    rsvps: [{}],
    attendance: [],
    attendance_changes: [],
    consents: [{}, {}, {}],
    notifications: [],
    push_devices: [],
    authored: { announcements: [], events_organized: [{}], invitation_codes: [] },
    truncated: { memberships: false, rsvps: false },
    ...overrides,
  } as unknown as MyDataExport;
}

describe('exportFileName', () => {
  it('uses the server date (UTC date part)', () => {
    expect(exportFileName('2026-11-20T23:59:59Z')).toBe('trainhive-data-2026-11-20.json');
    expect(exportFileName('2026-11-20')).toBe('trainhive-data-2026-11-20.json');
    expect(exportFileName('2026-11-20 08:15:00+00')).toBe('trainhive-data-2026-11-20.json');
  });

  it('has a plain name when the server date is missing or malformed (the device clock is never read)', () => {
    for (const value of [undefined, null, '', 'yesterday', '20261120']) {
      expect(exportFileName(value)).toBe('trainhive-data.json');
    }
  });

  it('never contains path separators', () => {
    expect(exportFileName('../../etc/passwd')).toBe('trainhive-data.json');
    expect(exportFileName('2026-11-20/../x')).toBe('trainhive-data.json');
  });
});

describe('serializeExport', () => {
  it('pretty-prints and round-trips', () => {
    const text = serializeExport(payload());
    expect(text).toContain('\n  "format_version": 1');
    expect(JSON.parse(text)).toEqual(payload());
  });
});

describe('parseExport', () => {
  it('accepts an export and refuses anything else', () => {
    expect(parseExport(payload()).format_version).toBe(1);
    expect(() => parseExport(null)).toThrow();
    expect(() => parseExport({ format_version: 2, account: {} })).toThrow();
    expect(() => parseExport({ format_version: 1 })).toThrow();
  });
});

describe('summary', () => {
  it('counts only the non-zero sections, singular and plural', () => {
    const summary = summarizeExport(payload());
    expect(summary.parts).toEqual([
      '2 community memberships',
      '1 RSVP',
      '3 agreement records',
      '1 event you organized',
    ]);
    expect(summary.truncated).toEqual([]);
  });

  it('writes the success message with the privacy reminder', () => {
    const text = exportSuccessMessage(summarizeExport(payload()));
    expect(text).toBe(
      'Your data was prepared. It contains your account details, 2 community memberships, 1 RSVP, 3 agreement records and 1 event you organized. Keep the file private: it holds your personal data.',
    );
  });

  it('still reads well for an empty export', () => {
    const empty = payload({ memberships: [], rsvps: [], consents: [], authored: {} });
    expect(exportSuccessMessage(summarizeExport(empty))).toContain('It contains your account details.');
  });

  it('tolerates missing sections', () => {
    const summary = summarizeExport({ format_version: 1, account: {} } as unknown as MyDataExport);
    expect(summary).toEqual({ parts: [], truncated: [] });
  });

  it('warns about truncated lists, and only then', () => {
    const none = summarizeExport(payload());
    expect(exportTruncatedWarning(none)).toBeNull();
    const cut = summarizeExport(payload({ truncated: { rsvps: true, notifications: true, memberships: false } }));
    expect(cut.truncated).toEqual(['RSVPs', 'notifications']);
    expect(exportTruncatedWarning(cut)).toContain('RSVPs and notifications');
  });
});

describe('exportErrorMessage', () => {
  const raised = (message: string) => toAppError({ code: 'P0001', message });

  it('explains the rate limit with the real number', () => {
    expect(exportErrorMessage(raised('rate_limited'))).toContain('up to 10 times per hour');
  });

  it('uses the shared texts for the rest', () => {
    expect(exportErrorMessage(new Error('Network request failed'))).toMatch(/no connection/i);
    expect(exportErrorMessage(raised('not_authenticated'))).toMatch(/session has ended/i);
    expect(exportErrorMessage(new Error('boom'))).toMatch(/something went wrong/i);
  });
});
