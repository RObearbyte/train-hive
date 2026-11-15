import { describe, expect, it } from 'vitest';

import { bodyPreview, publishedWhen, scheduledNote, sortManaged } from './presentation';
import { announcement } from './testFixtures';

describe('scheduledNote', () => {
  it('states the time and zone, in the community zone', () => {
    expect(scheduledNote({ scheduled_for: '2026-11-14T07:00:00Z' }, 'Europe/Bucharest')).toBe(
      'Will be published at Sat 14 Nov, 09:00 (Europe/Bucharest)',
    );
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(scheduledNote({ scheduled_for: '2026-11-14T07:00:00Z' }, 'Mars/Base')).toBe(
      'Will be published at Sat 14 Nov, 07:00 (UTC)',
    );
  });
});

describe('publishedWhen', () => {
  it('is relative to now in the zone', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(
      publishedWhen({ published_at: '2026-11-10T07:00:00Z' }, 'Europe/Bucharest', now),
    ).toBe('Today, 09:00');
    expect(publishedWhen({ published_at: null }, 'Europe/Bucharest', now)).toBe('');
  });
});

describe('bodyPreview', () => {
  it('flattens whitespace and truncates', () => {
    expect(bodyPreview('a\n\n  b')).toBe('a b');
    expect(bodyPreview('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('sortManaged', () => {
  it('lists scheduled soonest first, then cancelled newest first', () => {
    const list = [
      announcement({ id: 'c-old', status: 'cancelled', published_at: null, cancelled_at: '2026-11-01T00:00:00Z' }),
      announcement({ id: 's-late', status: 'scheduled', published_at: null, scheduled_for: '2026-12-01T00:00:00Z' }),
      announcement({ id: 'c-new', status: 'cancelled', published_at: null, cancelled_at: '2026-11-05T00:00:00Z' }),
      announcement({ id: 's-soon', status: 'scheduled', published_at: null, scheduled_for: '2026-11-20T00:00:00Z' }),
    ];
    expect(sortManaged(list).map((a) => a.id)).toEqual(['s-soon', 's-late', 'c-new', 'c-old']);
  });
});
