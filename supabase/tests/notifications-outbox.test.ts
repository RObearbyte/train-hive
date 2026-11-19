import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asService,
  asUser,
  closeDb,
  countRows,
  createPack,
  createTraining,
  createUser,
  grantConsents,
  resetData,
  rpc,
  rpcRow,
} from './helpers';
import {
  claimJobs,
  completeJob,
  createAnnouncement,
  expoToken,
  jobs,
  registerToken,
} from './notifications-helpers';
import { raised } from './qa-helpers';

beforeEach(resetData);
afterAll(closeDb);

const denied = { code: '42501' };

/** A pack whose training creation queued one job per member. */
async function queued(members = 2) {
  const p = await createPack(members);
  const session = await createTraining(p.organizerId, p.communityId);
  return { ...p, session };
}

describe('claim_notification_jobs', () => {
  it('returns the notification, the valid tokens and the unread count, and marks the job sending', async () => {
    const p = await queued(1);
    await registerToken(p.memberIds[0], expoToken('a'), 'android', 'Pixel');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await registerToken(p.memberIds[0], expoToken('b'), 'ios');

    const [job, ...rest] = await claimJobs('worker-1');
    expect(rest).toEqual([]);
    expect(job).toMatchObject({
      user_id: p.memberIds[0],
      kind: 'training_created',
      title: 'New training: Morning run',
      deep_link: `/trainings/${p.session.id}`,
      related_session_id: p.session.id,
      community_id: p.communityId,
      attempts: 1,
      max_attempts: 5,
      unread_count: 1,
      push_allowed: true,
      skip_reason: null,
      // Most recently seen first.
      tokens: [expoToken('b'), expoToken('a')],
    });
    const [stored] = await jobs();
    expect(stored).toMatchObject({ status: 'sending', attempts: 1, locked_by: 'worker-1' });
    expect(stored.locked_at).toBeInstanceOf(Date);
    // A claimed job is not handed out again.
    expect(await claimJobs('worker-2')).toEqual([]);
  });

  it('is exclusive across concurrent workers: every job claimed exactly once', async () => {
    const p = await createPack(10);
    for (let i = 0; i < 3; i += 1) await createTraining(p.organizerId, p.communityId, { title: `Run ${i}` });
    expect(await countRows('notification_delivery_jobs')).toBe(30);

    const batches = await Promise.all(Array.from({ length: 6 }, (_, i) => claimJobs(`w${i}`, 7)));
    const ids = batches.flat().map((j) => j.job_id);
    expect(new Set(ids).size).toBe(ids.length);
    const leftover = await claimJobs('late', 100);
    expect(ids.length + leftover.length).toBe(30);
    expect(new Set([...ids, ...leftover.map((j) => j.job_id)]).size).toBe(30);
    expect(await countRows('notification_delivery_jobs', "status = 'sending' and attempts = 1")).toBe(30);
  });

  it('push preferences and membership empty the token list (in-app notification kept)', async () => {
    const p = await createPack(4);
    for (const id of p.memberIds) await registerToken(id, expoToken(id));
    await asUser(p.memberIds[0], (db) => rpcRow(db, 'set_notification_preferences', [false, null, null, null]));
    await asUser(p.memberIds[1], (db) => rpcRow(db, 'set_notification_preferences', [null, null, null, false]));
    await asUser(p.memberIds[2], (db) => rpcRow(db, 'set_notification_preferences', [null, null, false, null]));
    await createTraining(p.organizerId, p.communityId);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [p.memberIds[3]]);

    const byUser = new Map((await claimJobs('w')).map((j) => [j.user_id, j]));
    expect(byUser.get(p.memberIds[0])).toMatchObject({ push_allowed: false, skip_reason: 'push_disabled', tokens: [] });
    expect(byUser.get(p.memberIds[1])).toMatchObject({ push_allowed: false, skip_reason: 'category_disabled', tokens: [] });
    // Announcements off does not stop training updates.
    expect(byUser.get(p.memberIds[2])).toMatchObject({ push_allowed: true, skip_reason: null, tokens: [expoToken(p.memberIds[2])] });
    expect(byUser.get(p.memberIds[3])).toMatchObject({ push_allowed: false, skip_reason: 'not_a_member', tokens: [] });
    // In-app notifications exist for everyone regardless.
    expect(await countRows('notifications')).toBe(4);

    // The announcements switch applies to announcements.
    await createAnnouncement(p.organizerId, p.communityId);
    const ann = (await claimJobs('w')).find((j) => j.user_id === p.memberIds[2]);
    expect(ann).toMatchObject({ kind: 'announcement_published', skip_reason: 'category_disabled', tokens: [] });
  });

  it('a user without devices: push allowed, no tokens, skip_reason no_tokens', async () => {
    const p = await queued(1);
    // With push consent (Q7-1: without it the reason is no_push_consent, tested in gdpr-qa-fixes).
    await grantConsents(p.memberIds[0], ['push_notifications']);
    const [job] = await claimJobs('w');
    expect(job).toMatchObject({ push_allowed: true, skip_reason: 'no_tokens', tokens: [] });
    expect(await completeJob(job.job_id, 'skipped', 'no_tokens')).toMatchObject({ status: 'skipped', changed: true });
    expect(p.session.id).toBeTruthy();
  });

  it('validates its arguments and is service_role only', async () => {
    await expect(asService((db) => db.query('select * from public.claim_notification_jobs(0, $1)', ['w']))).rejects.toMatchObject(raised('validation_failed:limit'));
    await expect(asService((db) => db.query('select * from public.claim_notification_jobs(10, $1)', ['  ']))).rejects.toMatchObject(raised('validation_failed:worker'));
    const { organizerId } = await createPack();
    await expect(asUser(organizerId, (db) => db.query("select * from public.claim_notification_jobs(10, 'w')"))).rejects.toMatchObject(denied);
    await expect(asAnon((db) => db.query("select * from public.claim_notification_jobs(10, 'w')"))).rejects.toMatchObject(denied);
  });
});

describe('complete_notification_job', () => {
  it('sent is final and idempotent', async () => {
    await queued(1);
    const [job] = await claimJobs('w');
    const done = await completeJob(job.job_id, 'sent');
    expect(done).toMatchObject({ status: 'sent', attempts: 1, changed: true });
    expect(done.sent_at).not.toBeNull();
    const again = await completeJob(job.job_id, 'failed', 'late duplicate');
    expect(again).toMatchObject({ status: 'sent', changed: false, sent_at: done.sent_at });
    expect(await claimJobs('w')).toEqual([]);
    const [stored] = await jobs();
    expect(stored).toMatchObject({ status: 'sent', locked_at: null, locked_by: null, last_error: null });
  });

  it('failed retries with backoff, then dead after max_attempts', async () => {
    await queued(1);
    let [job] = await claimJobs('w');
    const first = await completeJob(job.job_id, 'failed', 'HTTP 503');
    expect(first).toMatchObject({ status: 'failed', attempts: 1, changed: true });
    const delay = (new Date(first.next_attempt_at).getTime() - Date.now()) / 1000;
    expect(delay).toBeGreaterThan(25);
    expect(delay).toBeLessThan(35);
    // Not due yet.
    expect(await claimJobs('w')).toEqual([]);

    const due = () => admin.query("update public.notification_delivery_jobs set next_attempt_at = now() - interval '1 second'");
    await due();
    [job] = await claimJobs('w');
    expect(job.attempts).toBe(2);
    const second = await completeJob(job.job_id, 'failed', 'HTTP 503');
    const delay2 = (new Date(second.next_attempt_at).getTime() - Date.now()) / 1000;
    expect(delay2).toBeGreaterThan(55);
    expect(delay2).toBeLessThan(65);

    // An explicit retry delay wins (Retry-After).
    await due();
    [job] = await claimJobs('w');
    const third = await completeJob(job.job_id, 'failed', 'rate limited', 600);
    const delay3 = (new Date(third.next_attempt_at).getTime() - Date.now()) / 1000;
    expect(delay3).toBeGreaterThan(595);

    for (const attempt of [4, 5]) {
      await due();
      [job] = await claimJobs('w');
      expect(job.attempts).toBe(attempt);
      const result = await completeJob(job.job_id, 'failed', 'HTTP 503');
      expect(result.status).toBe(attempt === 5 ? 'dead' : 'failed');
    }
    await due();
    expect(await claimJobs('w')).toEqual([]);
    const [stored] = await jobs();
    expect(stored).toMatchObject({ status: 'dead', attempts: 5, last_error: 'HTTP 503' });
  });

  it('dead and skipped are final; a pending (unclaimed) job is not changed', async () => {
    await queued(3);
    const claimed = await claimJobs('w', 2);
    const untouched = (await jobs()).find((j) => j.status === 'pending')!;
    expect(await completeJob(claimed[0].job_id, 'dead', 'InvalidCredentials')).toMatchObject({ status: 'dead', changed: true });
    expect(await completeJob(claimed[1].job_id, 'skipped', 'push_disabled')).toMatchObject({ status: 'skipped', changed: true });
    expect(await completeJob(claimed[0].job_id, 'sent')).toMatchObject({ status: 'dead', changed: false });
    expect(await completeJob(claimed[1].job_id, 'sent')).toMatchObject({ status: 'skipped', changed: false });
    expect(await completeJob(untouched.id, 'sent')).toMatchObject({ status: 'pending', changed: false });
  });

  it('validates status and retry delay; unknown job is not_found; service_role only', async () => {
    await queued(1);
    const [job] = await claimJobs('w');
    await expect(completeJob(job.job_id, 'delivered')).rejects.toMatchObject(raised('validation_failed:status'));
    await expect(completeJob(job.job_id, 'failed', null, -1)).rejects.toMatchObject(raised('validation_failed:retry_in_seconds'));
    await expect(completeJob(job.job_id, 'failed', null, 86401)).rejects.toMatchObject(raised('validation_failed:retry_in_seconds'));
    await expect(completeJob('00000000-0000-0000-0000-000000000000', 'sent')).rejects.toMatchObject(raised('not_found'));
    const { organizerId } = await createPack();
    await expect(asUser(organizerId, (db) => rpc(db, 'complete_notification_job', [job.job_id, 'sent', null, null]))).rejects.toMatchObject(denied);
    // A long error text is cut to 1000 characters.
    const result = await completeJob(job.job_id, 'failed', 'x'.repeat(5000));
    expect(result.status).toBe('failed');
    expect((await jobs())[0].last_error).toHaveLength(1000);
  });
});

describe('stuck and expired jobs', () => {
  it('a job stuck in sending for more than 5 minutes is reclaimed by another worker', async () => {
    await queued(1);
    const [job] = await claimJobs('crashed');
    await admin.query("update public.notification_delivery_jobs set locked_at = now() - interval '4 minutes'");
    expect(await claimJobs('rescuer')).toEqual([]);
    await admin.query("update public.notification_delivery_jobs set locked_at = now() - interval '6 minutes'");
    const [again] = await claimJobs('rescuer');
    expect(again).toMatchObject({ job_id: job.job_id, attempts: 2 });
    expect((await jobs())[0]).toMatchObject({ status: 'sending', locked_by: 'rescuer' });
    // The crashed worker's late completion is accepted once; the rescuer's is then a no-op.
    expect(await completeJob(job.job_id, 'sent')).toMatchObject({ changed: true });
    expect(await completeJob(job.job_id, 'sent')).toMatchObject({ changed: false });
  });

  it('a stuck job that used every attempt becomes dead instead of being reclaimed', async () => {
    await queued(1);
    await claimJobs('w');
    await admin.query("update public.notification_delivery_jobs set attempts = max_attempts, locked_at = now() - interval '6 minutes'");
    expect(await claimJobs('w')).toEqual([]);
    expect((await jobs())[0]).toMatchObject({ status: 'dead', locked_at: null, last_error: 'abandoned while sending' });
  });

  it('expired jobs are never sent: they become dead with last_error expired', async () => {
    await queued(2);
    await admin.query("update public.notification_delivery_jobs set expires_at = now() - interval '1 second'");
    expect(await claimJobs('w')).toEqual([]);
    expect((await jobs()).map((j) => [j.status, j.last_error])).toEqual([
      ['dead', 'expired'],
      ['dead', 'expired'],
    ]);
    // The in-app notifications stay.
    expect(await countRows('notifications')).toBe(2);
  });

  it('training jobs expire at the end of the training, announcements after 3 days', async () => {
    const p = await queued(1);
    const [trainingJob] = await jobs();
    const end = p.session.ends_at!.getTime();
    expect(Math.abs(trainingJob.expires_at.getTime() - Math.min(end, Date.now() + 3 * 86_400_000))).toBeLessThan(5000);
    await createAnnouncement(p.organizerId, p.communityId);
    const announcementJob = (await jobs()).find((j) => j.id !== trainingJob.id)!;
    expect(Math.abs(announcementJob.expires_at.getTime() - (Date.now() + 3 * 86_400_000))).toBeLessThan(5000);
  });
});

describe('purge_old_notification_data', () => {
  it('deletes old finished jobs and long-expired pending ones, keeps notifications', async () => {
    const p = await createPack(4);
    await createTraining(p.organizerId, p.communityId);
    const all = await jobs();
    const [oldSent, recentSent, oldPending, freshPending] = all;
    await admin.query(
      "update public.notification_delivery_jobs set status = 'sent', sent_at = now(), created_at = now() - interval '31 days' where id = $1",
      [oldSent.id],
    );
    await admin.query("update public.notification_delivery_jobs set status = 'sent', sent_at = now() where id = $1", [recentSent.id]);
    await admin.query("update public.notification_delivery_jobs set expires_at = now() - interval '4 days' where id = $1", [oldPending.id]);
    expect(await asService((db) => rpc<number>(db, 'purge_old_notification_data'))).toBe(2);
    expect((await jobs()).map((j) => j.id).sort()).toEqual([recentSent.id, freshPending.id].sort());
    expect(await countRows('notifications')).toBe(4);
    await expect(asUser(p.organizerId, (db) => rpc(db, 'purge_old_notification_data'))).rejects.toMatchObject(denied);
  });

  it('removes a notification left behind for a deleted account', async () => {
    const p = await createPack(1);
    const session = await createTraining(p.organizerId, p.communityId);
    const ghost = '00000000-0000-0000-0000-00000000dead';
    await admin.query(
      `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key)
       values ($1, $2, 'training_created', 't', 'b', '/trainings/' || $3::uuid::text, $3, 'k')`,
      [ghost, p.communityId, session.id],
    );
    expect(await asService((db) => rpc<number>(db, 'purge_old_notification_data'))).toBe(1);
    expect(await countRows('notifications', 'user_id = $1', [ghost])).toBe(0);
    expect(await countRows('notifications')).toBe(1);
  });
});

describe('push tokens', () => {
  it('validates the Expo token format, platform and label', async () => {
    const { memberIds } = await createPack(1);
    const user = memberIds[0];
    const bad: [string, string, string | null, string][] = [
      ['not-a-token', 'android', null, 'validation_failed:token'],
      ['ExponentPushToken[]', 'android', null, 'validation_failed:token'],
      ['ExponentPushToken[abc', 'android', null, 'validation_failed:token'],
      ['ExponentPushToken[a b]', 'android', null, 'validation_failed:token'],
      [`ExponentPushToken[${'a'.repeat(190)}]`, 'android', null, 'validation_failed:token'],
      ['', 'android', null, 'validation_failed:token'],
      [expoToken(1), 'windows', null, 'validation_failed:platform'],
      [expoToken(1), '', null, 'validation_failed:platform'],
      [expoToken(1), 'ios', 'x'.repeat(81), 'validation_failed:device_label'],
    ];
    for (const [token, platform, label, expected] of bad) {
      await expect(registerToken(user, token, platform, label), `${token} ${platform}`).rejects.toMatchObject(raised(expected));
    }
    expect(await countRows('device_push_tokens')).toBe(0);
    const ok = await registerToken(user, ' ExpoPushToken[xyz-123_A:b.c] ', ' IOS ', '  My   phone ');
    expect(ok).toMatchObject({ user_id: user, token: 'ExpoPushToken[xyz-123_A:b.c]', platform: 'ios', device_label: 'My phone', invalidated_at: null });
    await expect(asAnon((db) => rpcRow(db, 'register_push_token', [expoToken(2), 'ios', null]))).rejects.toMatchObject(denied);
    // A signed-in user without a profile (never joined) cannot register.
    const stranger = await createUser();
    await expect(registerToken(stranger, expoToken(3))).rejects.toMatchObject(raised('not_a_member'));
  });

  it('re-registering refreshes the row; a token registered by another user moves to the caller', async () => {
    const { memberIds } = await createPack(2);
    const [ana, bob] = memberIds;
    const first = await registerToken(ana, expoToken('shared'), 'android', 'Old');
    const refreshed = await registerToken(ana, expoToken('shared'), 'android', 'New');
    expect(refreshed).toMatchObject({ id: first.id, device_label: 'New', created_at: first.created_at });
    expect((refreshed.last_seen_at as Date).getTime()).toBeGreaterThanOrEqual((first.last_seen_at as Date).getTime());

    const moved = await registerToken(bob, expoToken('shared'), 'android');
    expect(moved).toMatchObject({ id: first.id, user_id: bob });
    expect(await countRows('device_push_tokens')).toBe(1);
    const visible = (user: string) =>
      asUser(user, (db) => db.query<{ token: string }>('select token from public.device_push_tokens')).then((r) => r.rows.map((x) => x.token));
    expect(await visible(ana)).toEqual([]);
    expect(await visible(bob)).toEqual([expoToken('shared')]);
  });

  it('unregister removes only the caller\'s own token and is idempotent', async () => {
    const { memberIds } = await createPack(2);
    const [ana, bob] = memberIds;
    await registerToken(ana, expoToken('ana'));
    expect(await asUser(bob, (db) => rpc<boolean>(db, 'unregister_push_token', [expoToken('ana')]))).toBe(false);
    expect(await countRows('device_push_tokens')).toBe(1);
    expect(await asUser(ana, (db) => rpc<boolean>(db, 'unregister_push_token', [expoToken('ana')]))).toBe(true);
    expect(await asUser(ana, (db) => rpc<boolean>(db, 'unregister_push_token', [expoToken('ana')]))).toBe(false);
    expect(await countRows('device_push_tokens')).toBe(0);
  });

  it('several devices per user, at most 10 (the least recently seen are dropped)', async () => {
    const { memberIds } = await createPack(1);
    for (let i = 0; i < 12; i += 1) await registerToken(memberIds[0], expoToken(`d${i}`));
    const { rows } = await admin.query<{ token: string }>('select token from public.device_push_tokens order by token');
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.token)).not.toContain(expoToken('d0'));
    expect(rows.map((r) => r.token)).not.toContain(expoToken('d1'));
  });

  it('concurrent registrations of the same token end with one row', async () => {
    const { memberIds } = await createPack(3);
    await Promise.all(memberIds.flatMap((id) => [registerToken(id, expoToken('race')), registerToken(id, expoToken('race'))]));
    expect(await countRows('device_push_tokens')).toBe(1);
  });

  it('invalid tokens (DeviceNotRegistered) are never returned again until re-registered', async () => {
    const p = await createPack(1);
    const user = p.memberIds[0];
    await registerToken(user, expoToken('good'));
    await registerToken(user, expoToken('gone'));
    expect(await asService((db) => rpc<number>(db, 'invalidate_push_tokens', [[expoToken('gone'), expoToken('unknown')], 'DeviceNotRegistered']))).toBe(1);
    expect(await asService((db) => rpc<number>(db, 'invalidate_push_tokens', [[expoToken('gone')], 'DeviceNotRegistered']))).toBe(0);
    const stored = (await admin.query('select invalidated_at, last_error from public.device_push_tokens where token = $1', [expoToken('gone')])).rows[0];
    expect(stored.invalidated_at).toBeInstanceOf(Date);
    expect(stored.last_error).toBe('DeviceNotRegistered');

    await createTraining(p.organizerId, p.communityId);
    let [job] = await claimJobs('w');
    expect(job.tokens).toEqual([expoToken('good')]);
    await completeJob(job.job_id, 'sent');

    await registerToken(user, expoToken('gone'));
    await createTraining(p.organizerId, p.communityId, { title: 'Second' });
    [job] = await claimJobs('w');
    expect(job.tokens).toEqual([expoToken('gone'), expoToken('good')]);
    expect((await admin.query('select invalidated_at, last_error from public.device_push_tokens where token = $1', [expoToken('gone')])).rows[0]).toEqual({ invalidated_at: null, last_error: null });

    await expect(asUser(user, (db) => rpc(db, 'invalidate_push_tokens', [[expoToken('good')], 'x']))).rejects.toMatchObject(denied);
  });

  it('clients cannot write tokens or preferences directly', async () => {
    const { memberIds } = await createPack(1);
    const user = memberIds[0];
    const attempts: [string, unknown[]][] = [
      ["insert into public.device_push_tokens (user_id, token, platform) values ($1, 'ExponentPushToken[x]', 'ios')", [user]],
      ['update public.device_push_tokens set invalidated_at = null', []],
      ['delete from public.device_push_tokens', []],
      ['insert into public.notification_preferences (user_id) values ($1)', [user]],
      ['update public.notification_preferences set push_enabled = false', []],
    ];
    for (const [sql, params] of attempts) {
      await expect(asUser(user, (db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
  });
});

describe('notification preferences', () => {
  it('defaults to everything on; null keeps a value; users see only their own row', async () => {
    const { memberIds } = await createPack(2);
    const [ana, bob] = memberIds;
    const get = (user: string) => asUser(user, (db) => rpcRow<Record<string, unknown>>(db, 'get_notification_preferences'));
    expect(await get(ana)).toMatchObject({ user_id: ana, push_enabled: true, training_reminders: true, announcements: true, training_updates: true });
    expect(await countRows('notification_preferences')).toBe(0);

    await asUser(ana, (db) => rpcRow(db, 'set_notification_preferences', [null, false, null, null]));
    const after = await asUser(ana, (db) => rpcRow(db, 'set_notification_preferences', [false, null, null, null]));
    expect(after).toMatchObject({ push_enabled: false, training_reminders: false, announcements: true, training_updates: true });
    expect(await get(ana)).toMatchObject({ push_enabled: false, training_reminders: false });
    expect(await get(bob)).toMatchObject({ push_enabled: true, training_reminders: true });

    const rows = (user: string) => asUser(user, (db) => db.query('select user_id from public.notification_preferences')).then((r) => r.rows);
    expect(await rows(ana)).toEqual([{ user_id: ana }]);
    expect(await rows(bob)).toEqual([]);
    await expect(asAnon((db) => rpcRow(db, 'get_notification_preferences'))).rejects.toMatchObject(denied);
    const stranger = await createUser();
    await expect(asUser(stranger, (db) => rpcRow(db, 'set_notification_preferences', [false, null, null, null]))).rejects.toMatchObject(raised('not_a_member'));
  });

  it('the reminder switch silences reminders only', async () => {
    const p = await createPack(1);
    const user = p.memberIds[0];
    await registerToken(user, expoToken('r'));
    await asUser(user, (db) => rpcRow(db, 'set_notification_preferences', [null, false, null, null]));
    const session = await createTraining(p.organizerId, p.communityId);
    await admin.query(
      `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key)
       values ($1, $2, 'training_reminder', 'Tomorrow', 'b', '/trainings/' || $3::uuid::text, $3, 'reminder-test')`,
      [user, p.communityId, session.id],
    );
    await admin.query(
      `insert into public.notification_delivery_jobs (notification_id, user_id, expires_at)
       select id, user_id, now() + interval '1 day' from public.notifications where dedupe_key = 'reminder-test'`,
    );
    const claimed = new Map((await claimJobs('w')).map((j) => [j.kind, j]));
    expect(claimed.get('training_created')).toMatchObject({ push_allowed: true, tokens: [expoToken('r')] });
    expect(claimed.get('training_reminder')).toMatchObject({ push_allowed: false, skip_reason: 'category_disabled', tokens: [] });
  });
});

describe('service_role cannot call the new user RPCs (no caller identity)', () => {
  it('denies every authenticated-only M3 function to service_role', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const a = await createAnnouncement(organizerId, communityId);
    await addMember(communityId, { name: 'Extra' });
    const calls: [string, unknown[]][] = [
      ['select public.create_announcement($1, $2, $3)', [communityId, 't', 'b']],
      ['select public.update_announcement($1, $2, $3, null)', [a.id, 't', 'b']],
      ['select public.cancel_announcement($1)', [a.id]],
      ['select public.mark_announcement_read($1)', [a.id]],
      ['select public.mark_announcements_read($1)', [communityId]],
      ['select public.unread_announcement_count($1)', [communityId]],
      ['select public.mark_notification_read($1)', [a.id]],
      ['select public.mark_all_notifications_read($1)', [communityId]],
      ['select public.register_push_token($1, $2)', [expoToken('s'), 'ios']],
      ['select public.unregister_push_token($1)', [expoToken('s')]],
      ['select public.get_notification_preferences()', []],
      ['select public.set_notification_preferences(false)', []],
    ];
    for (const [sql, params] of calls) {
      await expect(asService((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
    expect(memberIds).toHaveLength(1);
  });
});
