import { describe, expect, it } from 'vitest';

import {
  activeCommunityStorageKey,
  combineMembershipState,
  communitiesStateOf,
  communityToSwitchTo,
  detailStateOf,
  parseMyCommunities,
  parseStoredCommunityId,
  resolveActiveCommunityId,
} from '@/features/community/domain/activeCommunity';
import { decideRoute, type AppRoute, type MembershipState, type SessionState } from '@/features/community/domain/gate';

import { communityNameSchema, createCommunityFormSchema, isCommunityTimeZone, communitySettingsFormSchema } from './communityForm';
import { createRequestIdTracker } from './requestId';
import { buildSwitcherItems, canSwitchCommunity } from './switcher';
import {
  defaultTimeZone,
  FALLBACK_TIME_ZONES,
  listTimeZones,
  localTimeIn,
  localTimeSummary,
  searchTimeZones,
  utcOffsetLabel,
  zoneLabel,
} from './timezones';

/**
 * C-Q1: independent tests of the community logic of the app (pure parts). `it.fails` marks a
 * demonstrated defect (DEFECT Q6-n): the test asserts the correct behaviour, fails today and
 * keeps the suite green; remove `.fails` when it is fixed.
 */

const UUID_A = '0f0f0f0f-0000-4000-8000-00000000000a';
const UUID_B = '0f0f0f0f-0000-4000-8000-00000000000b';
const UUID_C = '0f0f0f0f-0000-4000-8000-00000000000c';

describe('request id tracker (idempotency key of create_community_with_code)', () => {
  const input = { code: 'ABCD2345', name: 'Bears', timezone: 'Europe/Bucharest', displayName: 'Ana' };
  const counter = () => {
    let n = 0;
    return { generate: () => `id-${++n}`, calls: () => n };
  };

  it('gives the same id to every retry of one submission, however many', () => {
    const c = counter();
    const tracker = createRequestIdTracker(c.generate);
    const first = tracker.idFor(input);
    for (let i = 0; i < 100; i += 1) expect(tracker.idFor({ ...input })).toBe(first);
    expect(c.calls()).toBe(1);
  });

  it('gives a new id after ANY field changes, and after success; two trackers never share ids', () => {
    const c = counter();
    const tracker = createRequestIdTracker(c.generate);
    const first = tracker.idFor(input);
    for (const change of [{ code: 'ZZZZ2345' }, { name: 'Bears ' }, { timezone: 'UTC' }, { displayName: 'Ana B' }]) {
      const id = tracker.idFor({ ...input, ...change });
      expect(id).not.toBe(first);
      tracker.reset();
    }
    expect(tracker.idFor(input)).not.toBe(first); // after reset, the same values are a new submission
    const other = createRequestIdTracker(c.generate);
    expect(other.idFor(input)).not.toBe(tracker.idFor(input));
  });

  it('editing and then restoring the values is a NEW submission (documented limit)', () => {
    // If the first attempt reached the server and only the answer was lost, edit-and-revert makes a
    // second community with the same values (when the code has uses left). The server cannot know
    // it is the same intent. Acceptable, but the retry hint in the UI ("will not create a
    // duplicate") holds only while the form is left untouched.
    const c = counter();
    const tracker = createRequestIdTracker(c.generate);
    const first = tracker.idFor(input);
    tracker.idFor({ ...input, name: 'Bears 2' });
    expect(tracker.idFor(input)).not.toBe(first);
  });

  it('is not sensitive to key order and treats look-alike strings as different values', () => {
    const tracker = createRequestIdTracker(() => Math.random().toString(36));
    const a = tracker.idFor({ displayName: 'Ana', timezone: 'UTC', name: 'x', code: 'C' });
    expect(tracker.idFor({ code: 'C', name: 'x', timezone: 'UTC', displayName: 'Ana' })).toBe(a);
    const b = tracker.idFor({ code: 'C', name: 'x​', timezone: 'UTC', displayName: 'Ana' });
    expect(b).not.toBe(a);
  });
});

describe('community form against the server rules it mirrors', () => {
  it('collapses whitespace like the server does for titles, and counts 80 code points', () => {
    expect(communityNameSchema.parse('  a \t\n b c  ')).toBe('a b c');
    expect(communityNameSchema.safeParse('\u{1F600}'.repeat(80)).success).toBe(true);
    expect(communityNameSchema.safeParse('\u{1F600}'.repeat(81)).success).toBe(false);
    expect(communityNameSchema.safeParse('').success).toBe(false);
    expect(communityNameSchema.safeParse(' \n\t ').success).toBe(false);
  });

  it('lets invisible-only names through (the server then answers validation_failed:name; documented)', () => {
    for (const hidden of ['​', '⁠⁠', 'ㅤ', '؜']) {
      expect(communityNameSchema.safeParse(hidden).success, JSON.stringify(hidden)).toBe(true);
    }
  });

  it('the creator form and the settings form share name and zone rules', () => {
    const good = { name: 'Bears', timezone: 'Europe/Bucharest', displayName: 'Ana' };
    expect(createCommunityFormSchema.safeParse(good).success).toBe(true);
    expect(communitySettingsFormSchema.safeParse({ name: good.name, timezone: good.timezone }).success).toBe(true);
    for (const timezone of ['', 'EST', 'GMT', 'Factory', 'posix/Europe/Bucharest', 'right/UTC', 'Mars/Base', ' Europe/Bucharest', 'Europe/Bucharest ']) {
      expect(createCommunityFormSchema.safeParse({ ...good, timezone }).success, timezone).toBe(false);
      expect(communitySettingsFormSchema.safeParse({ name: good.name, timezone }).success, timezone).toBe(false);
    }
  });

  // DEFECT Q6-8 (low): `new Intl.DateTimeFormat` accepts zone names case-insensitively, so the
  // client accepts "europe/bucharest" while the server pattern needs a capital first letter and
  // exact names (validation_failed:timezone). The picker only offers canonical names, so this is
  // unreachable today; the client rule should simply be the server rule.
  it.fails('DEFECT Q6-8: the client rejects a zone name the server would reject (lower case)', () => {
    expect(isCommunityTimeZone('europe/bucharest')).toBe(false);
    expect(isCommunityTimeZone('EUROPE/BUCHAREST')).toBe(false);
  });
});

describe('time zone list, search and display', () => {
  it('the runtime list is clean: unique, sorted, UTC first by name order, only Area/Location, no Etc, includes the device zone', () => {
    const zones = listTimeZones();
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b, 'en')));
    expect(zones).toContain('UTC');
    expect(zones.some((z) => z.startsWith('Etc/'))).toBe(false);
    expect(zones.every(isCommunityTimeZone)).toBe(true);
    expect(zones).toContain('Europe/Bucharest');
    expect(zones.some((z) => z === 'Asia/Kolkata' || z === 'Asia/Calcutta')).toBe(true);
    expect(listTimeZones(() => undefined, 'Asia/Calcutta')).toContain('Asia/Calcutta');
  });

  it('a hostile or broken runtime list cannot put a bad zone in the picker', () => {
    const zones = listTimeZones(
      () => ['Europe/Bucharest', 'Europe/Bucharest', 'EST', 'posix/UTC', 'Mars/Base', '', ' Europe/Paris', 'Etc/GMT+5', 'Factory', 'Asia/Tokyo'],
      null,
    );
    expect(zones).toEqual(['Asia/Tokyo', 'Europe/Bucharest', 'UTC']);
    expect(listTimeZones(() => [], null)).toEqual(listTimeZones(() => undefined, null));
    expect(() => listTimeZones(() => { throw new RangeError('no'); }, null)).not.toThrow();
  });

  it('the built-in fallback has no duplicates, is sorted by region, and every entry resolves', () => {
    expect(new Set(FALLBACK_TIME_ZONES).size).toBe(FALLBACK_TIME_ZONES.length);
    for (const zone of FALLBACK_TIME_ZONES) expect(() => localTimeIn(zone, new Date())).not.toThrow();
    // Covers every UTC offset family a user may meet: half-hour, 45-minute, and DST-less zones.
    const offsets = new Set(FALLBACK_TIME_ZONES.map((z) => utcOffsetLabel(z, new Date('2026-01-15T12:00:00Z'))));
    for (const label of ['UTC', 'UTC+05:30', 'UTC+05:45', 'UTC-03:30', 'UTC+09:00', 'UTC-08:00']) expect(offsets).toContain(label);
  });

  it('the default zone is the device zone when the server would accept it, else UTC', () => {
    expect(defaultTimeZone('Europe/Bucharest')).toBe('Europe/Bucharest');
    for (const device of [null, '', 'GMT', 'EST', 'Factory', 'posix/UTC', 'Not/AZone']) expect(defaultTimeZone(device)).toBe('UTC');
  });

  it('shows the offset of half-hour, 45-minute and DST zones at a given instant', () => {
    const jan = new Date('2026-01-15T12:00:00Z');
    const jul = new Date('2026-07-15T12:00:00Z');
    const expected: [string, Date, string][] = [
      ['Asia/Kolkata', jan, 'UTC+05:30'], ['Asia/Kathmandu', jul, 'UTC+05:45'], ['America/St_Johns', jan, 'UTC-03:30'],
      ['America/St_Johns', jul, 'UTC-02:30'], ['Pacific/Chatham', jan, 'UTC+13:45'], ['Pacific/Chatham', jul, 'UTC+12:45'],
      ['Australia/Lord_Howe', jan, 'UTC+11:00'], ['Australia/Lord_Howe', jul, 'UTC+10:30'], ['Pacific/Kiritimati', jan, 'UTC+14:00'],
      ['Etc/GMT+12', jan, 'UTC-12:00'], ['UTC', jan, 'UTC'], ['Europe/London', jan, 'UTC'], ['Europe/London', jul, 'UTC+01:00'],
      ['Europe/Bucharest', jan, 'UTC+02:00'], ['Europe/Bucharest', jul, 'UTC+03:00'], ['America/Caracas', jan, 'UTC-04:00'],
    ];
    for (const [zone, at, label] of expected) expect(utcOffsetLabel(zone, at), `${zone} ${at.toISOString()}`).toBe(label);
  });

  it('shows the local time across the spring-forward gap and at midnight (never 24:xx)', () => {
    // Bucharest: clocks go from 03:00 to 04:00 at 01:00 UTC on 29 March 2026.
    expect(localTimeSummary('Europe/Bucharest', new Date('2026-03-29T00:59:00Z'))).toBe('02:59 (UTC+02:00)');
    expect(localTimeSummary('Europe/Bucharest', new Date('2026-03-29T01:00:00Z'))).toBe('04:00 (UTC+03:00)');
    expect(localTimeSummary('Europe/Bucharest', new Date('2026-10-25T00:59:00Z'))).toBe('03:59 (UTC+03:00)');
    expect(localTimeSummary('Europe/Bucharest', new Date('2026-10-25T01:00:00Z'))).toBe('03:00 (UTC+02:00)');
    const zones = listTimeZones();
    for (const hour of [0, 5, 10, 15, 20]) {
      const at = new Date(Date.UTC(2026, 10, 16, hour, 5));
      for (const zone of zones) {
        const text = localTimeIn(zone, at);
        expect(text, `${zone} at ${hour}:05Z`).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      }
    }
  });

  it('search is case-insensitive, word based, ranks the city first, and never throws on odd input', () => {
    const zones = listTimeZones();
    expect(searchTimeZones(zones, 'new york')[0]).toBe('America/New_York');
    expect(searchTimeZones(zones, 'NEW_YORK')).toContain('America/New_York');
    expect(searchTimeZones(zones, 'bucharest')[0]).toBe('Europe/Bucharest');
    expect(searchTimeZones(zones, 'europe buch')).toContain('Europe/Bucharest');
    expect(searchTimeZones(zones, 'utc')).toContain('UTC');
    expect(searchTimeZones(zones, '   ')).toEqual(zones);
    for (const query of ['(', '[', '\\', '.*', '+', '?', '$^', '|', '/', '___', '\u0000', 'București', 'a'.repeat(20000), '\u{1F600}']) {
      const found = searchTimeZones(zones, query);
      expect(found.every((z) => zones.includes(z)), JSON.stringify(query.slice(0, 20))).toBe(true);
    }
    expect(searchTimeZones(zones, 'zzzzzz')).toEqual([]);
  });

  it('labels: city with zone, UTC alone; a stored zone the runtime lacks still has a label', () => {
    expect(zoneLabel('Europe/Bucharest')).toBe('Bucharest (Europe/Bucharest)');
    expect(zoneLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires (America/Argentina/Buenos_Aires)');
    expect(zoneLabel('UTC')).toBe('UTC');
  });
});

describe('switcher view model', () => {
  const now = new Date('2026-11-16T10:00:00Z');
  const mine = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      community_id: `0f0f0f0f-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
      membership_id: `m${i}`,
      name: `Pack ${i}`,
      timezone: i % 2 ? 'Asia/Kolkata' : 'America/St_Johns',
      role: (i % 3 === 0 ? 'organizer' : 'member') as 'organizer' | 'member',
      joined_at: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
    }));

  it('stays correct with many communities: one checked row, labels say role and zone, ids stay unique', () => {
    const list = mine(40);
    const items = buildSwitcherItems(list, list[7].community_id, now);
    expect(items).toHaveLength(40);
    expect(items.filter((i) => i.isActive)).toHaveLength(1);
    expect(new Set(items.map((i) => i.id)).size).toBe(40);
    expect(items[7].accessibilityLabel.endsWith('current community')).toBe(true);
    expect(items[1].timezoneLabel).toBe('Kolkata, 15:30 (UTC+05:30)');
    expect(items[0].timezoneLabel).toBe('St Johns, 06:30 (UTC-03:30)');
    expect(canSwitchCommunity(list)).toBe(true);
    expect(canSwitchCommunity(mine(1))).toBe(false);
    expect(canSwitchCommunity([])).toBe(false);
  });

  it('no row is active when the active id is unknown or null (never two rows checked)', () => {
    for (const active of [null, UUID_A, '']) {
      expect(buildSwitcherItems(mine(3), active, now).some((i) => i.isActive)).toBe(false);
    }
  });
});

describe('active community resolution: stored ids, other accounts, hostile values', () => {
  const list = [{ community_id: UUID_A }, { community_id: UUID_B }];

  it('uses a per-user key built only from characters SecureStore accepts', () => {
    const k1 = activeCommunityStorageKey('11111111-1111-4111-8111-111111111111');
    const k2 = activeCommunityStorageKey('22222222-2222-4222-8222-222222222222');
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("another account's stored community, or a removed one, is never selected", () => {
    // Account X stored UUID_C on this device; account Y (key per user, so Y never reads it)
    // would at worst find it in a list that lacks it: it must fall back to Y's first community.
    expect(resolveActiveCommunityId(list, UUID_C)).toBe(UUID_A);
    expect(resolveActiveCommunityId(list, UUID_B)).toBe(UUID_B);
    expect(resolveActiveCommunityId([{ community_id: UUID_B }], UUID_A)).toBe(UUID_B);
    expect(resolveActiveCommunityId([], UUID_A)).toBeNull();
  });

  it('ignores anything that is not a UUID, without throwing', () => {
    for (const raw of [null, undefined, '', '   ', 'null', 'undefined', '0', UUID_B + 'x', 'x' + UUID_B, UUID_B + '\n0', '\u0000' + UUID_B, 'a'.repeat(100_000), '{"id":"x"}', '../etc/passwd']) {
      const parsed = parseStoredCommunityId(raw);
      if (raw === UUID_B + 'x' || raw === 'x' + UUID_B) expect(parsed).toBeNull();
      expect(resolveActiveCommunityId(list, raw as string | null)).toBe(parsed === UUID_B ? UUID_B : UUID_A);
    }
    expect(parseStoredCommunityId(`  ${UUID_B.toUpperCase()}  `)).toBe(UUID_B);
  });

  it('a notification can only switch to a community the user is an active member of', () => {
    expect(communityToSwitchTo(UUID_C, list, UUID_A)).toBeNull();
    expect(communityToSwitchTo(UUID_B, list, UUID_A)).toBe(UUID_B);
    expect(communityToSwitchTo(UUID_B.toUpperCase(), list, UUID_A)).toBe(UUID_B);
    expect(communityToSwitchTo(` ${UUID_B}`, list, UUID_A)).toBeNull();
    expect(communityToSwitchTo(UUID_A, list, UUID_A)).toBeNull();
    expect(communityToSwitchTo(UUID_B, [], null)).toBeNull();
    expect(communityToSwitchTo('', list, UUID_A)).toBeNull();
  });
});

describe('route gate with several communities', () => {
  const sessions: SessionState[] = ['loading', 'none', 'unavailable', 'present'];
  const memberships: MembershipState[] = ['pending', 'error', 'none', 'active'];
  const routes: AppRoute[] = ['loading', 'error', 'onboarding', 'app'];

  it('over every combination: a settled user is never sent back to the splash or error screen, and a signed-out device is always onboarding', () => {
    for (const session of sessions) {
      for (const membership of memberships) {
        for (const previous of routes) {
          const next = decideRoute({ session, membership }, previous);
          const label = `${session}/${membership} from ${previous} -> ${next}`;
          if (session === 'none') expect(next, label).toBe('onboarding');
          if (previous === 'app' || previous === 'onboarding') expect(['loading', 'error'], label).not.toContain(next);
          if (session === 'present' && membership === 'active') expect(next, label).toBe('app');
          if (session === 'present' && membership === 'none') expect(next, label).toBe('onboarding');
        }
      }
    }
  });

  it('a user adding or switching a community keeps the app while the new one loads (list known, detail pending)', () => {
    const membership = combineMembershipState({ list: communitiesStateOf({ data: [{}, {}], isError: false }), storageLoaded: true, detail: detailStateOf({ data: undefined, isError: false }) });
    expect(membership).toBe('pending');
    expect(decideRoute({ session: 'present', membership }, 'app')).toBe('app');
    // The same moment on a cold start waits on the splash screen instead.
    expect(decideRoute({ session: 'present', membership }, 'loading')).toBe('loading');
  });

  it('a failed detail or list read never reads as "no communities"', () => {
    expect(combineMembershipState({ list: communitiesStateOf({ data: undefined, isError: true }), storageLoaded: true, detail: 'pending' })).toBe('error');
    expect(combineMembershipState({ list: 'active', storageLoaded: true, detail: detailStateOf({ data: undefined, isError: true }) })).toBe('error');
    expect(communitiesStateOf({ data: [], isError: true })).toBe('none'); // a stale empty list that failed to refresh: documented
    expect(() => parseMyCommunities([{ community_id: UUID_A }])).toThrow();
    expect(() => parseMyCommunities(null)).toThrow();
    expect(() => parseMyCommunities({})).toThrow();
  });
});
