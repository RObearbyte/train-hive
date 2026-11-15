import { admin, asService, asUser, rpc, rpcRow } from './helpers';

/**
 * Shared helpers for the Milestone 3 suites (`announcements*.test.ts`, `notifications*.test.ts`).
 * Not a test file.
 */

export type AnnouncementStatus = 'scheduled' | 'published' | 'cancelled';

export interface Announcement {
  id: string;
  community_id: string;
  author_id: string | null;
  title: string;
  body: string;
  status: AnnouncementStatus;
  scheduled_for: Date | null;
  published_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type NotificationKind =
  | 'training_created'
  | 'training_updated'
  | 'training_confirmed'
  | 'training_cancelled'
  | 'training_reminder'
  | 'announcement_published';

export interface NotificationRow {
  id: string;
  user_id: string;
  community_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  deep_link: string;
  related_session_id: string | null;
  related_announcement_id: string | null;
  dedupe_key: string;
  created_at: Date;
  read_at: Date | null;
}

export interface JobRow {
  id: string;
  notification_id: string;
  user_id: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'dead' | 'skipped';
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  expires_at: Date;
  last_error: string | null;
  locked_at: Date | null;
  locked_by: string | null;
  created_at: Date;
  sent_at: Date | null;
}

export interface ClaimedJob {
  job_id: string;
  notification_id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  deep_link: string;
  community_id: string;
  related_session_id: string | null;
  related_announcement_id: string | null;
  attempts: number;
  max_attempts: number;
  unread_count: number;
  push_allowed: boolean;
  skip_reason: string | null;
  tokens: string[];
}

export interface CompleteResult {
  job_id: string;
  status: JobRow['status'];
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  sent_at: string | null;
  changed: boolean;
}

/** A syntactically valid Expo push token, unique per `seed`. */
export function expoToken(seed: string | number): string {
  return `ExponentPushToken[test-${seed}]`;
}

export function createAnnouncement(
  userId: string,
  communityId: string,
  options: { title?: string; body?: string; scheduledFor?: string | null } = {},
): Promise<Announcement> {
  const { title = 'Club news', body = 'New season kit is here.', scheduledFor = null } = options;
  return asUser(userId, (db) =>
    rpcRow<Announcement>(db, 'create_announcement', [communityId, title, body, scheduledFor]),
  );
}

export function updateAnnouncement(
  userId: string,
  id: string,
  title: string,
  body: string,
  scheduledFor: string | null,
): Promise<Announcement> {
  return asUser(userId, (db) => rpcRow<Announcement>(db, 'update_announcement', [id, title, body, scheduledFor]));
}

export function cancelAnnouncement(userId: string, id: string): Promise<Announcement> {
  return asUser(userId, (db) => rpcRow<Announcement>(db, 'cancel_announcement', [id]));
}

export function publishDue(): Promise<number> {
  return asService((db) => rpc<number>(db, 'publish_due_announcements'));
}

export function enqueueReminders(): Promise<number> {
  return asService((db) => rpc<number>(db, 'enqueue_due_training_reminders'));
}

export async function claimJobs(worker: string, limit = 100): Promise<ClaimedJob[]> {
  return asService(async (db) => {
    const { rows } = await db.query<{ job: ClaimedJob }>(
      'select job from public.claim_notification_jobs($1, $2) as job',
      [limit, worker],
    );
    return rows.map((row) => row.job);
  });
}

export function completeJob(
  jobId: string,
  status: string,
  error: string | null = null,
  retryInSeconds: number | null = null,
): Promise<CompleteResult> {
  return asService((db) =>
    rpc<CompleteResult>(db, 'complete_notification_job', [jobId, status, error, retryInSeconds]),
  );
}

export function registerToken(
  userId: string,
  token: string,
  platform = 'android',
  label: string | null = null,
): Promise<Record<string, unknown>> {
  return asUser(userId, (db) => rpcRow(db, 'register_push_token', [token, platform, label]));
}

/** Time travel: a scheduled announcement becomes due one second ago. */
export async function makeAnnouncementDue(id: string): Promise<void> {
  await admin.query(
    "update public.announcements set scheduled_for = now() - interval '1 second' where id = $1",
    [id],
  );
}

/** All notifications (superuser view), optionally filtered, ordered for stable comparisons. */
export async function notifications(where = 'true', params: unknown[] = []): Promise<NotificationRow[]> {
  const { rows } = await admin.query<NotificationRow>(
    `select * from public.notifications where ${where} order by kind, user_id, created_at`,
    params,
  );
  return rows;
}

/** Sorted recipient ids of `kind` for a session or announcement. */
export async function recipients(kind: NotificationKind, relatedId: string): Promise<string[]> {
  const { rows } = await admin.query<{ user_id: string }>(
    `select user_id from public.notifications
     where kind = $1 and (related_session_id = $2 or related_announcement_id = $2)
     order by user_id`,
    [kind, relatedId],
  );
  return rows.map((row) => row.user_id);
}

export async function jobs(where = 'true', params: unknown[] = []): Promise<JobRow[]> {
  const { rows } = await admin.query<JobRow>(
    `select * from public.notification_delivery_jobs where ${where} order by created_at, id`,
    params,
  );
  return rows;
}

export const sorted = (ids: string[]): string[] => [...ids].sort();
