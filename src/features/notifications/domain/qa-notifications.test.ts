import { QueryClient } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildMessage, type ClaimedJob } from '../../../../supabase/functions/dispatch-notifications/dispatch';
import { activityKeys, type AnnouncementFeed } from '../api/keys';
import type { AppNotification } from '@/lib/database.types';
import { utcToWallTime, wallTimeToUtc } from '@/lib/datetime';

import { applyOptimisticMarkAllRead, applyOptimisticNotificationRead, rollbackRead } from './activityCache';
import {
  announcementFormSchema,
  toAnnouncementInput,
  type AnnouncementFormValues,
} from './announcementForm';
import { hrefForLink, parseAppLink, targetFromPushData } from './deepLink';
import { derivePushState, type PushPermission, type PushRegistration } from './pushState';
import { badgeText, combinedUnreadCount } from './unread';
import { announcement, notification } from './testFixtures';

/** QA (M3-Q1): adversarial pure-logic tests for the mobile half of Milestone 3. */

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ROOT = process.cwd();
const read = (p: string) => readFileSync(`${ROOT}/${p}`, 'utf8');

describe('QA deep link allowlist', () => {
  it('accepts exactly the three documented shapes and normalizes case', () => {
    expect(parseAppLink(`/trainings/${ID}`)).toEqual({ kind: 'training', id: ID });
    expect(parseAppLink(`/announcements/${ID.toUpperCase()}`)).toEqual({ kind: 'announcement', id: ID });
    expect(parseAppLink('/activity')).toEqual({ kind: 'activity' });
  });

  it('rejects hostile, malformed and look-alike links', () => {
    const hostile: unknown[] = [
      `//evil.example/trainings/${ID}`, `https://evil.example/trainings/${ID}`, `trainhive://trainings/${ID}`,
      `javascript:alert(1)`, `/trainings/${ID}/`, `/trainings/${ID}/edit`, `/trainings/${ID}/attendance`,
      `/trainings/${ID}?x=1`, `/trainings/${ID}#frag`, `/trainings/${ID} `, ` /trainings/${ID}`, `/trainings/${ID}\n`,
      `/Trainings/${ID}`, `/TRAININGS/${ID}`, `/trainings/../announcements/${ID}`, `/trainings/%2e%2e/${ID}`,
      `/trainings/${ID}%0a`, `/trainings//${ID}`, `/trainings`, `/trainings/`, `/`, '', '/activity/', '/activity?x=1',
      '/Activity', '/activity/x', `/trainings/${ID.slice(0, -1)}`, `/trainings/${ID}0`, `/trainings/${ID.replace(/a/g, 'g')}`,
      `/trainings/${ID.replace('0f8fad5b', '０f8fad5b')}`, `/announcements/new`, `/announcements/${ID}/edit`,
      `/invitations`, `/attendance-history`, `/(tabs)/activity`, `\\trainings\\${ID}`, `/trainings/${ID}\u0000`,
      null, undefined, 0, 1, {}, [], [`/trainings/${ID}`], true, Symbol.iterator.toString(),
    ];
    for (const link of hostile) expect(parseAppLink(link), JSON.stringify(link)).toBeNull();
  });

  it('a 1 MB hostile string is rejected quickly', () => {
    const start = Date.now();
    expect(parseAppLink('/'.repeat(1_000_000))).toBeNull();
    expect(parseAppLink(`/trainings/${'a'.repeat(1_000_000)}`)).toBeNull();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('hrefForLink only ever builds from validated parts', () => {
    const link = parseAppLink(`/trainings/${ID}`)!;
    expect(hrefForLink(link)).toBe(`/trainings/${ID}`);
  });

  it('push data: a valid link wins; hostile values are ignored; prototype and non-object payloads are safe', () => {
    expect(targetFromPushData({ deepLink: `/trainings/${ID}`, notificationId: ID })).toEqual({ href: `/trainings/${ID}`, notificationId: ID });
    expect(targetFromPushData({ deepLink: '//evil.example', url: `/announcements/${ID}` }).href).toBe(`/announcements/${ID}`);
    expect(targetFromPushData({ deepLink: 'https://evil.example', url: 'https://evil.example' })).toEqual({ href: null, notificationId: null });
    expect(targetFromPushData({ notificationId: 'not-a-uuid' }).notificationId).toBeNull();
    expect(targetFromPushData({ notificationId: 'not-a-uuid', notification_id: ID }).notificationId).toBe(ID);
    for (const data of [null, undefined, 'str', 42, [], [`/trainings/${ID}`], () => 0, Object.create(null), { __proto__: { deepLink: `/trainings/${ID}` } }]) {
      expect(() => targetFromPushData(data)).not.toThrow();
    }
    // Inherited properties on a hostile object are not trusted away from own data: current behaviour is to read them.
    expect(targetFromPushData({ __proto__: { deepLink: `/trainings/${ID}` } }).href).toBe(`/trainings/${ID}`);
  });

  it('the dispatcher payload round-trips through the app parser for both link kinds', () => {
    for (const [kind, link] of [['training_confirmed', `/trainings/${ID}`], ['announcement_published', `/announcements/${ID}`]] as const) {
      const job = {
        job_id: 'j', notification_id: ID, user_id: 'u', kind, title: 't', body: 'b', deep_link: link, community_id: 'c',
        related_session_id: null, related_announcement_id: null, attempts: 1, max_attempts: 5, unread_count: 3,
        push_allowed: true, skip_reason: null, tokens: ['ExponentPushToken[x]'],
      } satisfies ClaimedJob;
      const message = buildMessage(job, 'ExponentPushToken[x]', Date.now());
      expect(targetFromPushData(message.data)).toEqual({ href: link, notificationId: ID });
    }
  });

  it('the Android channel id matches the dispatcher message, the config plugin and the native module', () => {
    expect(read('src/features/notifications/api/pushNative.ts')).toContain("ANDROID_CHANNEL_ID = 'default'");
    expect(read('supabase/functions/dispatch-notifications/dispatch.ts')).toContain("channelId: 'default'");
    expect(JSON.parse(read('app.json')).expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-notifications')[1].defaultChannel).toBe('default');
  });
});

describe('QA unread state', () => {
  const me = 'me';
  const announcementNote = (id: string, announcementId: string, read: string | null = null): AppNotification =>
    notification({ id, kind: 'announcement_published', related_session_id: null, related_announcement_id: announcementId, read_at: read });

  it('counts an announcement and its notification once; own announcements never count', () => {
    const items = [announcement({ id: 'a1' }), announcement({ id: 'a2', author_id: me })];
    expect(combinedUnreadCount({ items, readIds: [], notifications: [announcementNote('n1', 'a1')], userId: me })).toBe(1);
    expect(combinedUnreadCount({ items, readIds: ['a1'], notifications: [announcementNote('n1', 'a1', 'x')], userId: me })).toBe(0);
  });

  it('badge text boundaries', () => {
    expect([0, -1, NaN, Infinity, 1, 99, 100, 1000].map(badgeText)).toEqual([null, null, null, null, '1', '99', '99+', '99+']);
  });

  // DEFECT Q4-4 (low-medium): "Mark all read" on the Notifications section only marks
  // notifications. mark_all_notifications_read does not touch announcement_reads, and the client
  // does not call mark_announcements_read, so the unread announcements stay unread and the tab
  // badge keeps a number the user just cleared. Also the optimistic update
  // applyOptimisticNotificationRead claims "the server does the same" for the announcement read
  // state, but mark_notification_read only changes the notification: the announcement flips back to
  // unread on the next refetch.
  it('Q4-4 (fixed): after "Mark all read" nothing is left unread', () => {
    const qc = new QueryClient();
    const feed: AnnouncementFeed = { items: [announcement({ id: 'a1' })], readIds: [] };
    qc.setQueryData(activityKeys.feed('c1', me), feed);
    qc.setQueryData(activityKeys.notifications('c1', me), [announcementNote('n1', 'a1')]);
    applyOptimisticMarkAllRead(qc, '2026-11-15T10:00:00Z', 'c1');
    const items = qc.getQueryData<AnnouncementFeed>(activityKeys.feed('c1', me))!;
    const notes = qc.getQueryData<AppNotification[]>(activityKeys.notifications('c1', me))!;
    expect(combinedUnreadCount({ items: items.items, readIds: items.readIds, notifications: notes, userId: me })).toBe(0);
  });

  it('the optimistic notification read marks the announcement read in the cache and rolls back exactly', () => {
    const qc = new QueryClient();
    qc.setQueryData<AnnouncementFeed>(activityKeys.feed('c1', me), { items: [announcement({ id: 'a1' })], readIds: [] });
    qc.setQueryData(activityKeys.notifications('c1', me), [announcementNote('n1', 'a1')]);
    const snap = applyOptimisticNotificationRead(qc, { id: 'n1', related_announcement_id: 'a1' }, 'T');
    expect(qc.getQueryData<AnnouncementFeed>(activityKeys.feed('c1', me))!.readIds).toEqual(['a1']);
    rollbackRead(qc, snap);
    expect(qc.getQueryData<AnnouncementFeed>(activityKeys.feed('c1', me))!.readIds).toEqual([]);
    expect(qc.getQueryData<AppNotification[]>(activityKeys.notifications('c1', me))![0].read_at).toBeNull();
  });
});

describe('QA announcement form vs server rules', () => {
  const zone = 'Europe/Bucharest';
  const now = new Date('2027-03-27T10:00:00Z');
  const base: AnnouncementFormValues = { title: 'T', body: 'B', mode: 'now', date: '', time: '' };
  const check = (values: Partial<AnnouncementFormValues>) => announcementFormSchema({ timezone: zone, now }).safeParse({ ...base, ...values });
  const issues = (values: Partial<AnnouncementFormValues>) => {
    const r = check(values);
    return r.success ? [] : r.error.issues.map((i) => String(i.path[0]));
  };

  it('counts code points like char_length: 100 emoji ok, 101 not, 2000 / 2001 body', () => {
    expect(issues({ title: '😀'.repeat(100) })).toEqual([]);
    expect(issues({ title: '😀'.repeat(101) })).toEqual(['title']);
    expect(issues({ body: '😀'.repeat(2000) })).toEqual([]);
    expect(issues({ body: '😀'.repeat(2001) })).toEqual(['body']);
  });

  it('whitespace-only is blank; a newline in the title is refused (the server would collapse it)', () => {
    expect(issues({ title: '  \t ' })).toEqual(['title']);
    expect(issues({ body: '\n\n' })).toEqual(['body']);
    expect(issues({ title: 'a\nb' })).toEqual(['title']);
  });

  it('known client/server difference: a title of 101 characters that contains runs of spaces is refused by the client but would be accepted by the server (it collapses to <= 100)', () => {
    const title = `a${' '.repeat(3)}${'b'.repeat(97)}`;
    expect(title.length).toBe(101);
    expect(issues({ title })).toEqual(['title']);
  });

  it('scheduling: past, exactly now, 365 days (ok) and beyond (refused), in the community zone', () => {
    const wall = (ms: number) => utcToWallTime(new Date(now.getTime() + ms), zone);
    const sched = (ms: number) => ({ mode: 'schedule' as const, date: wall(ms).date, time: wall(ms).time });
    expect(issues(sched(-3_600_000))).toEqual(['date']);
    expect(issues(sched(3_600_000))).toEqual([]);
    expect(issues(sched(364 * 86_400_000))).toEqual([]);
    expect(issues(sched(367 * 86_400_000))).toEqual(['date']);
    expect(issues({ mode: 'schedule', date: '', time: '' }).sort()).toEqual(['date', 'time']);
    expect(issues({ mode: 'schedule', date: '2027-02-30', time: '10:00' })).toContain('date');
    expect(issues({ mode: 'schedule', date: '2027-04-01', time: '24:00' })).toContain('time');
  });

  it('DST: a skipped local time is moved forward, an ambiguous one takes the first occurrence (no warning in the form; observation)', () => {
    expect(wallTimeToUtc('2027-03-28', '03:30', zone)).toBe('2027-03-28T01:30:00.000Z');
    expect(utcToWallTime('2027-03-28T01:30:00.000Z', zone).time).toBe('04:30');
    expect(wallTimeToUtc('2027-10-31', '03:30', zone)).toBe('2027-10-31T00:30:00.000Z');
    expect(check({ mode: 'schedule', date: '2027-03-28', time: '03:30' }).success).toBe(true);
  });

  it('the payload sends trimmed text and a UTC instant; publish-now sends null', () => {
    expect(toAnnouncementInput({ ...base, title: ' T ', body: ' B\n' }, zone)).toEqual({ title: 'T', body: 'B', scheduledFor: null });
    const out = toAnnouncementInput({ ...base, mode: 'schedule', date: '2027-06-01', time: '09:00' }, zone);
    expect(out.scheduledFor).toBe('2027-06-01T06:00:00.000Z');
  });

  it('an invalid community zone makes the schema refuse to build rather than guess', () => {
    expect(() => announcementFormSchema({ timezone: 'Mars/Base', now })).toThrow(RangeError);
  });
});

describe('QA push permission state machine', () => {
  const permissions: (PushPermission | null)[] = [null, 'granted', 'denied', 'undetermined'];
  const registrations: PushRegistration[] = ['idle', 'registering', 'registered', 'failed'];

  it('never asks or registers where push cannot work; every combination yields a state', () => {
    for (const platform of ['ios', 'android', 'web', 'windows', 'macos'] as const) {
      for (const isExpoGo of [true, false]) {
        for (const hasProjectId of [true, false]) {
          for (const permission of permissions) {
            for (const canAskAgain of [true, false]) {
              for (const registration of registrations) {
                const kind = derivePushState({ env: { platform, isExpoGo, hasProjectId }, permission, canAskAgain, registration });
                if (platform !== 'ios' && platform !== 'android') expect(kind).toBe('unsupported_platform');
                else if (platform === 'android' && isExpoGo) expect(kind).toBe('unsupported_expo_go');
                else if (!hasProjectId) expect(kind).toBe('not_configured');
                else if (permission === null) expect(kind).toBe('checking');
                else if (permission === 'denied') expect(kind).toBe(canAskAgain ? 'denied_can_ask' : 'denied_blocked');
                else if (permission === 'undetermined') expect(kind).toBe('can_enable');
                else expect(['registering', 'registered', 'registration_failed']).toContain(kind);
              }
            }
          }
        }
      }
    }
  });

  it('a registered state requires a granted permission: revoking it in system settings drops the claim', () => {
    const env = { platform: 'android', isExpoGo: false, hasProjectId: true } as const;
    expect(derivePushState({ env, permission: 'denied', canAskAgain: false, registration: 'registered' })).toBe('denied_blocked');
  });
});

describe('QA query shapes vs the real schema', () => {
  const schema = [
    read('supabase/migrations/20261115000300_notifications_schema.sql'),
    read('supabase/migrations/20261115000400_notifications_rpcs.sql'),
  ].join('\n');

  it('every rpc() call in the feature passes exactly the argument names the SQL function declares', () => {
    const files = ['announcements', 'notifications', 'preferences', 'pushTokens'].map((f) => read(`src/features/notifications/api/${f}.ts`));
    const calls = [...files.join('\n').matchAll(/\.rpc\(\s*'([a-z_]+)'(?:,\s*\{([^}]*)\})?/g)];
    expect(calls.length).toBeGreaterThanOrEqual(9);
    for (const [, name, args] of calls) {
      const def = schema.match(new RegExp(`create function public\\.${name}\\(([^)]*)\\)`));
      expect(def, name).not.toBeNull();
      const declared = [...def![1].matchAll(/\b(p_[a-z_]+)\b/g)].map((m) => m[1]).sort();
      const passed = [...(args ?? '').matchAll(/\b(p_[a-z_]+):/g)].map((m) => m[1]).sort();
      expect(passed, name).toEqual(declared);
    }
  });

  it('the selected tables and filter columns exist', () => {
    const api = [read('src/features/notifications/api/announcements.ts'), read('src/features/notifications/api/notifications.ts')].join('\n');
    for (const column of ['community_id', 'status', 'published_at', 'created_at', 'announcement_id', 'user_id']) {
      expect(api).toContain(`'${column}'`);
      expect(schema).toContain(column);
    }
    for (const status of ["'scheduled'", "'cancelled'", "'published'"]) expect(schema).toContain(status);
  });
});
