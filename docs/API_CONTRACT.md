# TrainHive — Backend contract (Milestone 1)

The contract between `supabase/` and `src/`. Change it here first, then in code.
Hand-written TypeScript types mirroring this file live in `src/lib/database.types.ts`.

## Conventions

- Every function: `security definer`, `set search_path = ''`. Hosted Supabase grants execute on new public functions to `anon`, `authenticated` and `service_role` by default, so every function must `revoke all ... from public, anon, authenticated, service_role` and then grant exactly one role (`authenticated` unless stated). Internal helpers live in the `private` schema.
- Caller identity is always `auth.uid()`; no function accepts a user id for "who am I".
- **Errors**: mutations `raise exception using errcode = 'P0001', message = '<code>'`. The client maps the message code to text. Invitation functions instead **return** `{ "ok": false, "error": "<code>" }` so the rate-limit record survives.
- Common error codes: `not_authenticated`, `not_a_member`, `forbidden`, `not_found`, `validation_failed:<field>`.
- Do not depend on `pg_cron` existing: schedule jobs inside `do $$ ... if exists (select 1 from pg_available_extensions where name = 'pg_cron') ... $$`.
- `pgcrypto` is available (`extensions` schema on Supabase; tests install it into `extensions` too).

## Enums

- `membership_role`: `organizer`, `member`
- `membership_status`: `active`, `removed`
- `session_status`: `scheduled`, `confirmed`, `cancelled`, `completed`
- `cancel_reason`: `insufficient_participation`, `organizer`
- `rsvp_response`: `going`, `not_going`, `no_response`

## Tables (all in `public`, RLS enabled, **select-only** for `authenticated`)

| Table | Columns | Who can select |
|---|---|---|
| `communities` | `id uuid pk`, `name text`, `timezone text`, `created_at` | active members |
| `profiles` | `id uuid pk → auth.users`, `display_name text (2–40 chars, trimmed)`, `created_at`, `updated_at` | self, and users sharing an active community |
| `memberships` | `id`, `community_id`, `user_id`, `role`, `status`, `joined_at`; unique `(community_id, user_id)` | active members of that community |
| `invitation_codes` | `id`, `community_id`, `code text unique`, `role`, `created_by?` (null for bootstrap codes), `expires_at?`, `max_redemptions?`, `redemption_count`, `revoked_at?`, `created_at` | organizers of that community |
| `invitation_redemptions` | `id`, `invitation_id`, `user_id`, `redeemed_at`; unique `(invitation_id, user_id)` | organizers of that community |
| `invitation_attempts` | `id`, `user_id`, `attempted_at`, `success` | nobody (no policy) |
| `activity_types` | `key text pk`, `label text`, `sort_order int` | any authenticated user |
| `training_sessions` | below | active members of that community |
| `training_rsvps` | `id`, `session_id`, `community_id`, `user_id`, `response`, `responded_at`, `updated_at`; unique `(session_id, user_id)` | active members of that community |

`training_sessions` columns: `id`, `community_id`, `organizer_id → profiles`, `title` (1–80), `description?`, `activity_type → activity_types.key` (default `other`), `starts_at timestamptz`, `ends_at?`, `rsvp_deadline timestamptz not null`, `timezone text` (IANA), `location_name` (1–120), `address?`, `latitude?`, `longitude?`, `map_url?`, `meeting_instructions?`, `min_participants int ≥ 1`, `max_participants int?`, `going_count int default 0`, `status session_status default 'scheduled'`, `cancel_reason?`, `decided_at?`, `cancelled_at?`, `cancelled_by?`, `created_at`, `updated_at`.

Table checks: `rsvp_deadline < starts_at` (strict), `ends_at > starts_at`, `max_participants >= min_participants`, `going_count >= 0`, latitude/longitude ranges, `cancel_reason` set iff `status = 'cancelled'`.

Seeded `activity_types`: `running`, `trail_running`, `strength`, `functional_fitness`, `ocr`, `other`.

Realtime publication `supabase_realtime` includes `training_sessions`, `training_rsvps`, `memberships`.

Helper functions (stable, security definer): `is_active_member(community_id uuid) → boolean`, `is_organizer(community_id uuid) → boolean`.

## RPCs

### Invitations and onboarding

`preview_invitation(p_code text) → jsonb`
- `{ ok: true, community_name, role }` or `{ ok: false, error }`. Counts toward the rate limit. Does not redeem.

`redeem_invitation(p_code text, p_display_name text) → jsonb`
- Success: `{ ok: true, community_id, membership_id, role, already_member }`.
- Errors: `invalid_code`, `expired`, `revoked`, `exhausted`, `rate_limited`, `invalid_display_name`, `not_authenticated`.
- Atomic: locks the invitation row; increments `redemption_count` only when a new membership is created. Upserts the profile. If the caller is already an active member, returns `already_member: true` and does not consume a redemption. A `removed` member cannot rejoin by code (`invalid_code`).
- Codes are matched case-insensitively, ignoring spaces and dashes.
- Rate limit: at most 5 failed attempts per user per 15 minutes across `preview_invitation` and `redeem_invitation`; then `rate_limited`.

`create_invitation(p_community_id uuid, p_expires_at timestamptz default null, p_max_redemptions int default null) → invitation_codes`
- Organizer only. Always grants role `member`. Code: 8 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ`, generated from `extensions.gen_random_bytes`.

`revoke_invitation(p_invitation_id uuid) → invitation_codes`
- Organizer of that community only. Idempotent.

`admin_create_community(p_name text, p_timezone text) → jsonb` — **granted to `service_role` only**
- Creates the community and a single-use organizer invitation valid for 7 days. Returns `{ community_id, organizer_code }`. Validates the timezone against `pg_timezone_names`.

`update_display_name(p_display_name text) → profiles`

### Trainings

`create_training(p_community_id uuid, p_input jsonb) → training_sessions`
`update_training(p_session_id uuid, p_input jsonb) → training_sessions`
- Organizer only. `p_input` keys (snake_case, same names as columns): `title`, `description`, `activity_type`, `starts_at`, `ends_at`, `rsvp_deadline`, `timezone`, `location_name`, `address`, `latitude`, `longitude`, `map_url`, `meeting_instructions`, `min_participants`, `max_participants`.
- Create: `rsvp_deadline` defaults to `starts_at - interval '2 hours'`; `timezone` defaults to the community's; `starts_at` and `rsvp_deadline` must be in the future.
- Update is a full replace of the editable fields (client sends the whole form). Rules by status:
  - `scheduled`: everything editable. `max_participants` may not go below `going_count` (`validation_failed:max_participants`). New `rsvp_deadline` must be in the future.
  - `confirmed`: descriptive fields and `starts_at` / `ends_at` (future only) editable; `rsvp_deadline`, `min_participants`, `max_participants` are frozen (`validation_failed:<field>` if changed).
  - `cancelled`, `completed`: `session_not_editable`.
- Validation failures: `validation_failed:<field>`.

`cancel_training(p_session_id uuid) → training_sessions`
- Organizer only. `scheduled` or `confirmed` → `cancelled`, `cancel_reason = 'organizer'`. Already cancelled: returns the row unchanged. `completed`: `session_not_cancellable`.

`set_rsvp(p_session_id uuid, p_response rsvp_response) → jsonb`
- Returns `{ response, going_count, status }`.
- Locks the session row `FOR UPDATE`, then upserts the RSVP and adjusts `going_count` by the delta. Setting the same response again is a no-op that still succeeds (idempotent).
- Errors: `not_a_member`, `not_found`, `rsvp_closed` (status is not `scheduled`, or `now() >= rsvp_deadline`), `session_full` (switching to `going` when `going_count >= max_participants`).

`finalize_due_sessions() → integer` — **granted to `service_role` only**; scheduled with pg_cron every minute when available
- For each `scheduled` session with `rsvp_deadline <= now()` (`FOR UPDATE SKIP LOCKED`): `going_count >= min_participants` → `confirmed`; else `cancelled` with `insufficient_participation`. Sets `decided_at`. Returns the number of sessions decided. Running it again changes nothing.

## Reads (plain selects under RLS)

- My memberships: `memberships` filtered by `user_id = auth.uid()`, joined to `communities`.
- Upcoming / past sessions: `training_sessions` by `community_id`, ordered by `starts_at`.
- My RSVPs: `training_rsvps` by `user_id`.
- Participants: `training_rsvps` joined to `profiles(display_name)` for a session.

---

# Milestone 2 — Attendance

RSVP is intention; attendance is what actually happened. Migrations `20261115000100_attendance_schema.sql`, `20261115000200_attendance_rpcs.sql`. Same conventions as above.

## Enum

- `attendance_status`: `present`, `absent`, `unrecorded`. **`unrecorded` is not `absent`**: it means nobody marked the member. A member with no attendance row is treated as `unrecorded` everywhere.

## Tables

| Table | Columns | Who can select |
|---|---|---|
| `attendance_records` | `id`, `session_id`, `community_id`, `user_id → profiles` (cascade), `status attendance_status` (default `unrecorded`), `recorded_by? → profiles` (set null; the organizer who created the row), `recorded_at`, `updated_at` (last status change), `had_rsvp_going boolean` (the member's RSVP was `going` when the row was created), `is_walk_in boolean`; unique `(session_id, user_id)`; composite FK `(session_id, community_id) → training_sessions(id, community_id)`; check `had_rsvp_going <> is_walk_in` (every row is either a going RSVP or a walk-in) | the member themself (while an active member), and active organizers of that community |
| `attendance_audit_log` | `id`, `session_id`, `community_id`, `user_id → profiles` (cascade), `changed_by? → profiles` (set null), `changed_at`, `old_status`, `new_status` (both `attendance_status`, never equal; `old_status = 'unrecorded'` when there was no row), `reason text?` (1–200 chars), `action` in `record` / `correct` / `walk_in_add`; same composite FK | active organizers of that community |

`training_sessions` gains `attendance_finalized_at timestamptz?` and `attendance_finalized_by uuid? → profiles` (set null). Check: `status = 'completed'` iff `attendance_finalized_at is not null`.

Why members see only their own records: an RSVP is a public intention the participant list needs; attendance (especially `absent`) is a personal record only the member and the organizers need.

Realtime publication `supabase_realtime` adds `attendance_records` (events pass RLS). The audit log is not published. The `completed` transition arrives through the `training_sessions` row.

## Lifecycle

- Attendance can be taken once a session is `confirmed` **and has ended**: `coalesce(ends_at, starts_at) <= clock_timestamp()` on the server.
- **Nothing auto-completes.** A confirmed session that has ended stays `confirmed` until an organizer calls `finalize_attendance`, which moves it to `completed`. `finalize_due_sessions()` never touches `confirmed` or `completed` sessions.
- `completed` sessions accept corrections (audited). `update_training` → `session_not_editable`, `cancel_training` → `session_not_cancellable`.
- `scheduled` and `cancelled` sessions never take attendance (`session_not_confirmed`). Cancelling a confirmed session is still allowed while it is not completed; any attendance rows it already had stay but the session is `cancelled`. **Attendance statistics must only count sessions with `status = 'completed'`.**
- Removed members: their records and audit rows stay; existing records can still be corrected; no new record can be created for them (`attendee_not_a_member`). Deleting a user's account deletes their records and audit rows; rows they authored keep `recorded_by` / `changed_by` / `attendance_finalized_by` = null.

## RPCs (all `authenticated`, organizer of the session's community only)

Common errors for all four: `not_authenticated`, `not_found` (unknown session), `forbidden` (caller is not an active organizer of the session's community — members, outsiders, organizers of other communities).

`record_attendance(p_session_id uuid, p_user_id uuid, p_status attendance_status, p_reason text default null) → attendance_records`
- `p_user_id` is the attendee (the caller is `auth.uid()`). Sets the member's status, creating the row if needed.
- Session checks: `session_not_confirmed` (status is not `confirmed` / `completed`), `session_not_ended`.
- A new row needs an active member (`attendee_not_a_member`) with a `going` RSVP (`no_going_rsvp`; members without one are added with `add_walk_in_attendee`). A new row snapshots `had_rsvp_going = true`.
- Same status as now (a missing row counts as `unrecorded`): no change, no audit row, returns the row (creates an `unrecorded` row if none existed).
- A real change writes one audit row: `record` for the first mark of that member while the session is `confirmed`; `correct` for every later change and for every change once the session is `completed`. `unrecorded` may be set to clear a mark.
- `p_reason`: optional, trimmed, blank = null, > 200 chars → `validation_failed:reason`. Also `validation_failed:user_id`, `validation_failed:status` for nulls.

`add_walk_in_attendee(p_session_id uuid, p_user_id uuid) → attendance_records`
- Same session checks. If the member already has a row (any status, walk-in or not), returns it unchanged (idempotent, no audit row).
- Otherwise: active member required (`attendee_not_a_member`); a member with a `going` RSVP is refused (`attendee_has_going_rsvp`, use `record_attendance`). Creates `present`, `is_walk_in = true`, `had_rsvp_going = false`; audit `walk_in_add` (`unrecorded → present`).

`finalize_attendance(p_session_id uuid) → training_sessions`
- `completed` already: returns the row unchanged (idempotent; the first finalization's time and organizer stand).
- Errors: `session_not_confirmed` (scheduled / cancelled), `session_not_ended`.
- Creates an `unrecorded` row (`had_rsvp_going = true`, no audit row) for every **active** member with a `going` RSVP and no row, so history lists them. Never converts `unrecorded` to `absent`. Sets `status = 'completed'`, `attendance_finalized_at`, `attendance_finalized_by`.

`get_attendance_sheet(p_session_id uuid) → jsonb` — read-only, any session status
```
{ session_id, status, ended: boolean, attendance_finalized_at, attendance_finalized_by,
  entries: [ { user_id, display_name, membership_status ('active' | 'removed' | null),
               rsvp_response (no_response when none), attendance_status (unrecorded when no row),
               has_record, is_walk_in, had_rsvp_going (null when no row), updated_at (null when no row) } ] }
```
- Entries: every active member with a `going` RSVP, plus everyone who has a record (including removed members). Ordered by display name. Members get `forbidden`.

New error codes: `session_not_confirmed`, `session_not_ended`, `attendee_not_a_member`, `no_going_rsvp`, `attendee_has_going_rsvp`, `validation_failed:reason`, `validation_failed:user_id`, `validation_failed:status`.

Concurrency: every attendance writer locks the session row (`FOR UPDATE`) after key-share locks on the caller's and attendee's profiles and a share lock on the attendee's membership (Milestone 1 lock order), so concurrent marks produce one row per member and one audit row per real change, and account deletion or member removal cannot deadlock with them.

## Reads (plain selects under RLS)

- My attendance history: `attendance_records` where `user_id = auth.uid()`, joined to `training_sessions` (filter `status = 'completed'` for statistics).
- Organizer: the sheet RPC above; the audit trail of a session: `attendance_audit_log` by `session_id`, ordered by `changed_at`, joined to `profiles` for `changed_by` names.
## Milestone 2 amendments (M2-B2, from QA Q3-1, Q3-2, O1, O2)

These rules supersede the matching sentences above. Implemented in `20261115000200_attendance_rpcs.sql`, which also replaces the Milestone 1 `update_training` and `cancel_training` (`create or replace`, same signatures and grants).

- **"Ended" for attendance (O2).** One server rule, `private.session_ended(starts_at, ends_at, at)`: `coalesce(ends_at, starts_at + interval '2 hours') <= at`. A session **without `ends_at` counts as ended 2 hours after its start**, so attendance cannot be taken or finalized while the training is still running. Used by `record_attendance`, `add_walk_in_attendee`, `finalize_attendance`, the sheet's `ended` flag and the `update_training` freeze below. All of them use the real server time (`clock_timestamp()`); the sheet's `ended` no longer uses the statement time. Clients that predict "ended" from their own clock (cue, hint text) must apply the same 2-hour rule; the server stays the authority.
- **Time freeze in `update_training` (Q3-1).** Once a `confirmed` session has ended (rule above) **or has any `attendance_records` row** (any status), `starts_at` and `ends_at` are frozen: a change raises `validation_failed:starts_at` / `validation_failed:ends_at` (compared as instants at millisecond precision; adding or clearing `ends_at` is a change). The stored values are kept. Descriptive fields (`title`, `description`, `activity_type`, `timezone`, location fields, `meeting_instructions`) stay editable. `rsvp_deadline`, `min_participants`, `max_participants` stay frozen as before. Before that point the Milestone 1 rule is unchanged (the start may move, to the future only).
- **`cancel_training` and attendance (O1).** A session with any attendance record whose status is `present` or `absent` (walk-ins included) can no longer be cancelled: new error **`session_has_attendance`**. The organizer corrects attendance instead. `unrecorded` rows (never marked, or a mark cleared again) do not block. Order of checks: already `cancelled` → returns the row unchanged; `completed` → `session_not_cancellable`; then `session_has_attendance`.
- **Role re-check after the lock (Q3-2).** `record_attendance`, `add_walk_in_attendee`, `finalize_attendance`, `update_training` and `cancel_training` check the caller's organizer role before and again after taking the session `FOR UPDATE` lock. An organizer removed or demoted while the call waited gets `forbidden` and nothing is written. (`get_attendance_sheet` takes no lock and checks once.)

New error code: `session_has_attendance`.

---

# Milestone 3 — Communications and notifications

Announcements (organizer to members, no chat), in-app notifications, push tokens, push preferences and the push outbox that the Edge Function (M3-B2) drains. Migrations `20261115000300_notifications_schema.sql`, `20261115000400_notifications_rpcs.sql`, `20261115000500_schedule_notifications.sql`. Same conventions as above. Push delivery itself is not part of M3-B1.

## Enums

- `announcement_status`: `scheduled`, `published`, `cancelled`
- `notification_kind`: `training_created`, `training_updated`, `training_confirmed`, `training_cancelled`, `training_reminder`, `announcement_published`

## Tables

| Table | Columns | Who can select |
|---|---|---|
| `announcements` | `id`, `community_id`, `author_id? → profiles` (set null), `title` (1–100, single line, trimmed), `body` (1–2000, trimmed), `status`, `scheduled_for?`, `published_at?`, `cancelled_at?`, `created_at`, `updated_at`. Checks: `scheduled` ⇒ `scheduled_for` set and `published_at` null; `published` ⇔ `published_at` set; `cancelled` ⇔ `cancelled_at` set. "In the future" is checked by the RPCs. | active members: `published` ones; active organizers: all of their community |
| `announcement_reads` | `announcement_id` (cascade), `user_id → profiles` (cascade), `read_at`; pk both | own rows only |
| `notifications` | `id`, `user_id` (**no FK**, see below), `community_id`, `kind`, `title` (≤ 200), `body` (≤ 500), `deep_link` (relative route), `related_session_id?` (cascade), `related_announcement_id?` (cascade), `dedupe_key`, `created_at`, `read_at?`; **unique `(user_id, dedupe_key)`**; check: announcement kinds have only `related_announcement_id`, training kinds only `related_session_id` | own rows, while an active member of that community |
| `notification_delivery_jobs` | `id`, `notification_id` (unique, cascade), `user_id`, `status` in `pending/sending/sent/failed/dead/skipped`, `attempts`, `max_attempts` (5), `next_attempt_at`, `expires_at`, `last_error?`, `locked_at?`, `locked_by?`, `created_at`, `sent_at?` | **nobody** (no grant, no policy) |
| `device_push_tokens` | `id`, `user_id → profiles` (cascade), `token` (unique; `ExponentPushToken[…]` or `ExpoPushToken[…]`, ≤ 200), `platform` in `ios/android/web`, `device_label?` (≤ 80), `created_at`, `last_seen_at`, `invalidated_at?`, `last_error?` | own rows only |
| `notification_preferences` | `user_id pk → profiles` (cascade), `push_enabled`, `training_reminders`, `announcements`, `training_updates` (all default true), `updated_at`. No row = all true. | own row only |

Deep links: `/trainings/<session_id>` and `/announcements/<announcement_id>` (the mobile app maps both; an announcement route may simply open the Activity tab focused on it).

Why `notifications.user_id` has no foreign key: training notifications are written by triggers while the session row is locked. A foreign key would key-share-lock each recipient's profile at that moment, the reverse of an account deletion's lock order (profile → memberships → RSVPs → session), and deadlock with it (pinned by a mutation test). Instead a deferred constraint trigger on `profiles` deletes a deleted user's notifications at the deletion's commit (jobs cascade), RLS never shows a row without an active membership, and `purge_old_notification_data()` removes any row that raced with the deletion.

Realtime publication `supabase_realtime` adds `announcements` and `notifications` (RLS filters events per subscriber; subscribe with `user_id=eq.<uid>` / `community_id=eq.<id>` anyway). DELETE events carry only the primary key and are not RLS-filtered; rows are only deleted by cascades, account deletion and the purge. Reads, tokens, preferences and jobs are not published.

## Notification kinds

All recipients are **active** members of the community at the time of the event. The actor (`auth.uid()` of the editing / cancelling organizer, the announcement author) is never notified of their own action. **RSVP changes never notify anyone.** In-app notifications are always stored; push preferences only affect push.

| Kind | Fired when | Recipients | Dedupe key | Deep link |
|---|---|---|---|---|
| `training_created` | `create_training` (trigger AFTER INSERT) | all except the creator | `training_created:<session>` | `/trainings/<id>` |
| `training_updated` | a **material** change of a `scheduled` / `confirmed` session: `starts_at`, `ends_at` (compared at ms precision), `title`, `location_name`, `address`, `latitude`, `longitude`. Description, instructions, map link, activity type, limits: silent. | all except the editor and members whose RSVP is `not_going` | `training_updated:<session>:<transaction start, epoch µs>` (each edit notifies once; an identical resend changes nothing and fires nothing) | `/trainings/<id>` |
| `training_confirmed` | finalizer `scheduled → confirmed` | members with a `going` RSVP, plus the session's organizer | `training_confirmed:<session>` | `/trainings/<id>` |
| `training_cancelled` | `cancel_training` or finalizer (insufficient participation) | all except members with `not_going` and except the canceller (the organizer is included for a finalizer cancel) | `training_cancelled:<session>` | `/trainings/<id>` |
| `training_reminder` | `enqueue_due_training_reminders()`: **24h** — starts in (23h, 24h] and is `scheduled` or `confirmed`; **2h** — starts in (1h, 2h] and is `confirmed`, skipped for a member who got this session's confirmation within the last hour | members with a `going` RSVP | `training_reminder_24h:<session>:<starts_at epoch s>` / `training_reminder_2h:…` (a rescheduled session gets fresh reminders) | `/trainings/<id>` |
| `announcement_published` | published now, published by `update_announcement(…, null)`, or by `publish_due_announcements()` | all except the author | `announcement:<announcement>` | `/announcements/<id>` |

Training notifications come from triggers on `training_sessions`, so they fire once per real transition whichever path makes it, and a finalizer re-run that changes nothing fires nothing. Every notification goes through `private.enqueue_notification` (insert `on conflict (user_id, dedupe_key) do nothing`; a push job only for rows really inserted), so re-runs and races never produce a second notification or job.

## RPCs (authenticated)

Common errors: `not_authenticated`, `forbidden`, `not_found`, `not_a_member`, `validation_failed:<field>`.

`create_announcement(p_community_id uuid, p_title text, p_body text, p_scheduled_for timestamptz default null) → announcements`
- Active organizer of the community (else `forbidden`, also for unknown communities). Null time = publish now (notifies). Otherwise `scheduled_for` must be in the future and at most 365 days ahead (`validation_failed:scheduled_for`). `validation_failed:title` / `:body`. Share-locks the organizer's membership: a concurrent removal or demotion waits; one that commits first gives `forbidden`.

`update_announcement(p_id uuid, p_title text, p_body text, p_scheduled_for timestamptz) → announcements`
- Organizer of its community, only while `scheduled` (`announcement_not_editable`). Full replace; null time publishes now (`scheduled_for` keeps the last planned time).

`cancel_announcement(p_id uuid) → announcements`
- Organizer, while `scheduled`. Already cancelled: returned unchanged. Published: `announcement_not_cancellable`. Update and cancel re-check the organizer role after the row lock.

`mark_announcement_read(p_id uuid) → announcement_reads` — published announcement of a community the caller is active in (`not_found` otherwise); idempotent (first `read_at` stands); also marks its `announcement_published` notification read.
`mark_announcements_read(p_community_id uuid) → integer` — all published ones; returns how many were newly marked; also marks their notifications. `not_a_member`.
`unread_announcement_count(p_community_id uuid) → integer` — published, not authored by the caller, no read row. Client equivalent: published announcements of the community without an own `announcement_reads` row, excluding `author_id = me`.
`mark_notification_read(p_id uuid) → notifications` — own notification of an active community (`not_found` otherwise); idempotent.
`mark_all_notifications_read(p_community_id uuid) → integer` — returns how many changed. `not_a_member`.
Unread notifications: `select count(*) from notifications where community_id = … and read_at is null` (RLS limits it to the caller).

`register_push_token(p_token text, p_platform text, p_device_label text default null) → device_push_tokens`
- Upsert by token: refreshes `last_seen_at`, platform and label, clears `invalidated_at` / `last_error`. **A token registered by another user is re-assigned to the caller**: an Expo token identifies one app installation, and the account now signed in there is the one that must receive its pushes (the previous one signed out, or its anonymous session was replaced); the previous user simply stops receiving on that device. At most 10 tokens per user (least recently seen dropped), serialized on the caller's profile row. Errors: `validation_failed:token` (format, ≤ 200), `validation_failed:platform`, `validation_failed:device_label` (≤ 80), `not_a_member` (no profile yet). Call it on every app start when permission is granted.
`unregister_push_token(p_token text) → boolean` — removes the caller's own token (sign-out, push turned off); someone else's token is never touched; idempotent.
`get_notification_preferences() → notification_preferences` — defaults (all true, `updated_at` null) when never set.
`set_notification_preferences(p_push_enabled, p_training_reminders, p_announcements, p_training_updates boolean default null) → notification_preferences` — null keeps a value. `not_a_member` without a profile.

When push permission is denied on the device the app registers no token; every notification still exists in-app and the dispatcher completes its job as `skipped` (`no_tokens`).

## Scheduled (service_role only; pg_cron when available, same guarded pattern as the finalizer)

| Job | Schedule | Function |
|---|---|---|
| `trainhive_publish_due_announcements` | every minute | `publish_due_announcements() → integer` — `scheduled` with `scheduled_for <= now`, `FOR UPDATE SKIP LOCKED`, `published_at = clock_timestamp()`; idempotent; an organizer cancel holding the row wins (skipped), a cancel arriving after the publish gets `announcement_not_cancellable`. |
| `trainhive_training_reminders` | every minute | `enqueue_due_training_reminders() → integer` (notifications inserted). Hour-wide windows so a missed tick still fires once; `FOR NO KEY UPDATE SKIP LOCKED` on sessions. |
| `trainhive_purge_notification_data` | daily 03:17 | `purge_old_notification_data() → integer` — deletes `sent/skipped/dead` jobs older than 30 days, `pending/failed` jobs expired more than 3 days ago, and notifications whose user has no profile. In-app notifications are kept. |

Without pg_cron (local tests) these are no-ops; tests call the functions directly.

## Dispatcher contract (Edge Function, M3-B2; all service_role)

Job lifecycle: `pending → sending → sent | skipped | dead`; `sending → failed → (retry due) sending …`. `expires_at`: training notifications at the training's end (`ends_at`, or start + 2h; reminders: the start), announcements after 3 days; always between 15 minutes and 3 days after creation.

`claim_notification_jobs(p_limit int default 100, p_worker text) → setof jsonb`
- First turns into `dead` every expired `pending/failed` job and every `sending` job abandoned for over 5 minutes that has used all attempts (`last_error` `expired` / `abandoned while sending`).
- Then claims up to `p_limit` (1–1000) jobs that are `pending`, `failed` with `next_attempt_at` due, or `sending` for over 5 minutes (a crashed worker), with `FOR UPDATE SKIP LOCKED` (concurrent workers never get the same job): `status = sending`, `locked_at`, `locked_by = p_worker` (required, ≤ 100 chars), `attempts + 1`.
- Each row: `{ job_id, notification_id, user_id, kind, title, body, deep_link, community_id, related_session_id, related_announcement_id, attempts, max_attempts, unread_count, push_allowed, skip_reason, tokens }`. `tokens` = the user's tokens with `invalidated_at` null, most recently seen first. Preferences are applied **here, at send time** (the latest choice wins): `tokens` is empty and `push_allowed` false when the user is no longer an active member (`skip_reason: not_a_member`), has `push_enabled = false` (`push_disabled`), or turned off the kind's category (`category_disabled`: `training_reminders` for `training_reminder`, `announcements` for `announcement_published`, `training_updates` for the other training kinds). Allowed but no devices: `skip_reason: no_tokens`.

`complete_notification_job(p_job_id uuid, p_status text, p_error text default null, p_retry_in_seconds int default null) → jsonb`
- `p_status`: `sent` (Expo accepted it for at least one device), `skipped` (nothing to send), `failed` (transient: retried after `p_retry_in_seconds` (0–86400) or `30 s · 2^(attempts−1)` capped at 1 h; becomes `dead` once `attempts = max_attempts`), `dead` (permanent).
- Only a `sending` job changes; anything else is returned unchanged with `changed: false` (repeated or late completions are harmless; a late completion from a worker whose job was reclaimed is accepted once). Returns `{ job_id, status, attempts, max_attempts, next_attempt_at, sent_at, changed }`. Errors: `validation_failed:status`, `validation_failed:retry_in_seconds`, `not_found`.

`invalidate_push_tokens(p_tokens text[], p_error text default 'DeviceNotRegistered') → integer` — sets `invalidated_at`; those tokens are never returned again until the device registers them again.

Expo push API behaviour assumed (to be re-checked against the Expo docs in M3-B2):
- `POST https://exp.host/--/api/v2/push/send` with an array of messages `{ to, title, body, data: { url: deep_link, notification_id, kind }, sound: 'default', badge: unread_count }`. At most **100 messages per request**; Expo also limits a project to about **600 notifications per second** (the task's "600 per request" is read as this per-second limit). One message per token; chunk at 100.
- The response holds one **push ticket** per message: `status: ok` with a ticket `id`, or `status: error` with `details.error`. `DeviceNotRegistered` → `invalidate_push_tokens` for that token. `MessageTooBig` / `InvalidCredentials` / malformed → `dead`. HTTP 429 / 5xx / network errors → `failed` (pass `Retry-After` as `p_retry_in_seconds`).
- A job counts as `sent` when at least one of the user's tokens got an `ok` ticket (no duplicate pushes to devices that already received it); if every token failed transiently → `failed`.
- **Push receipts** (`POST /--/api/v2/push/getReceipts` with ticket ids, ready ~15 minutes later, kept ~24 h) can also report `DeviceNotRegistered`. M3-B1 stores no ticket ids; M3-B2 either checks receipts within its own run or adds a ticket column in its own migration.
- Delivery is at-least-once: a worker that crashes after sending but before completing is reclaimed after 5 minutes and may push twice. The in-app notification is never duplicated.

## Milestone 3, B2 notes (push dispatcher; append-only)

Implemented in `supabase/functions/dispatch-notifications/` (`dispatch.ts` pure logic, `index.ts` Deno handler), scheduled by `20261115000600_schedule_dispatch.sql`, owner guide `docs/PUSH_SETUP.md`.

Corrections to "Expo push API behaviour assumed" (checked against docs.expo.dev on 2026-11-15):
- The message `data` is `{ deepLink, notificationId, kind }` (camelCase), **not** `{ url, notification_id, kind }`. The mobile app must read `data.deepLink`. `badge` = `unread_count` is sent as an extra top-level field. Also sent: `sound: 'default'`, `channelId: 'default'` (the app must create an Android channel named `default`), `priority: 'high'`, `ttl`.
- 600/s is a project rate limit; per request the limit is 100 messages (`PUSH_TOO_MANY_NOTIFICATIONS`) and 1000 ids for receipts. Total payload at most 4 KiB.
- Ticket errors are only `DeviceNotRegistered` at ticket level in the docs; `MessageTooBig`, `MessageRateExceeded`, `MismatchSenderId`, `InvalidCredentials` are listed for receipts. The dispatcher handles all of them whichever level they arrive on. A whole-request failure is HTTP 4xx/5xx with `errors: [{code, message}]` and no `data`.
- A ticket error `message` can contain the token, so the dispatcher stores/logs only `details.error` codes.
- Status mapping: ok to at least one token = `sent` (even if another token failed transiently, to avoid duplicates); all tokens `DeviceNotRegistered` = `skipped` with `last_error` `no_valid_tokens`; any transient (network error, timeout, 429, 5xx, `MessageRateExceeded`, unknown error code, malformed response, 401/403) with nothing delivered = `failed` (honours `Retry-After`, else the RPC's backoff); `MessageTooBig` / `InvalidCredentials` / `InvalidPayload` / `MismatchSenderId` / other 4xx = `dead`. `last_error` is `transient:<codes>` or `permanent:<codes>`.
- Optional header `Authorization: Bearer <EXPO_ACCESS_TOKEN>` is sent when the secret is set (enhanced push security). Do not retry HTTP 400. Retry 429/5xx with backoff.
- Authentication of the function: header `x-dispatch-secret` compared in constant time to the function secret `DISPATCH_SECRET`; deployed with `--no-verify-jwt` (`verify_jwt = false` in config.toml); the service key is never read from the request. Method must be POST.
- Expo Go on Android does not support remote push since SDK 53; a development build is required (confirmed in the expo-notifications docs).
- `claim_notification_jobs` does not return `expires_at`, so `ttl` is a fixed default (announcements 86400 s, trainings 3600 s); the dispatcher uses `expires_at` automatically if a later migration adds it to the claimed row.

Receipts are NOT implemented: ticket ids are not stored. Wanted migration if receipt handling is required: add `expo_tickets jsonb` (array of `{id, token_id}`) and `receipts_checked_at timestamptz` to `notification_delivery_jobs` (or a small `push_tickets(ticket_id, job_id, token, created_at)` table), a `claim_receipt_checks()` / `complete_receipt_check()` RPC pair, and a second pass of the dispatcher 15 min to 24 h after sending that calls `/push/getReceipts` (up to 1000 ids) and invalidates tokens on `DeviceNotRegistered`.

Not verified (M3-B2): the real Expo Push Service, FCM delivery, a physical device, `pg_cron` + `pg_net` + Vault on the hosted project, the Deno runtime/deployment of `index.ts` (only `dispatch.ts` is run, under Node, by `supabase/tests/dispatch.test.ts`; `index.ts` is excluded from `tsc`).

## Milestone 3, B3 amendments (QA fixes Q4-1, Q4-2, Q4-4, Q4-5, Q4-6, O-1, O-2, O-3; append-only)

Migrations `20261116000100_m3_qa_fixes.sql` (functions replaced in place, same signatures and grants; privilege matrix unchanged) and `20261116000200_dispatch_timeout.sql`. No RPC signature changed.

**Read state (Q4-4).**
- `mark_all_notifications_read(p_community_id)`: marks every unread notification of the caller in that community read (as before, returns that count), **and** inserts an `announcement_reads` row for the caller for every published announcement of that community whose id is the `related_announcement_id` of a notification **this call marked**. Already-read announcements keep their first `read_at` (`on conflict do nothing`). Not touched: announcements without such a notification (e.g. published before the caller joined), other users' rows, other communities. A repeat call marks nothing and returns 0.
- `mark_notification_read(p_id)`: if the notification has a `related_announcement_id`, the caller's `announcement_reads` row for that (published, same-community) announcement is inserted too, on every call (also when the notification was already read). Idempotent.
- `mark_announcement_read` / `mark_announcements_read`: unchanged (they mark the matching notifications).
- Both functions now key-share-lock the caller's profile first (the order of an account deletion: profile, then its notifications), so they cannot deadlock with a concurrent account deletion; if the profile is already gone they raise `not_a_member` (mark-all) / `not_found` (single).

**Text (Q4-5).** `create_announcement` / `update_announcement` titles and bodies:
- **Stripped**: C0/C1 control characters (U+0001–U+0008, U+000E–U+001F, U+007F–U+009F) and bidi embedding/override/isolate controls (U+202A–U+202E, U+2066–U+2069). Titles: every whitespace run, including Unicode space separators (NBSP, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000) and U+2028/U+2029, becomes one ASCII space; then trimmed. Bodies: CR LF, CR, U+2028, U+2029 become LF; vertical tab and form feed are removed; tabs and newlines are kept; trimmed of spaces, tabs, newlines.
- **Rejected** with `validation_failed:title` / `validation_failed:body`: text that is empty after ignoring whitespace and invisible characters (zero-width U+200B–U+200D, LRM/RLM, U+2060–U+2064, U+FEFF, soft hyphen, U+034F, Hangul fillers, U+17B4/5, U+180E, braille blank U+2800, variation selectors U+FE00–U+FE0F, tag characters U+E0000–U+E007F). Invisible characters next to visible text are kept (the zero-width joiner is part of emoji). Lengths are counted after cleaning.
- Training text (`create_training` / `update_training`, `private.input_text`) is **not** changed by this; it still only trims/collapses ASCII whitespace.

**Deep links (Q4-6).** `notifications.deep_link` must match exactly `^/activity$`, `^/trainings/<uuid>$` or `^/announcements/<uuid>$` (lowercase canonical uuid). Added `not valid`, then validated; if old rows violate it the migration warns instead of failing and the check applies to new rows.

**Announcement rate limit (O-1).** `create_announcement`: at most **10 announcements per organizer per community per rolling hour** (any status, cancelled included, counted by `created_at`), else error **`announcement_rate_limited`** (raised after the organizer check, so members and outsiders still get `forbidden`). The organizer's membership is now locked `for no key update` (was `for share`), which serializes the organizer's concurrent creations so the cap is exact. `update_announcement` and `publish_due_announcements` are not limited.

**Retention (O-2).** `purge_old_notification_data()` also deletes notifications that are read and created more than 90 days ago, or unread and created more than 180 days ago; their jobs cascade. The returned count includes those notifications (not the cascaded jobs).

**Badge (O-3).** `claim_notification_jobs` `unread_count` = the user's unread notifications in communities where the user is still an active member.

**Dispatcher (Q4-1, Q4-2).**
- One run claims batches of `limit` (100) jobs until a claim returns fewer than `limit`, the time budget (40 s since the start) is used, a batch saw a transient error (HTTP 429/5xx/401/403, network, timeout, transient ticket), a job came back in the same run, or the request cap is reached.
- Requests hold at most 100 messages and never split a job (unless it alone had over 100 tokens). After each request: tokens with `DeviceNotRegistered` are invalidated, then **every job whose messages are all answered is completed immediately**.
- A whole-request rejection (HTTP 4xx other than 401/403/429, e.g. `PUSH_TOO_MANY_EXPERIENCE_IDS`) is **bisected**: halves are resent recursively down to single messages. A single message still rejected counts as `permanent:HTTP_<status>` for its job (job `dead` unless another token of it was accepted); its token is invalidated (`invalidate_push_tokens`, `p_error` = the Expo error code, e.g. `PUSH_TOO_MANY_EXPERIENCE_IDS`) **only if** the same original request also had accepted messages and the code is not `PUSH_TOO_MANY_NOTIFICATIONS` / `TOO_MANY_REQUESTS` / `UNAUTHORIZED` (so a payload bug never invalidates every token).
- Bounds: at most 60 Expo requests per run (bisection included) and no request started after 100 s. Messages that did not get a request are `transient:Deferred`; their job is completed `failed` with `p_retry_in_seconds = 0` (one attempt used; `dead` if it was the last one).
- The summary gains `batches`, `bisections`, `deferred`. Log events: `expo_chunk` (now with `rejected: <code>` for a rejection), `tokens_rejected` (count and reason only), plus the existing ones.
- `register_push_token` cannot know which Expo project a token belongs to (the format is the same). The per-user cap of 10 tokens (least recently seen dropped, verified by `qa-comms.test.ts`) bounds how many tokens one account can plant. Unverified against the real service: whether Expo rejects a request holding only another project's tokens. If it does, bisection isolates and invalidates the token once; if it accepts it (a single-project request), bisection only isolates it, so each later chunk that mixes it in costs up to about 15 extra requests (bounded by the cap) until Expo reports the token invalid by ticket.
- The cron call (`20261116000200`) now waits up to 120 s (`timeout_milliseconds := 120000`).

---

# Milestone 4 — Statistics

Read-only RPCs over the Milestone 1–2 tables, following `docs/STATS_DEFINITIONS.md` exactly (that file defines every metric; this section defines the calls and payloads). Migration `20261117000100_statistics.sql`. All five are `security definer`, `stable`, `set search_path = ''`, granted to `authenticated` only (anon and service_role: no execute). Caller identity is `auth.uid()`. No locks, no writes, nothing cached: every call computes from the current rows, so attendance corrections and moved sessions show up on the next call.

## Shared rules (implemented once, in `private.stats_sessions` and `private.stats_rows`)

- **S** (session set): `status = 'completed'`, `attendance_finalized_at is not null`, `cancel_reason is null`, the session's **current** `starts_at` in the window.
- **Eligibility** (`private.stats_rows`): one row per (session of S, membership of the community with `joined_at <= starts_at`), any role, any current status; plus one row with `eligible = false` per attendance record of a session of S whose person joined after its start (e.g. joined at the training and added as a walk-in). Missing RSVP = `no_response`; missing record = `unrecorded` (never `absent`). Member, summary and community numbers are all aggregates of these rows.
- **Window** `p_window`: `'7d' | '30d' | '90d' | 'all'`, i.e. `starts_at` in `[now() − N × 24 h, now()]`, both ends inclusive; `all` has no lower bound (`from: null`). Anything else (null, `'7D'`, `'week'`…) → `validation_failed:window`.
- **Rates**: `round(100 × n / d, 1)` on `numeric` (half up), `null` when `d = 0`; averages `round(total / count, 1)`, `null` on 0. Counts are always returned next to the rate.
- **Buckets** (community time zone, `communities.timezone`): months are calendar months (`period` `'YYYY-MM'`); weeks start on **Monday** (`period` = local Monday `'YYYY-MM-DD'`). They run from the bucket holding the window start (for `all`: the earliest session of the set; none → `[]`) to the bucket holding now; **empty buckets are included**. `from` / `to` are the bucket's instants (`to` exclusive), so a DST week is 167 or 169 hours long.
- **Envelope** of every payload: `window`, `from` (null for `all`), `to` (= the server's now() of the call), `generated_at`.

Order of checks in every function: `not_authenticated` → authorization (`not_a_member` / `forbidden`, also for unknown or null communities) → input (`validation_failed:window`, `validation_failed:limit`). So an outsider learns nothing from a malformed call.

## RPCs

`get_my_statistics(p_community_id uuid, p_window text) → jsonb` — caller must be an **active member** (organizers included), else `not_a_member`.

```
{ window: '30d', from: '2026-10-16T12:00:00+00:00', to: '2026-11-15T12:00:00+00:00', generated_at,
  timezone: 'Europe/Bucharest', community_id, user_id, membership_status: 'active', role: 'member', joined_at,
  eligible: 4, attended: 3, absent: 0, not_recorded: 1, recorded: 3, attendance_rate: 75.0,
  confirmed_rsvps: 3, missed: 0, rsvp_going_present: 3, rsvp_going_recorded: 3, rsvp_reliability: 100.0,
  walk_ins: 0,
  monthly: [ { period: '2026-10', from: '2026-09-30T21:00:00+00:00', to: '2026-10-31T22:00:00+00:00',
               eligible: 3, attended: 2, attendance_rate: 66.7 },
             { period: '2026-11', from, to, eligible: 1, attended: 1, attendance_rate: 100.0 } ] }
```
- `eligible` = |E|; `attended` = present (walk-ins included); `absent` = marked absent; `not_recorded` = no record or `unrecorded`; `recorded` = attended + absent; `attendance_rate` = attended / eligible; `confirmed_rsvps` = `going` in E; `missed` = going and absent; `rsvp_reliability` = `rsvp_going_present` / `rsvp_going_recorded` (going with present or absent); `walk_ins` = present with `is_walk_in`. `monthly`: every month of the window in the community time zone (for `all`: from the month of the member's first eligible session), with null rate when 0 eligible.

`get_my_attendance_history(p_community_id uuid, p_window text, p_limit int default 50, p_before timestamptz default null) → jsonb` — active member, else `not_a_member`. `p_limit` 1–100, else `validation_failed:limit` (null included).

```
{ window, from, to, generated_at,
  items: [ { session_id, title, activity_type, starts_at, ends_at, timezone, location_name,
             rsvp_response: 'going' | 'not_going' | 'no_response',
             outcome: 'present' | 'absent' | 'unrecorded', is_walk_in } ],
  has_more: boolean, next_before: timestamptz | null }
```
- The sessions of E, newest first (`starts_at desc, session_id desc`). Keyset on `starts_at`: `p_before` is exclusive; pass `next_before` back **verbatim** (string; do not round-trip it through a JS `Date`). A page never splits sessions that share one `starts_at`: it stops before such a group, or, when the page would consist of that group only, returns the whole group (so a page can exceed `p_limit` by the size of a same-instant group). `next_before` is null exactly when `has_more` is false.

`get_member_statistics(p_community_id uuid, p_user_id uuid, p_window text) → jsonb` — caller must be an **active organizer** of the community (else `forbidden`; members asking about themselves too); the target must have a membership in that community, **active or removed** (else `not_found`: unknown users, null, members of other communities). Same payload as `get_my_statistics`; `membership_status: 'removed'` for removed members, whose E still uses their membership start (their history stays readable).

`get_community_statistics(p_community_id uuid, p_window text) → jsonb` — active organizer, else `forbidden`.

```
{ window: '30d', from, to, generated_at, timezone, community_id,
  completed_trainings: 4, total_attendances: 9,
  average_attendees: 3.0, average_attendees_sessions: 3, incomplete_sessions: 1,
  rsvp_going_total: 10, average_rsvp_participation: 2.5,
  rsvp_going_present: 6, rsvp_going_recorded: 8, rsvp_conversion: 75.0,
  active_members: 6, members_attended: 4,
  cancelled_insufficient_participation: 1, cancelled_by_organizer: 1,
  trend_unit: 'week',
  trend: [ { period: '2026-10-12', from, to, sessions: 1, present: 4, incomplete_sessions: 0, average_attendees: 4.0 },
           { period: '2026-10-19', from, to, sessions: 0, present: 0, incomplete_sessions: 0, average_attendees: null }, … ],
  top_sessions: [ { session_id, title, starts_at, timezone, present: 4, min_participants: 3, going_count: 4 }, … ] }
```
- `completed_trainings` = |S|. `total_attendances` = present records over S (every real record: walk-ins, removed members' past attendance, people who joined at the training). `average_attendees` = present / `average_attendees_sessions`, where sessions with no `present` and no `absent` record (never marked) are excluded and counted in `incomplete_sessions`. `average_rsvp_participation` = Σ `going_count` / |S| (`rsvp_going_total` is the sum). `rsvp_conversion` = going & present / going with present or absent, across S. `active_members` = active memberships now (not windowed, organizers included). `members_attended` = currently active members with at least one present in their E within the window. `cancelled_*` = cancelled sessions with `starts_at` in the window, by reason (the only numbers that look at cancelled sessions). `trend`: weekly for `7d` / `30d`, monthly for `90d` / `all`; each bucket applies the same incomplete-session rule to its average. `top_sessions`: up to 5 sessions of S by present count, ties newer first (sessions with 0 present can appear when S has fewer than 5 attended sessions; the app may hide them).

`list_member_statistics_summary(p_community_id uuid, p_window text) → jsonb` — active organizer, else `forbidden`.

```
{ window, from, to, generated_at, community_id, total_members: 6, truncated: false,
  members: [ { user_id, display_name, role, joined_at,
               eligible, attended, absent, not_recorded, attendance_rate,
               confirmed_rsvps, missed, rsvp_going_present, rsvp_going_recorded, rsvp_reliability, walk_ins } ] }
```
- One line per **active** membership (any role), ordered by `display_name, user_id`, at most 500 (`truncated` true and `total_members` the full count when there are more). Each line equals that member's `get_my_statistics` numbers for the same window.

Consistency (tested): for one window, Σ over all memberships (summary lines + removed members via `get_member_statistics`) of `attended` + present rows with `eligible = false` = `total_attendances`; Σ `rsvp_going_present` / `rsvp_going_recorded` = the community's; the number of summary lines with `attended > 0` = `members_attended`.

New error codes: `validation_failed:window`, `validation_failed:limit` (others as before: `not_authenticated`, `not_a_member`, `forbidden`, `not_found`).

TypeScript: `src/lib/database.types.ts` — `StatisticsWindow`, `MyStatistics` / `MemberStatistics`, `AttendanceHistoryPage`, `CommunityStatistics`, `MemberStatisticsSummary` (and their item types).

## Decisions where STATS_DEFINITIONS.md leaves room (M4-B1)

1. **No `left_at` in the schema.** Rule 3's "active when the session ended" is approximated as its implementation note says: a member's own E uses only `joined_at <= starts_at` (so a removed member's history stays readable to organizers, with the numbers they had); per-member community figures (`members_attended`, the summary list, `active_members`) count only currently active memberships. Session-level community figures follow the explicit "no per-member eligibility" of the community section and count every real record, so removing a member does not rewrite past session totals.
2. **People who joined after a session started** (joined at the training, added as a walk-in): the session is not in their E (rule 3), but their attendance counts for the session (`total_attendances`, top sessions, trend). This is why the consistency identity has the `eligible = false` term.
3. **Window length** is N × 24 hours (not N calendar days in a zone), both edges inclusive.
4. **Weeks** start on Monday; buckets start at the bucket holding the window start, so the first and last bucket can be partial (they only count sessions inside the window).
5. **`all` buckets** start at the earliest session of the set (member: first eligible session; community: first session of S), not at the community's creation.
6. **Trend averages** use the same incomplete-session exclusion as the overall average (the definition does not say; this keeps the two consistent).
7. **Average RSVP participation** includes incomplete sessions (the exclusion rule is defined only for average attendees); with 1+ sessions and no going RSVPs it is `0.0`, not null.
8. **History limit** out of range is an error (`validation_failed:limit`), not clamped.
9. **Top sessions** follow the literal definition (top 5 of S), so a 0-present session can be listed.

## Milestone 4, B1 small fix (append-only)

Migration `20261117000200_announcement_read_lock.sql`: `mark_announcement_read` and `mark_announcements_read` now key-share-lock the caller's profile before inserting `announcement_reads`, like `mark_notification_read` / `mark_all_notifications_read`. During a concurrent account deletion they wait and then raise `not_found` (single) / `not_a_member` (all) instead of a foreign key violation (`23503`, reproduced by a test against the old body). Signatures, grants and normal behaviour unchanged.

## Milestone 4, B2: organizer reads a member's history (append-only)

Migration `20261118000100_member_history.sql` (fixes QA defect Q5-4).

`get_member_attendance_history(p_community_id uuid, p_user_id uuid, p_window text, p_limit int default 50, p_before timestamptz default null) → jsonb` — `security definer`, `stable`, `set search_path = ''`, `authenticated` only. Caller must be an **active organizer** of the community (else `forbidden`, members asking about themselves included); the target must have a membership in that community, **active or removed** (else `not_found`: unknown, null, members of other communities). Order of checks: `not_authenticated` → `forbidden` → `not_found` → `validation_failed:window` / `validation_failed:limit`. Payload, limit rules (1–100) and keyset pagination (`next_before` passed back verbatim, same-instant sessions never split) are exactly those of `get_my_attendance_history`: both call `private.stats_history_payload`. TypeScript: `AttendanceHistoryPage`.

Type fix (Q5-5): `MemberStatisticsSummaryRow` no longer declares `recorded`; `list_member_statistics_summary` lines never carried it (SQL unchanged). Use `attended + absent` if needed.

---

# Creator codes and community management (C1, append-only)

Migration `20261119000100_creator_codes.sql`. Product rule: nobody creates a community without a **creator code**, and only the platform owner issues them (SQL editor as `postgres`, or the `service_role` key). The holder names the community and its time zone in the app and becomes its organizer. An invitation code never creates a community, and a creator code is never accepted as an invitation code (each kind is looked up in its own table; the wrong kind is `invalid_code`). `admin_create_community` stays as the first-organizer bootstrap (unchanged).

## Tables (no client access)

| Table | Columns | Who can select |
|---|---|---|
| `community_creator_codes` | `id`, `code text unique` (8 chars, same alphabet and generator as invitation codes), `note text?` (1–100), `created_at`, `expires_at not null`, `max_uses int ≥ 1` (default 1), `use_count int` (0…`max_uses`), `revoked_at?`, `created_by? → auth.users` (null from the SQL editor / service key) | nobody (RLS on, no policy, no grant to `anon`, `authenticated` **or `service_role`**) |
| `community_creator_redemptions` | `id`, `code_id → codes (on delete restrict)`, `user_id → profiles`, `community_id → communities`, `membership_id → memberships`, `request_id uuid`, `redeemed_at`; unique `(code_id, community_id)`, unique `(user_id, request_id)` | nobody (same) |

A code that has been used cannot be deleted (restrict): revoke it instead, so the per-user community limit keeps counting.

## Service functions (`service_role` only; also runnable as `postgres` in the SQL editor)

`admin_create_creator_code(p_note text default null, p_expires_in_days int default 14, p_max_uses int default 1) → jsonb`
- Returns `{ code, expires_at, max_uses }`. Raises `validation_failed:expires_in_days` (not 1–365), `validation_failed:max_uses` (not 1–50), `validation_failed:note` (over 100 characters, or only invisible characters; a blank note is stored as null; control characters are stripped as in announcement titles).
- Example: `select public.admin_create_creator_code('for Alex', 14, 1);` → `{"code": "K7MZ3QXA", "expires_at": "2026-11-30T10:00:00+00:00", "max_uses": 1}`

`admin_revoke_creator_code(p_code text) → jsonb`
- Idempotent. Returns `{ code, revoked_at, use_count, max_uses, changed }` (`changed` false when it was already revoked; `revoked_at` is the first revocation). Raises `not_found` for an unknown code. The code is normalized like in the app (case, spaces, dashes).
- Communities already created with the code are not affected.

## User functions (`authenticated`)

Both code functions **return** `{ ok: false, error }` instead of raising (the attempt record must survive) and share the invitation limiter: **at most 5 failed attempts per user per 15 minutes counted over `preview_invitation`, `redeem_invitation`, `preview_creator_code` and `create_community_with_code` together**, then `rate_limited` from all four. Failures are code failures only (`invalid_code`, `expired`, `revoked`, `exhausted`); validation errors, `community_limit_reached` and `rate_limited` are not counted. Codes are matched case-insensitively, ignoring whitespace and dashes (ASCII and U+2010–U+2015).

`preview_creator_code(p_code text) → jsonb`
- `{ ok: true }` or `{ ok: false, error }` with `invalid_code`, `expired`, `revoked`, `exhausted`, `rate_limited`, `not_authenticated`. Does not consume a use. (It does not check the caller's community limit; `create_community_with_code` does.)

`create_community_with_code(p_code text, p_name text, p_timezone text, p_display_name text, p_request_id uuid) → jsonb`
- **`p_request_id` (required)** is the client's idempotency key: generate a UUID when the user submits the form and send the same value on every retry of that submission (network error, app restart). A request id already used successfully by the caller returns the first result, `already_created: true`, without creating anything, even if the code has since been used up or revoked. A new submission must use a new id. Ids are per user.
- Success: `{ ok: true, community_id, membership_id, already_created }`.
- Errors (`error` value): `not_authenticated`, `validation_failed:request_id`, `rate_limited`, `validation_failed:name`, `validation_failed:timezone`, `validation_failed:display_name`, `community_limit_reached`, `invalid_code`, `expired`, `revoked`, `exhausted` — checked in this order. Input and the limit are checked before the code is looked up, so they reveal nothing about the code.
- Validation: name as announcement titles (control and bidi characters stripped, whitespace collapsed, 1–80 characters, not only invisible characters); time zone strictly `UTC` or an IANA `Area/Location` known to the server (no abbreviations, `Factory`, `posix/…`); display name as `redeem_invitation` (whitespace collapsed, 2–40).
- One transaction: the code row is locked `FOR UPDATE` and re-checked with the real clock; then the community, the profile (display name upserted — profiles are global, so this renames the user in every community), an **active organizer** membership, the redemption, and `use_count + 1`. N parallel uses of a `max_uses = 1` code create exactly one community; the others get `exhausted`.
- Limit: a user can have created at most **5** communities with creator codes (`community_limit_reached`). Organizer roles obtained through invitations do not count.
- Example: `create_community_with_code('k7mz-3qxa', 'Făget Trail Pack', 'Europe/Bucharest', 'Alex', '6f1c…')` → `{ "ok": true, "community_id": "…", "membership_id": "…", "already_created": false }`; with a used-up code → `{ "ok": false, "error": "exhausted" }`; with an empty name → `{ "ok": false, "error": "validation_failed:name" }`.

`update_community(p_community_id uuid, p_name text, p_timezone text) → communities`
- Active organizer of that community only (`forbidden` otherwise, also for unknown ids; re-checked after locking the community row and the caller's membership, so a concurrent removal or demotion wins). Raises `not_authenticated`, `forbidden`, `validation_failed:name`, `validation_failed:timezone` (same rules as above). Sends both fields; unchanged values return the row as is.
- **Time zone change:** existing sessions keep their own `timezone` and instants (nothing is rewritten); new trainings default to the new zone. **Statistics** week / month buckets and the payload's `timezone` always use the community's **current** zone, so a change re-buckets all history in the statistics screens.

`list_my_communities() → jsonb`
- Array (oldest first, `[]` when none) of `{ community_id, membership_id, name, timezone, role, joined_at }`, one per **active** membership of the caller. Removed memberships are not listed. Nothing about other members. Raises `not_authenticated`.
- The plain read in "Reads" above (`memberships` filtered by `user_id = auth.uid()` joined to `communities`) returns the same rows under RLS; this RPC is the one-call version.

TypeScript: `PreviewCreatorCodeResult`, `CreateCommunityWithCodeResult`, `CreatorCodeError`, `CreateCommunityWithCodeError`, `AdminCreateCreatorCodeResult`, `AdminRevokeCreatorCodeResult`, `MyCommunity`.

## Multi-community review (C1)

Every RPC and policy was reviewed for a user who is organizer of A, member of B and removed from C (`supabase/tests/creator-codes-multi-community.test.ts`). All server rules are scoped by the community they act on (`is_active_member(community_id)` / `is_organizer(community_id)` or a membership lookup on `(community_id, user_id)`); no function picks "the" membership of the caller. Behaviour the client must know:
- **Display name is global** (`profiles`): `redeem_invitation` and `create_community_with_code` overwrite it for every community.
- **Notification preferences and push tokens are per user**, not per community.
- **Push badge** (`claim_notification_jobs.unread_count`) counts unread notifications of **all** communities where the user is active; `mark_all_notifications_read` and the in-app list are per community. A per-community Activity screen will show a smaller number than the badge.
- `announcement_reads` rows stay readable to their owner after removal (own read receipts only, no announcement content).
- The client currently selects a single membership (`src/features/community/api/membership.ts`: earliest active, `limit(1)`); it needs a community switcher based on `list_my_communities`.
