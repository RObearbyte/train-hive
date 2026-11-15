import { addMember, admin, asUser, createCommunity, rpc } from './helpers';

/**
 * Shared fixture builder and callers for the statistics suites (`stats*.test.ts`). Not a test
 * file.
 *
 * Statistics read sessions in the past that went through the whole lifecycle (RSVPs, deadline,
 * attendance, finalization). Driving every one of them through the RPCs needs time travel at
 * every step, so seasons are arranged directly as superuser, in exactly the states the RPCs
 * leave behind (the column checks hold: deadline < start < end, completed iff finalized,
 * cancel_reason iff cancelled, going_count = going rows, every non-walk-in record has a going
 * RSVP). One suite (stats.test.ts, "real lifecycle") also goes through the real RPCs.
 * All times are computed by the database clock (`now()`), never by the test process.
 */

export type StatsWindow = '7d' | '30d' | '90d' | 'all';
export type Outcome = 'present' | 'absent' | 'unrecorded';

export interface MemberStats {
  window: StatsWindow;
  from: string | null;
  to: string;
  generated_at: string;
  timezone: string;
  community_id: string;
  user_id: string;
  membership_status: 'active' | 'removed';
  role: 'organizer' | 'member';
  joined_at: string;
  eligible: number;
  attended: number;
  absent: number;
  not_recorded: number;
  recorded: number;
  attendance_rate: number | null;
  confirmed_rsvps: number;
  missed: number;
  rsvp_going_present: number;
  rsvp_going_recorded: number;
  rsvp_reliability: number | null;
  walk_ins: number;
  monthly: { period: string; from: string; to: string; eligible: number; attended: number; attendance_rate: number | null }[];
}

export interface TrendBucket {
  period: string;
  from: string;
  to: string;
  sessions: number;
  present: number;
  incomplete_sessions: number;
  average_attendees: number | null;
}

export interface CommunityStats {
  window: StatsWindow;
  from: string | null;
  to: string;
  generated_at: string;
  timezone: string;
  community_id: string;
  completed_trainings: number;
  total_attendances: number;
  average_attendees: number | null;
  average_attendees_sessions: number;
  incomplete_sessions: number;
  rsvp_going_total: number;
  average_rsvp_participation: number | null;
  rsvp_going_present: number;
  rsvp_going_recorded: number;
  rsvp_conversion: number | null;
  active_members: number;
  members_attended: number;
  cancelled_insufficient_participation: number;
  cancelled_by_organizer: number;
  trend_unit: 'week' | 'month';
  trend: TrendBucket[];
  top_sessions: {
    session_id: string;
    title: string;
    starts_at: string;
    timezone: string;
    present: number;
    min_participants: number;
    going_count: number;
  }[];
}

export interface SummaryRow {
  user_id: string;
  display_name: string;
  role: 'organizer' | 'member';
  joined_at: string;
  eligible: number;
  attended: number;
  absent: number;
  not_recorded: number;
  attendance_rate: number | null;
  confirmed_rsvps: number;
  missed: number;
  rsvp_going_present: number;
  rsvp_going_recorded: number;
  rsvp_reliability: number | null;
  walk_ins: number;
}

export interface Summary {
  window: StatsWindow;
  from: string | null;
  to: string;
  generated_at: string;
  community_id: string;
  total_members: number;
  truncated: boolean;
  members: SummaryRow[];
}

export interface HistoryItem {
  session_id: string;
  title: string;
  activity_type: string;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  location_name: string;
  rsvp_response: 'going' | 'not_going' | 'no_response';
  outcome: Outcome;
  is_walk_in: boolean;
}

export interface History {
  window: StatsWindow;
  from: string | null;
  to: string;
  generated_at: string;
  items: HistoryItem[];
  has_more: boolean;
  next_before: string | null;
}

// Callers (as the given user, through the real API role) -------------------------------------

export const myStats = (userId: string, communityId: string, window: StatsWindow | string | null = '30d') =>
  asUser(userId, (db) => rpc<MemberStats>(db, 'get_my_statistics', [communityId, window]));

export const memberStats = (
  userId: string,
  communityId: string,
  targetId: string | null,
  window: StatsWindow | string | null = '30d',
) => asUser(userId, (db) => rpc<MemberStats>(db, 'get_member_statistics', [communityId, targetId, window]));

export const communityStats = (userId: string, communityId: string, window: StatsWindow | string | null = '30d') =>
  asUser(userId, (db) => rpc<CommunityStats>(db, 'get_community_statistics', [communityId, window]));

export const summary = (userId: string, communityId: string, window: StatsWindow | string | null = '30d') =>
  asUser(userId, (db) => rpc<Summary>(db, 'list_member_statistics_summary', [communityId, window]));

export const history = (
  userId: string,
  communityId: string,
  window: StatsWindow | string | null = 'all',
  limit?: number | null,
  before?: string | null,
) =>
  asUser(userId, (db) =>
    limit === undefined
      ? rpc<History>(db, 'get_my_attendance_history', [communityId, window])
      : rpc<History>(db, 'get_my_attendance_history', [communityId, window, limit, before ?? null]),
  );

/** The private payload builders with a pinned clock (superuser; for window edges and DST). */
export async function memberPayloadAt(communityId: string, userId: string, window: StatsWindow, at: string): Promise<MemberStats> {
  const { rows } = await admin.query<{ result: MemberStats }>(
    'select private.stats_member_payload($1, $2, $3, $4::timestamptz) as result',
    [communityId, userId, window, at],
  );
  return rows[0].result;
}

export async function communityPayloadAt(communityId: string, window: StatsWindow, at: string): Promise<CommunityStats> {
  const { rows } = await admin.query<{ result: CommunityStats }>(
    'select private.stats_community_payload($1, $2, $3::timestamptz) as result',
    [communityId, window, at],
  );
  return rows[0].result;
}

// Fixture builder -----------------------------------------------------------------------------

export type SessionKind = 'completed' | 'confirmed' | 'scheduled' | 'cancelled_min' | 'cancelled_organizer';

export interface SessionOptions {
  /** Start, hours before the database's now(). Ignored when `at` is given. */
  hoursAgo?: number;
  /** Absolute start (ISO instant). */
  at?: string;
  kind?: SessionKind;
  title?: string;
  min?: number;
}

export interface PersonOptions {
  role?: 'organizer' | 'member';
  status?: 'active' | 'removed';
  name?: string;
  /** Membership start, hours before now(). Default: 400 days ago. */
  joinedHoursAgo?: number;
  /** Absolute membership start (ISO instant). */
  joinedAt?: string;
}

export class SeasonBuilder {
  private constructor(
    readonly communityId: string,
    readonly timezone: string,
  ) {}

  static async create(timezone = 'Europe/Bucharest', name = 'Stats Pack'): Promise<SeasonBuilder> {
    const { communityId } = await createCommunity(name, timezone);
    return new SeasonBuilder(communityId, timezone);
  }

  /** A user with a profile and a membership that started `joinedHoursAgo` hours ago. */
  async person(options: PersonOptions = {}): Promise<string> {
    const { role = 'member', status = 'active', name = 'Season Runner', joinedHoursAgo = 400 * 24, joinedAt } = options;
    const userId = await addMember(this.communityId, { role, status, name });
    await admin.query(
      `update public.memberships
       set joined_at = coalesce($3::timestamptz, now() - $4::double precision * interval '1 hour')
       where community_id = $1 and user_id = $2`,
      [this.communityId, userId, joinedAt ?? null, joinedHoursAgo],
    );
    return userId;
  }

  /** A session in one of the lifecycle states. Ends 1 h after its start; deadline 2 h before. */
  async session(options: SessionOptions = {}): Promise<string> {
    const { hoursAgo = 24, at, kind = 'completed', title = 'Season run', min = 1 } = options;
    const { rows } = await admin.query<{ id: string }>(
      `with t as (
         select coalesce($2::timestamptz, now() - $3::double precision * interval '1 hour') as starts_at
       )
       insert into public.training_sessions (
         community_id, title, starts_at, ends_at, rsvp_deadline, timezone, location_name,
         min_participants, status, cancel_reason, decided_at, cancelled_at, attendance_finalized_at
       )
       select $1, $5, t.starts_at, t.starts_at + interval '1 hour', t.starts_at - interval '2 hours',
              $6, 'Park', $7,
              (case $4
                 when 'completed' then 'completed'
                 when 'confirmed' then 'confirmed'
                 when 'scheduled' then 'scheduled'
                 else 'cancelled' end)::public.session_status,
              (case $4
                 when 'cancelled_min' then 'insufficient_participation'
                 when 'cancelled_organizer' then 'organizer' end)::public.cancel_reason,
              case when $4 <> 'scheduled' then t.starts_at - interval '2 hours' end,
              case when $4 like 'cancelled%' then t.starts_at - interval '1 hour' end,
              case when $4 = 'completed' then t.starts_at + interval '2 hours' end
       from t
       returning id`,
      [this.communityId, at ?? null, hoursAgo, kind, title, this.timezone, min],
    );
    return rows[0].id;
  }

  /** An RSVP row (going ones are counted into going_count). */
  async rsvp(sessionId: string, userId: string, response: 'going' | 'not_going' | 'no_response'): Promise<void> {
    await admin.query(
      `insert into public.training_rsvps (session_id, community_id, user_id, response)
       values ($1, $2, $3, $4)`,
      [sessionId, this.communityId, userId, response],
    );
    if (response === 'going') {
      await admin.query('update public.training_sessions set going_count = going_count + 1 where id = $1', [sessionId]);
    }
  }

  /** An attendance record of a member with a going RSVP (as record_attendance / finalize leave it). */
  async mark(sessionId: string, userId: string, status: Outcome): Promise<void> {
    await admin.query(
      `insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going, is_walk_in)
       values ($1, $2, $3, $4, true, false)`,
      [sessionId, this.communityId, userId, status],
    );
  }

  /** Going RSVP plus a record with that outcome. */
  async going(sessionId: string, userId: string, status: Outcome): Promise<void> {
    await this.rsvp(sessionId, userId, 'going');
    await this.mark(sessionId, userId, status);
  }

  /** A walk-in (present, no going RSVP), as add_walk_in_attendee leaves it. */
  async walkIn(sessionId: string, userId: string): Promise<void> {
    await admin.query(
      `insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going, is_walk_in)
       values ($1, $2, $3, 'present', false, true)`,
      [sessionId, this.communityId, userId],
    );
  }
}

/**
 * The reference season (Europe/Bucharest). Expected numbers are derived by hand in
 * stats.test.ts. Hours are before now():
 *
 *  S7   960 h (40 d)  completed  A going present, B going present
 *  S1   480 h (20 d)  completed  A, B, R, O going: A present, B absent, R present, O present;
 *                                W walk-in present
 *  S2   360 h (15 d)  completed  A going present; B going, record unrecorded; W not_going
 *  S8   288 h (12 d)  completed  B going, record unrecorded (nothing marked: incomplete)
 *  S3   120 h ( 5 d)  completed  A going present, B going absent, L going present;
 *                                W walk-in present; N (joined after the start) walk-in present
 *  S4    72 h         cancelled (insufficient participation), A going
 *  S5    48 h         cancelled by the organizer
 *  S6    24 h         confirmed, not finalized, A going present
 *
 * People: O organizer, A/B/W members, L joined 240 h (10 d) ago, N joined 119 h ago (after S3
 * started), R removed (member before every session).
 */
export async function referenceSeason() {
  const season = await SeasonBuilder.create('Europe/Bucharest');
  const O = await season.person({ role: 'organizer', name: 'Olga Organizer' });
  const A = await season.person({ name: 'Ana Always' });
  const B = await season.person({ name: 'Bogdan Busy' });
  const W = await season.person({ name: 'Wanda Walkin' });
  const L = await season.person({ name: 'Liviu Late', joinedHoursAgo: 240 });
  const N = await season.person({ name: 'Nora New', joinedHoursAgo: 119 });
  const R = await season.person({ name: 'Radu Removed', status: 'removed' });

  const S7 = await season.session({ hoursAgo: 960, title: 'S7' });
  await season.going(S7, A, 'present');
  await season.going(S7, B, 'present');

  const S1 = await season.session({ hoursAgo: 480, title: 'S1' });
  await season.going(S1, A, 'present');
  await season.going(S1, B, 'absent');
  await season.going(S1, R, 'present');
  await season.going(S1, O, 'present');
  await season.walkIn(S1, W);

  const S2 = await season.session({ hoursAgo: 360, title: 'S2' });
  await season.going(S2, A, 'present');
  await season.going(S2, B, 'unrecorded');
  await season.rsvp(S2, W, 'not_going');

  const S8 = await season.session({ hoursAgo: 288, title: 'S8' });
  await season.going(S8, B, 'unrecorded');

  const S3 = await season.session({ hoursAgo: 120, title: 'S3' });
  await season.going(S3, A, 'present');
  await season.going(S3, B, 'absent');
  await season.going(S3, L, 'present');
  await season.walkIn(S3, W);
  await season.walkIn(S3, N);

  const S4 = await season.session({ hoursAgo: 72, title: 'S4', kind: 'cancelled_min', min: 5 });
  await season.rsvp(S4, A, 'going');
  const S5 = await season.session({ hoursAgo: 48, title: 'S5', kind: 'cancelled_organizer' });
  const S6 = await season.session({ hoursAgo: 24, title: 'S6', kind: 'confirmed' });
  await season.going(S6, A, 'present');

  return {
    season,
    communityId: season.communityId,
    people: { O, A, B, W, L, N, R },
    sessions: { S1, S2, S3, S4, S5, S6, S7, S8 },
  };
}
