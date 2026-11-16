import { describe, expect, it } from 'vitest';

import type { MyCommunity } from '@/lib/database.types';

import {
  COMMUNITY_NAME_MAX,
  collapseWhitespace,
  communitySettingsFormSchema,
  createCommunityFormSchema,
  isCommunityTimeZone,
} from './communityForm';
import { isCreatorCodeProblem, mapCreatorError } from './creatorErrors';
import { createRequestIdTracker } from './requestId';
import { buildSwitcherItems, canSwitchCommunity, communityTitle } from './switcher';
import {
  FALLBACK_TIME_ZONES,
  defaultTimeZone,
  listTimeZones,
  localTimeIn,
  localTimeSummary,
  searchTimeZones,
  utcOffsetLabel,
  zoneLabel,
} from './timezones';

describe('request id lifecycle', () => {
  const values = { code: 'ABCD2345', name: 'Pack', timezone: 'Europe/Bucharest', displayName: 'Alex' };

  function tracker() {
    let n = 0;
    return createRequestIdTracker(() => `id-${++n}`);
  }

  it('reuses the id when the same submission is retried', () => {
    const t = tracker();
    const first = t.idFor(values);
    expect(t.idFor({ ...values })).toBe(first);
    expect(t.idFor({ ...values })).toBe(first);
  });

  it('makes a new id when any field is edited after an attempt', () => {
    const t = tracker();
    const first = t.idFor(values);
    for (const edit of [{ name: 'Pack 2' }, { timezone: 'UTC' }, { displayName: 'Sam' }, { code: 'ZZZZ2345' }]) {
      expect(t.idFor({ ...values, ...edit })).not.toBe(first);
    }
  });

  it('starts fresh after a success', () => {
    const t = tracker();
    const first = t.idFor(values);
    t.reset();
    expect(t.idFor(values)).not.toBe(first);
  });
});

describe('creator flow error mapping', () => {
  it('puts every code problem on the code field and offers another code', () => {
    for (const code of ['invalid_code', 'expired', 'revoked', 'exhausted']) {
      const view = mapCreatorError({ code });
      expect(view.target).toBe('code');
      expect(view.codeProblem).toBe(true);
      expect(isCreatorCodeProblem(code)).toBe(true);
    }
    expect(mapCreatorError({ code: 'expired' }).message).toMatch(/expired/);
    expect(mapCreatorError({ code: 'exhausted' }).message).toMatch(/already been used/);
  });

  it('tells the user to wait 15 minutes when rate limited, as a warning banner', () => {
    const view = mapCreatorError({ code: 'rate_limited' });
    expect(view).toMatchObject({ target: 'banner', tone: 'warning', codeProblem: false });
    expect(view.message).toMatch(/15 minutes/);
  });

  it('maps validation failures onto their fields', () => {
    expect(mapCreatorError({ code: 'validation_failed', field: 'name' }).target).toBe('name');
    expect(mapCreatorError({ code: 'validation_failed', field: 'timezone' }).target).toBe('timezone');
    expect(mapCreatorError({ code: 'validation_failed', field: 'display_name' }).target).toBe('displayName');
  });

  it('shows the limit, network, auth, request id and unknown failures in a banner', () => {
    for (const error of [
      { code: 'community_limit_reached' },
      { code: 'network_error' },
      { code: 'not_authenticated' },
      { code: 'validation_failed', field: 'request_id' },
      { code: 'unknown' },
    ]) {
      const view = mapCreatorError(error);
      expect(view.target).toBe('banner');
      expect(view.codeProblem).toBe(false);
      expect(view.message.length).toBeGreaterThan(10);
    }
    expect(mapCreatorError({ code: 'community_limit_reached' }).message).toMatch(/maximum number of communities/);
    expect(mapCreatorError({ code: 'network_error' }).message).toMatch(/No connection/);
  });
});

describe('community form schemas', () => {
  it('accepts a good form and collapses whitespace in the name', () => {
    const parsed = createCommunityFormSchema.parse({
      name: '  Făget   Trail  Pack ',
      timezone: 'Europe/Bucharest',
      displayName: ' Alex ',
    });
    expect(parsed).toEqual({ name: 'Făget Trail Pack', timezone: 'Europe/Bucharest', displayName: 'Alex' });
  });

  it('rejects an empty or too long name (80 characters, counted as code points)', () => {
    const base = { timezone: 'UTC', displayName: 'Alex' };
    expect(createCommunityFormSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(createCommunityFormSchema.safeParse({ ...base, name: 'a'.repeat(COMMUNITY_NAME_MAX) }).success).toBe(true);
    expect(createCommunityFormSchema.safeParse({ ...base, name: 'a'.repeat(COMMUNITY_NAME_MAX + 1) }).success).toBe(false);
    expect(createCommunityFormSchema.safeParse({ ...base, name: '🐻'.repeat(COMMUNITY_NAME_MAX) }).success).toBe(true);
  });

  it('reuses the display name rule (2 to 40)', () => {
    const base = { name: 'Pack', timezone: 'UTC' };
    expect(createCommunityFormSchema.safeParse({ ...base, displayName: 'A' }).success).toBe(false);
    expect(createCommunityFormSchema.safeParse({ ...base, displayName: 'x'.repeat(41) }).success).toBe(false);
  });

  it('accepts only UTC or Area/Location zones', () => {
    expect(isCommunityTimeZone('UTC')).toBe(true);
    expect(isCommunityTimeZone('Europe/Bucharest')).toBe(true);
    expect(isCommunityTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    for (const bad of ['EST', 'Mars/Base', 'posix/Europe/Paris', 'Factory', '', ' UTC', null]) {
      expect(isCommunityTimeZone(bad)).toBe(false);
    }
  });

  it('the settings form is the same name and time zone rules', () => {
    expect(communitySettingsFormSchema.safeParse({ name: 'Pack', timezone: 'UTC' }).success).toBe(true);
    expect(communitySettingsFormSchema.safeParse({ name: '', timezone: 'UTC' }).success).toBe(false);
    expect(communitySettingsFormSchema.safeParse({ name: 'Pack', timezone: 'EST' }).success).toBe(false);
    expect(collapseWhitespace(' a \n\t b ')).toBe('a b');
  });
});

describe('time zones', () => {
  it('uses the runtime list when available, filtered to zones the server accepts, plus UTC', () => {
    const zones = listTimeZones(() => ['Europe/Paris', 'EST', 'Etc/GMT+5', 'Asia/Tokyo', 'Mars/Base'], null);
    expect(zones).toEqual(['Asia/Tokyo', 'Europe/Paris', 'UTC']);
  });

  it('falls back to the built-in list when the runtime has none or throws', () => {
    expect(listTimeZones(() => undefined, null)).toEqual([...new Set(FALLBACK_TIME_ZONES)].sort((a, b) => a.localeCompare(b, 'en')));
    expect(
      listTimeZones(() => {
        throw new RangeError('no');
      }, null).length,
    ).toBeGreaterThan(50);
    expect(listTimeZones(() => [], null)).toContain('Europe/Bucharest');
  });

  it('every built-in zone is valid here and acceptable to the server rules', () => {
    for (const zone of FALLBACK_TIME_ZONES) expect(isCommunityTimeZone(zone)).toBe(true);
  });

  it('includes the device zone so the default is always selectable', () => {
    expect(listTimeZones(() => ['Europe/Paris'], 'Asia/Kolkata')).toContain('Asia/Kolkata');
    expect(defaultTimeZone('Europe/Bucharest')).toBe('Europe/Bucharest');
    expect(defaultTimeZone(null)).toBe('UTC');
    expect(defaultTimeZone('EST')).toBe('UTC');
  });

  const zones = ['America/New_York', 'Europe/London', 'America/Argentina/Buenos_Aires', 'Europe/Bucharest', 'Asia/Kolkata', 'UTC'];

  it('searches by city, region and several words, case-insensitively', () => {
    expect(searchTimeZones(zones, 'new york')).toEqual(['America/New_York']);
    expect(searchTimeZones(zones, 'BUCH')).toEqual(['Europe/Bucharest']);
    expect(searchTimeZones(zones, 'america')).toEqual(['America/New_York', 'America/Argentina/Buenos_Aires']);
    expect(searchTimeZones(zones, 'europe lon')).toEqual(['Europe/London']);
    expect(searchTimeZones(zones, 'nowhere')).toEqual([]);
  });

  it('returns everything for an empty query and puts city prefix matches first', () => {
    expect(searchTimeZones(zones, '  ')).toEqual(zones);
    expect(searchTimeZones(['America/Kentucky/Louisville', 'Europe/Kyiv', 'Asia/Kolkata'], 'ky')).toEqual([
      'Europe/Kyiv',
      'America/Kentucky/Louisville',
    ]);
  });

  it('formats labels and the local time in the zone at a given instant', () => {
    const winter = new Date('2026-01-15T10:30:00Z');
    const summer = new Date('2026-07-15T10:30:00Z');
    expect(zoneLabel('Europe/Bucharest')).toBe('Bucharest (Europe/Bucharest)');
    expect(zoneLabel('UTC')).toBe('UTC');
    expect(localTimeIn('Europe/Bucharest', winter)).toBe('12:30');
    expect(localTimeIn('Europe/Bucharest', summer)).toBe('13:30');
    expect(utcOffsetLabel('Europe/Bucharest', summer)).toBe('UTC+03:00');
    expect(utcOffsetLabel('Asia/Kolkata', winter)).toBe('UTC+05:30');
    expect(utcOffsetLabel('America/St_Johns', winter)).toBe('UTC-03:30');
    expect(utcOffsetLabel('UTC', winter)).toBe('UTC');
    expect(localTimeSummary('Europe/Bucharest', winter)).toBe('12:30 (UTC+02:00)');
    expect(localTimeIn('UTC', new Date('2026-01-15T00:05:00Z'))).toBe('00:05');
  });
});

describe('switcher view model', () => {
  const list: MyCommunity[] = [
    { community_id: 'a', membership_id: 'ma', name: 'Alpha Pack', timezone: 'Europe/Bucharest', role: 'organizer', joined_at: '2026-01-01T00:00:00Z' },
    { community_id: 'b', membership_id: 'mb', name: 'Beta Club', timezone: 'Asia/Kolkata', role: 'member', joined_at: '2026-02-01T00:00:00Z' },
  ];
  const now = new Date('2026-01-15T10:30:00Z');

  it('shows a switcher only for two or more communities', () => {
    expect(canSwitchCommunity([])).toBe(false);
    expect(canSwitchCommunity([list[0]])).toBe(false);
    expect(canSwitchCommunity(list)).toBe(true);
  });

  it('lists name, role, zone with local time, and marks the active one', () => {
    const items = buildSwitcherItems(list, 'b', now);
    expect(items.map((item) => [item.name, item.roleLabel, item.isActive])).toEqual([
      ['Alpha Pack', 'Organizer', false],
      ['Beta Club', 'Member', true],
    ]);
    expect(items[0].timezoneLabel).toBe('Bucharest, 12:30 (UTC+02:00)');
    expect(items[1].accessibilityLabel).toBe('Beta Club, Member, Kolkata, 16:00 (UTC+05:30), current community');
    expect(items[0].accessibilityLabel).not.toMatch(/current community/);
  });

  it('survives a time zone name the runtime does not know', () => {
    const items = buildSwitcherItems([{ ...list[0], timezone: 'Mars/Base' }], 'a', now);
    expect(items[0].timezoneLabel).toBe('Mars/Base');
  });
});

describe('communityTitle (Home header)', () => {
  const list = [
    { community_id: 'a', name: 'Alpha' },
    { community_id: 'b', name: 'Beta' },
  ];

  it('prefers the loaded name, then the name from the list, never a placeholder', () => {
    expect(communityTitle(list, 'b', 'Beta (loaded)')).toBe('Beta (loaded)');
    expect(communityTitle(list, 'b', null)).toBe('Beta'); // detail of an uncached community still loading
    expect(communityTitle(list, 'b', undefined)).toBe('Beta');
    expect(communityTitle(list, 'b', '  ')).toBe('Beta');
  });

  it('is null (skeleton) when nothing is known', () => {
    expect(communityTitle(list, null, null)).toBeNull();
    expect(communityTitle(list, 'zzz', null)).toBeNull();
    expect(communityTitle([], 'a', null)).toBeNull();
  });
});
