import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { AppNotification } from '@/lib/database.types';

import { activityKeys, type AnnouncementFeed } from '../api/keys';
import {
  applyOptimisticAnnouncementRead,
  applyOptimisticMarkAllRead,
  applyOptimisticNotificationRead,
  rollbackRead,
} from './activityCache';
import { announcement, notification } from './testFixtures';
import { combinedUnreadCount } from './unread';

const FEED_KEY = activityKeys.feed('c1', 'me');
const NOTES_KEY = activityKeys.notifications('c1', 'me');
const T = '2026-11-10T12:00:00.000Z';

function setup(notes: AppNotification[] = []) {
  const queryClient = new QueryClient();
  const feed: AnnouncementFeed = { items: [announcement({ id: 'a1' })], readIds: [] };
  queryClient.setQueryData(FEED_KEY, feed);
  queryClient.setQueryData(NOTES_KEY, notes);
  return queryClient;
}

const feedOf = (qc: QueryClient) => qc.getQueryData<AnnouncementFeed>(FEED_KEY)!;
const notesOf = (qc: QueryClient) => qc.getQueryData<AppNotification[]>(NOTES_KEY)!;

const announcementNote = (id: string, announcementId: string) =>
  notification({
    id,
    kind: 'announcement_published',
    related_session_id: null,
    related_announcement_id: announcementId,
  });

describe('announcement read', () => {
  it('marks the announcement and its notification read, and rolls both back', () => {
    const qc = setup([announcementNote('n1', 'a1'), notification({ id: 'n2' })]);
    const snapshot = applyOptimisticAnnouncementRead(qc, 'a1', T);
    expect(feedOf(qc).readIds).toEqual(['a1']);
    expect(notesOf(qc).map((n) => n.read_at)).toEqual([T, null]);

    rollbackRead(qc, snapshot);
    expect(feedOf(qc).readIds).toEqual([]);
    expect(notesOf(qc).map((n) => n.read_at)).toEqual([null, null]);
  });

  it('does not roll back a read the server already confirmed', () => {
    const qc = setup([announcementNote('n1', 'a1')]);
    const snapshot = applyOptimisticAnnouncementRead(qc, 'a1', T);
    // A refetch lands with the server's own timestamp before the failure is reported.
    qc.setQueryData(NOTES_KEY, [{ ...notesOf(qc)[0], read_at: '2026-11-10T12:00:01.000Z' }]);
    rollbackRead(qc, snapshot);
    expect(notesOf(qc)[0].read_at).toBe('2026-11-10T12:00:01.000Z');
  });

  it('leaves an announcement that was already read alone on rollback', () => {
    const qc = setup();
    qc.setQueryData<AnnouncementFeed>(FEED_KEY, { ...feedOf(qc), readIds: ['a1'] });
    const snapshot = applyOptimisticAnnouncementRead(qc, 'a1', T);
    rollbackRead(qc, snapshot);
    expect(feedOf(qc).readIds).toEqual(['a1']);
  });
});

describe('notification read', () => {
  it('marks one notification (and its announcement) read and rolls back', () => {
    const qc = setup([announcementNote('n1', 'a1'), notification({ id: 'n2' })]);
    const snapshot = applyOptimisticNotificationRead(
      qc,
      { id: 'n1', related_announcement_id: 'a1' },
      T,
    );
    expect(notesOf(qc).map((n) => n.read_at)).toEqual([T, null]);
    expect(feedOf(qc).readIds).toEqual(['a1']);
    rollbackRead(qc, snapshot);
    expect(notesOf(qc).map((n) => n.read_at)).toEqual([null, null]);
    expect(feedOf(qc).readIds).toEqual([]);
  });

  it('two overlapping changes roll back independently', () => {
    const qc = setup([notification({ id: 'n1' }), notification({ id: 'n2', dedupe_key: 'k2' })]);
    const first = applyOptimisticNotificationRead(qc, { id: 'n1', related_announcement_id: null }, T);
    applyOptimisticNotificationRead(qc, { id: 'n2', related_announcement_id: null }, T);
    rollbackRead(qc, first);
    expect(notesOf(qc).map((n) => n.read_at)).toEqual([null, T]);
  });
});

describe('mark all read', () => {
  it('flips every unread notification and restores exactly those on rollback', () => {
    const already = '2026-11-09T08:00:00.000Z';
    const qc = setup([
      notification({ id: 'n1' }),
      notification({ id: 'n2', dedupe_key: 'k2', read_at: already }),
    ]);
    const snapshot = applyOptimisticMarkAllRead(qc, T, 'c1');
    expect(notesOf(qc).map((n) => n.read_at)).toEqual([T, already]);
    rollbackRead(qc, snapshot);
    expect(notesOf(qc).map((n) => n.read_at)).toEqual([null, already]);
  });

  it('also marks the announcements its notifications reference, and nothing else', () => {
    const qc = new QueryClient();
    qc.setQueryData<AnnouncementFeed>(FEED_KEY, {
      items: [announcement({ id: 'a1' }), announcement({ id: 'a2' })],
      readIds: [],
    });
    // a2 has no unread notification: it stays unread.
    qc.setQueryData(NOTES_KEY, [announcementNote('n1', 'a1'), notification({ id: 'n3', dedupe_key: 'k3' })]);
    applyOptimisticMarkAllRead(qc, T, 'c1');
    expect(feedOf(qc).readIds).toEqual(['a1']);
  });

  it('ignores announcements referenced only by already-read notifications', () => {
    const qc = setup([{ ...announcementNote('n1', 'a1'), read_at: '2026-11-09T08:00:00.000Z' }]);
    applyOptimisticMarkAllRead(qc, T, 'c1');
    expect(feedOf(qc).readIds).toEqual([]);
  });

  it('rolls back the announcement reads too, but keeps one that was already read', () => {
    const qc = new QueryClient();
    qc.setQueryData<AnnouncementFeed>(FEED_KEY, {
      items: [announcement({ id: 'a1' }), announcement({ id: 'a2' })],
      readIds: ['a2'],
    });
    qc.setQueryData(NOTES_KEY, [announcementNote('n1', 'a1'), announcementNote('n2', 'a2')]);
    const snapshot = applyOptimisticMarkAllRead(qc, T, 'c1');
    expect(feedOf(qc).readIds).toEqual(['a2', 'a1']);
    rollbackRead(qc, snapshot);
    expect(feedOf(qc).readIds).toEqual(['a2']);
    expect(notesOf(qc).map((n) => n.read_at)).toEqual([null, null]);
  });

  it('leaves another community cache untouched', () => {
    const qc = setup([announcementNote('n1', 'a1')]);
    const otherNotes = activityKeys.notifications('c2', 'me');
    const otherFeed = activityKeys.feed('c2', 'me');
    qc.setQueryData(otherNotes, [{ ...announcementNote('x1', 'a9'), community_id: 'c2' }]);
    qc.setQueryData<AnnouncementFeed>(otherFeed, { items: [announcement({ id: 'a9', community_id: 'c2' })], readIds: [] });
    applyOptimisticMarkAllRead(qc, T, 'c1');
    expect(qc.getQueryData<AppNotification[]>(otherNotes)![0].read_at).toBeNull();
    expect(qc.getQueryData<AnnouncementFeed>(otherFeed)!.readIds).toEqual([]);
  });

  it('leaves the tab badge at zero afterwards', () => {
    const qc = setup([announcementNote('n1', 'a1')]);
    applyOptimisticMarkAllRead(qc, T, 'c1');
    expect(
      combinedUnreadCount({
        items: feedOf(qc).items,
        readIds: feedOf(qc).readIds,
        notifications: notesOf(qc),
        userId: 'me',
        communityId: 'c1',
      }),
    ).toBe(0);
  });
});
