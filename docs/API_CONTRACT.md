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
- The message `data` is `{ deepLink, notificationId, kind }` (C3: plus `communityId`) (camelCase), **not** `{ url, notification_id, kind }`. The mobile app must read `data.deepLink`. `badge` = `unread_count` is sent as an extra top-level field. Also sent: `sound: 'default'`, `channelId: 'default'` (the app must create an Android channel named `default`), `priority: 'high'`, `ttl`.
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

## C3 amendments (QA fixes Q6-1, Q6-2, Q6-3, D5, O6; append-only)

Migration `20261120000100_c_qa_fixes.sql`. Tests: `supabase/tests/c-qa-fixes.test.ts` (plus the flipped Q6 tests in `qa-community.test.ts`).

**Text cleaning (Q6-2).** `private.clean_required_text` (community names, announcement titles and bodies, notes) rejects text with no visible character. "Invisible" is now defined by Unicode properties, listed range by range in the migration: White_Space, every Default_Ignorable_Code_Point (U+00AD, U+034F, U+061C, U+115F-1160, U+17B4-17B5, U+180B-180F, U+200B-200F, U+202A-202E, U+2060-206F, U+3164, U+FE00-FE0F, U+FEFF, U+FFA0, U+FFF0-FFF8, U+1BCA0-1BCA3, U+1D173-1D17A, U+E0000-E0FFF), the other format characters (U+0600-0605, U+06DD, U+070F, U+0890-0891, U+08E2, U+FFF9-FFFB, U+110BD, U+110CD, U+13430-1343F) and U+2800. Stripping is unchanged (C0/C1 controls, bidi embeddings/overrides U+202A-202E and isolates U+2066-2069). Invisible characters next to visible text are kept as sent: ZWJ emoji sequences, ZWNJ inside Persian words, variation selector 16, tag-sequence flags. A test checks every White_Space / Default_Ignorable / Cf / Cc code point known to Node's ICU (Unicode 17) against the server.

**Display names (Q6-1).** Every path (`redeem_invitation`, `create_community_with_code`, `update_display_name`) uses the same rule: the single-line cleaning above (controls and bidi controls stripped, whitespace collapsed, not only invisible characters), then **2-40 code points** of the cleaned text. Error codes are unchanged (`invalid_display_name` from `redeem_invitation`, `validation_failed:display_name` from the other two). Names are **global** (decision D1): one display name per person, shown in every community. The migration cleans existing profiles once; a stored name that is no longer acceptable becomes `Member`.

**Deleted user's token (Q6-3).** `preview_invitation`, `redeem_invitation`, `preview_creator_code` and `create_community_with_code` return `{ ok: false, error: 'not_authenticated' }` when the JWT's user no longer exists in `auth.users` (checked first, before any write). A deletion that races a running call is caught at the foreign key and answered the same way, with everything the call wrote rolled back. These are the only functions that write rows referencing `auth.users` with the caller's id (`invitation_attempts`, `profiles`); every other user function locks the caller's profile first and answers its own documented error. No raw `23503` is returned.

**Attempt retention (D5).** `invitation_attempts` rows older than 24 hours are deleted by the existing daily job (`purge_old_notification_data()`, pg_cron `trainhive_purge_notification_data` at 03:17). The limiter (5 failures per 15 minutes) is unaffected. The function's return value is unchanged (jobs and notifications deleted; attempts are not counted). Rows a running call has locked are skipped and go on the next run. There is no per-day cap per code (decision D5).

**`update_community` optimistic concurrency (O6).** New signature (the three-argument one is dropped; calls with three arguments still work through the default):

`update_community(p_community_id uuid, p_name text, p_timezone text, p_expected_updated_at timestamptz default null) → communities`
- `communities` has a new column **`updated_at timestamptz not null`** (millisecond precision, so a JavaScript `Date` or the ISO string from the API round-trips exactly). It is set at creation and strictly increases with every change made by `update_community`. It is readable wherever `communities` is (RLS read, the `community:communities(*)` embed); it is **not** added to `list_my_communities()` (its payload is unchanged).
- Pass the `updated_at` of the row the form was loaded from. If the row has changed since (another organizer saved), the call raises **`stale_data`** and changes nothing, also when the submitted values equal the current ones. The comparison happens after the community row lock, so of two concurrent saves from the same form exactly one succeeds. Reload and resubmit.
- `null` / omitted: C1 behaviour (last write wins). Unchanged values return the row as is (no `updated_at` bump).
- Check order: `not_authenticated`, `forbidden`, `validation_failed:name`, `validation_failed:timezone`, `forbidden` (after the locks), `stale_data`. A non-organizer always gets `forbidden`, whatever the timestamp.
- Example: `update_community('…', 'Alpha Pack', 'Europe/Berlin', '2026-11-20T10:00:00.123+00:00')` → the updated row with a newer `updated_at`; the same call again → `stale_data`.

**Push payload.** The Expo message `data` is now `{ deepLink, notificationId, kind, communityId }`; `communityId` is the notification's community (`claim_notification_jobs` already returned `community_id`; no migration change). The app can switch to that community on a tap without looking it up.

### Milestone 3, instant dispatch (append-only)

Migration `20261121000100_instant_dispatch.sql`: a statement-level AFTER INSERT trigger on `notification_delivery_jobs` (`private.trigger_instant_dispatch`, private, security definer, no API grants) calls `dispatch-notifications` through `net.http_post` (asynchronous, sent after commit) when at least one inserted job is due (`next_attempt_at <= now()`). Debounced to one call per 2 s through `private.dispatch_ping` (`for update skip locked`, taken last, never waits). It swallows all errors (warning with SQLSTATE only) and is a no-op without pg_net, Vault or either secret. The cron job remains the safety net. No RPC, signature or client behaviour changed; push arrives typically within seconds instead of up to a minute.

---

# GDPR G1 — consents (append-only)

Migration `20261123000100_consents.sql`. Plan: `docs/GDPR_PLAN.md` sections 2 and 5 (G1). Tests: `supabase/tests/consent-ledger.test.ts`, `supabase/tests/consent-gates.test.ts`, plus the updated privilege matrix in `qa-privileges.test.ts`.

## Tables (RLS, select-only for `authenticated`; nothing for `anon` or `service_role`)

| Table | Columns | Who can select |
|---|---|---|
| `legal_documents` | `document text pk` in `terms` / `privacy`, `version text` (`^[A-Za-z0-9._-]{1,20}$`), `effective_at`, `updated_at`. Seeded `'1'` / `'1'`. | any signed-in user |
| `consent_records` | `id uuid pk`, `user_id → auth.users (on delete cascade)` (not profiles: acceptance happens at first launch, before a profile exists), `purpose`, `document_version text?`, `granted boolean`, `created_at` | own rows only |

**Purposes:** `terms_privacy` (acknowledgement of the Terms + Privacy notice), `age_16` (confirmation of being 16 or older), `profile_demographics`, `emergency_contact`, `workout_logs`, `push_notifications`. Extending the list is a migration (check constraint + `private.consent_purposes()`).

**Versions (decision).** A `terms_privacy` event stores ONE combined string `terms:<terms version>|privacy:<privacy version>` (e.g. `terms:1|privacy:1`), so one row proves which pair of texts was accepted. Every other purpose stores the privacy-notice version in force at the time of the event. Bumping either document makes `terms_privacy` stale; optional consents are not reset by a new notice version.

**Ledger is append-only.** One row per grant or withdrawal; the latest event per (user, purpose) is the current state (order: `created_at`, made strictly increasing per user by the RPCs, which write under a per-user lock). Enforced twice: (1) privileges: no API role, `service_role` included, has INSERT / UPDATE / DELETE / TRUNCATE; (2) a `BEFORE UPDATE OR DELETE` row trigger (`private.guard_consent_ledger`) raises `consent_ledger_append_only` for every UPDATE, and for every DELETE unless the row's auth user no longer exists, which is exactly the `on delete cascade` from `auth.users` (account deletion, G2). It applies to the table owner too. Not covered (owner / superuser only): `TRUNCATE` and `session_replication_role = replica`, which bypass row triggers.

## RPCs (`authenticated`; errors are raised, `P0001`, message = code)

`record_consent(p_purpose text, p_document_version text default null) → jsonb` → `ConsentEvent` `{ purpose, granted: true, document_version, at, changed }`
- `terms_privacy`: `p_document_version` must equal the current combined version (`my_consents().terms_privacy_version`), else `validation_failed:document_version`. Other purposes: optional; if given it must equal the current privacy version, else `validation_failed:document_version` (nothing written); the stored stamp is that version. **P3-QA-7:** the app passes the privacy version it showed (its bundled version) for optional purposes, so a grant is stamped with the text the person actually saw; on `validation_failed:document_version` it shows `app_update_required`, as for `terms_privacy`. Null / omitted (older builds): stamped with the version in force, as before.
- Idempotent: if the latest event is already a grant of the same version, nothing is written and `changed` is false.
- Rate limit: a new grant is refused with `rate_limited` when the caller already has 30 ledger events in the last hour. Withdrawals are never limited (a withdrawal must stay as easy as the grant; each needs a prior grant, so they are bounded too).
- Errors: `not_authenticated` (no user, or the JWT's user was deleted), `validation_failed:purpose`, `validation_failed:document_version`, `rate_limited`.

`withdraw_consent(p_purpose text) → jsonb` → `ConsentEvent` with `granted: false`
- `terms_privacy`, `age_16`: `not_withdrawable` (leaving the service = deleting the account, G2).
- Not currently granted (never recorded, or already withdrawn): nothing written, `changed: false`.
- Effects in the same transaction: `push_notifications` deletes **all of the caller's push tokens**. (P3 / P5 extend this to delete demographics, emergency contact and workout logs.)
- Errors: `not_authenticated`, `validation_failed:purpose`, `not_withdrawable`.

`my_consents() → jsonb` → `MyConsents`
```
{ terms_version: '1', terms_effective_at, privacy_version: '1', privacy_effective_at,
  terms_privacy_version: 'terms:1|privacy:1',
  needs_terms_acceptance: true,
  consents: { terms_privacy: { granted, current, document_version, at }, age_16: {…}, profile_demographics: {…},
              emergency_contact: {…}, workout_logs: {…}, push_notifications: {…} } }
```
- `granted`: the latest event is a grant. `current`: what the server checks (granted, and for `terms_privacy` of the current versions). Never recorded: `granted: false, current: false, document_version: null, at: null`.
- `needs_terms_acceptance` = not (`terms_privacy` current and `age_16` granted). The app shows the first-launch screen (Terms + Privacy + 16+) when true, then calls `record_consent('terms_privacy', terms_privacy_version)` and `record_consent('age_16')`.

`admin_set_legal_version(p_document text, p_version text) → jsonb` — **`service_role` only** (and `postgres` in the SQL editor)
- `{ document, version, effective_at, changed }`; the same version again: `changed: false`. Errors `validation_failed:document`, `validation_failed:version`.
- Owner, after publishing a new privacy notice: `select public.admin_set_legal_version('privacy','2');` — every user then has `needs_terms_acceptance: true` and cannot join a community until they accept again.

`private.has_consent(p_user_id uuid, p_purpose text) → boolean` (no execute for any API role): true only when the latest event is a grant (for `terms_privacy`, of the current versions). **Rule for future features:** every write function that stores consent-dependent data (P3 demographics, emergency contact, P5 workout logs) takes `private.lock_consents(auth.uid())`, then checks `private.has_consent(auth.uid(), '<purpose>')` and raises `consent_required` when false; `withdraw_consent` must delete that data for its purpose.

## Gates

- **Joining.** `redeem_invitation` and `create_community_with_code` return `{ ok: false, error: 'consent_required' }` unless the caller has a current `terms_privacy` and a granted `age_16`. Checked right after `not_authenticated`, before the attempt lock, the rate limit, the request id / replay and the code lookup: it consumes nothing, is not counted as a failed attempt and reveals nothing about the code. Re-redeeming as an existing member is gated too. `preview_invitation` / `preview_creator_code` stay open. The legal versions are share-locked during the check, so a concurrent version bump is ordered before or after the join.
- **Push.** `register_push_token` raises `consent_required` without a current `push_notifications` consent (order: validation errors, `not_a_member` (no profile), then `consent_required`). It takes the same per-user consent lock as `withdraw_consent`, so a registration can never land after a withdrawal removed the tokens. App flow: in-context prompt, `record_consent('push_notifications')`, OS permission, register.

## Existing users (decision)

No consent is backfilled: consent and the 16+ confirmation cannot be presumed, and the ledger must only hold events a person performed. Users who existed before G1 have no records, so `my_consents().needs_terms_acceptance` is true for them and the app asks on next launch. They are **not** blocked from the app (RSVP, attendance, reads, statistics do not check consent); only new joins and new push-token registrations are gated. Push tokens registered before G1 stay until the user withdraws push consent, signs out, or the token becomes invalid (the dispatcher does not check consent; open question for the lead).

New error codes: `consent_required`, `not_withdrawable`, `rate_limited` (consents), `validation_failed:purpose`, `validation_failed:document_version`, `validation_failed:document`, `validation_failed:version`, `consent_ledger_append_only` (only for direct writes by the owner).

TypeScript: `LegalDocumentKind`, `ConsentPurpose`, `ConsentEvent`, `ConsentState`, `MyConsents`, `AdminSetLegalVersionResult`; `CreateCommunityWithCodeError` gains `consent_required`.

---

# GDPR G2 — export and deletion (append-only)

Migrations `20261124000100_member_roles.sql` (organizer tools) and `20261124000200_data_rights.sql` (attendance anonymization, export, deletion). Plan: `docs/GDPR_PLAN.md` section 3 and phase G2. Tests: `supabase/tests/member-roles.test.ts`, `data-export.test.ts`, `account-deletion.test.ts`, `account-deletion-rules.test.ts`, `account-deletion-concurrency.test.ts`, plus the updated privilege matrix (`qa-privileges.test.ts`). All functions below: `security definer`, `set search_path = ''`, `authenticated` only (anon and service_role: no execute); errors are raised (`P0001`, message = code).

## Organizer tools

Invariant: a community with active members always keeps an active organizer. Every path that can shrink the set of active organizers (the three functions below and account deletion) takes a per-community role lock (`private.lock_community_roles`, advisory) and counts the remaining organizers after it, so concurrent demotions / removals / departures / deletions never leave zero organizers (tested: two organizers demoting each other at once, two organizers deleting at once, leave vs delete).

`set_member_role(p_community_id uuid, p_user_id uuid, p_role membership_role) → memberships`
- Caller: active organizer of the community (checked before and again after the locks), else `forbidden` (also unknown / null community). `p_user_id` is the target member.
- Check order: `not_authenticated`, `forbidden`, `validation_failed:user_id`, `validation_failed:role`, `cannot_change_own_role` (the caller's own id), then after the locks `forbidden`, `not_found` (no membership here, or `removed`), `last_organizer` (defensive; cannot occur while the caller is another active organizer).
- Same role again: returns the row unchanged. `memberships` has no `updated_at`; nothing else is written.

`remove_member(p_community_id uuid, p_user_id uuid) → memberships`
- Caller: active organizer (re-checked after the locks), else `forbidden`. Sets the target's status to `removed`: the existing trigger releases their going RSVPs on open sessions; RSVPs, attendance and audit history stay; a removed member cannot rejoin by code (`invalid_code`). Can remove another organizer.
- Errors: `not_authenticated`, `forbidden`, `validation_failed:user_id`, `cannot_remove_self` (use `leave_community`), `not_found` (no membership here), `last_organizer` (defensive). Already removed: the row unchanged.

`leave_community(p_community_id uuid) → jsonb` → `LeaveCommunityResult` `{ community_id, membership_id, status: 'removed', changed, invitations_revoked }`
- Any member. Sets the caller's own membership to `removed` (RSVPs on open sessions released, history kept, no rejoining by code). Already removed: `changed: false`.
- `last_organizer` when the caller is the last active organizer and other active members remain (promote someone first).
- The last active member may leave; the community then has nobody active, so its open invitation codes are revoked in the same transaction (`invitations_revoked`; nobody can join a community without an organizer). The community and its history stay (dormant).
- Errors: `not_authenticated`, `not_a_member` (no membership, no profile, null / unknown community), `last_organizer`.

## `export_my_data() → jsonb` ("Download my data")

`MyDataExport`, everything personal about the caller and nothing about anyone else. One statement builds it (a consistent snapshot). `volatile` (not `stable`) only because it records the call for the rate limit; it changes nothing else.
- **Rate limit:** 10 exports per user per rolling hour, then `rate_limited` (counted under a per-user advisory lock: 16 parallel calls give exactly 10). Kept in `private.data_export_log` (no API access); rows older than an hour are pruned by the user's next export and deleted with the account.
- Errors: `not_authenticated` (no user, or the JWT's user was deleted; also when the account is deleted while the export runs), `rate_limited`.
- **Caps:** every list at most 5000 items, oldest first; `truncated.<section>` is true when more exist.
- **Other people:** never another member's id or display name; community names and event titles only. Changes to the caller's attendance show `changed_by: 'an organizer'` (or `'you'`). Authored rows that are about other people are only counted. Push token values are never exported.

```
{ format_version: 1, generated_at, README: '<plain-language explanation>',
  account: { user_id, created_at, is_anonymous },
  profile: { display_name, created_at, updated_at } | null,
  memberships: [ { membership_id, community_id, community_name, role, status, joined_at } ],
  rsvps: [ { rsvp_id, session_id, community_id, event_title, event_starts_at, event_status, response, responded_at, updated_at } ],
  attendance: [ { record_id, session_id, community_id, event_title, event_starts_at, status, is_walk_in, had_rsvp_going, recorded_at, updated_at } ],
  attendance_changes: [ { change_id, session_id, community_id, event_title, event_starts_at, old_status, new_status, action, reason, changed_at, changed_by: 'you' | 'an organizer' } ],
  invitation_redemptions: [ { redemption_id, community_id, community_name, role, redeemed_at } ],
  creator_code_redemptions: [ { redemption_id, community_id, community_name, redeemed_at } ],
  consents: [ { event_id, purpose, granted, document_version, at } ],          -- every ledger event
  notification_preferences: { push_enabled, training_reminders, announcements, training_updates, updated_at } | null,
  notifications: [ { notification_id, community_id, kind, title, body, created_at, read_at, push_status, push_sent_at } ],
  announcement_reads: [ { announcement_id, community_id, announcement_title, read_at } ],
  push_devices: [ { device_id, platform, device_label, created_at, last_seen_at, invalidated_at } ],
  authored: { announcements: [ { announcement_id, community_id, community_name, title, body, status, scheduled_for, published_at, created_at } ],
              events_organized: [ { session_id, community_id, community_name, title, starts_at, status, created_at } ],
              invitation_codes: [ { invitation_id, community_id, community_name, role, created_at, expires_at, max_redemptions, redemption_count, revoked_at } ],
              events_cancelled: 1, events_attendance_finalized: 1,
              attendance_records_created_for_others: 2, attendance_changes_made_for_others: 2 },
  technical: { invitation_attempts: [ { attempted_at, success } ], data_export_requests: [ { requested_at } ] },
  extensions: {},                       -- P3 (About you) and P5 (workout logs) add their keys here
  truncated: { memberships: false, rsvps: false, … } }
```
Example (abridged): `{ "format_version": 1, "profile": { "display_name": "Ana" , … }, "memberships": [ { "community_name": "Făget Trail Pack", "role": "member", "status": "active", … } ], "attendance": [ { "event_title": "Morning run", "status": "present", "is_walk_in": false, … } ], "attendance_changes": [ { "old_status": "absent", "new_status": "present", "reason": "Arrived late", "changed_by": "an organizer", … } ], "push_devices": [ { "platform": "android", "device_label": "Phone", … } ], "extensions": {}, … }`. The app saves it as a `.json` file.

Tested (`account-deletion.test.ts`): every place in the database that refers to the user (a scan of all uuid / text / json columns of `public`, `private`, `auth`) is a section of the export with the same number of rows, and after `delete_my_account` every listed row is deleted or anonymized.

## `my_deletion_blockers() → jsonb`

`MyDeletionBlockers` `{ can_delete, last_organizer: [ { community_id, name, active_members } ], deleted_with_account: [ { community_id, name } ] }` for the "Delete my account" screen (show it before the double confirmation). `deleted_with_account`: communities where the caller is the last active member; they are deleted with the account, including everything in them (sessions, removed members' history, announcements, codes). Read-only, no locks (the deletion re-checks under its locks). Errors: `not_authenticated`.

## `delete_my_account() → jsonb` ("Delete my account")

`DeleteMyAccountResult` `{ user_id, communities_deleted: [ids], memberships_deleted, rsvps_deleted, attendance_records_anonymized, attendance_changes_anonymized, notifications_deleted }`. One transaction: checks, then `private.erase_user(auth.uid())`.
- Errors: `not_authenticated` (no user; the JWT's user no longer exists, so a **second call** with the still-valid JWT answers this), `last_organizer` while the caller is the last active organizer of a community that still has other active members; the error **`details`** carries `DeletionBlockedDetail` as JSON: `{"communities":[{"community_id":"…","name":"Alpha Pack","active_members":3}]}`. Promote another member (`set_member_role`) and retry.
- After the deletion the app signs out locally (the JWT stays valid until it expires, up to an hour). Every RPC called with it answers with its own documented error (`not_authenticated`, `not_a_member`, `forbidden`, `not_found`; invitation / creator code functions `{ok:false, error:'not_authenticated'}`), never a raw foreign-key error (tested for every user RPC).

**Deleted:** profile; memberships (an active one releases its going RSVPs on open sessions first); RSVPs (a deleted `going` row is uncounted from its session's `going_count` whatever the status, as before: `going_count` always equals the going rows, so a past session's `going_count` and the statistics' `rsvp_going_total` / `average_rsvp_participation` / `top_sessions[].going_count` drop by the deleted member's going RSVPs); push tokens; notification preferences; notifications and their push jobs; announcement read receipts; invitation redemptions (the code's `redemption_count` is kept); creator-code redemptions (**decision:** deleted, not nullified; the code's `use_count` is kept, so the code stays used, and the per-user community limit only concerns the deleted user); invitation attempts; the data-export log; the consent ledger (by the cascade from `auth.users`, the only DELETE the ledger's guard allows, so `auth.users` is deleted last); the `auth.users` row; communities where the user was the last active member (cascade).

**Anonymized (kept without identity):** `attendance_records` and `attendance_audit_log` rows about the user keep their session, community, status, walk-in / RSVP-origin flags and times, with `user_id = null`. `user_id` is now **nullable, `on delete set null`** on both tables (a plain `delete from auth.users` behaves the same). The unique `(session_id, user_id)` still prevents duplicates for real users; several anonymous rows can exist for one session. Rows the user **authored** keep their subject and lose the author (`recorded_by`, `changed_by` = null).

**Kept without author:** announcements (`author_id` null; the app shows **"Former member"**; a scheduled one still publishes, any organizer can cancel it), sessions they organized / cancelled / finalized (`organizer_id`, `cancelled_by`, `attendance_finalized_by` null), invitation codes they created (`created_by` null).

**Statistics with anonymous rows** (`private.stats_rows` replaced, otherwise identical for real users): an anonymous record is a non-eligible row (like a person who joined after the session started), with RSVP `going` when the record came from a going RSVP (`had_rsvp_going`) else `no_response`. So session-level community numbers (`completed_trainings`, `total_attendances`, `average_attendees`, `incomplete_sessions`, `rsvp_going_present`, `rsvp_going_recorded`, `rsvp_conversion`, `trend`, `top_sessions[].present`) are **unchanged** by a deletion; per-member numbers (`list_member_statistics_summary`, `members_attended`, `active_members`, `get_member_statistics` → `not_found`) no longer include the user (tested). Caveat from the plan: in a very small club anonymous counts can still point to a person.

**Attendance RPCs with anonymous rows:** `get_attendance_sheet` never lists an anonymous row as an entry and gains **`former_members: { present, absent, unrecorded }`** (counts of anonymous records of the session). `record_attendance` / `add_walk_in_attendee` cannot target them (`validation_failed:user_id` for null); `cancel_training` still refuses a session with anonymous `present` / `absent` records (`session_has_attendance`: the attendance happened). Organizers reading `attendance_records` / `attendance_audit_log` directly see rows with `user_id = null`; show them as "Former member".

**Concurrency.** Lock order of an erasure: consent lock (per user) → invitation codes of the user's active communities → profile → `auth.users` row → community role locks (id order) → the user's memberships → other active organizers' memberships (share) → scheduled / authored announcements → the sessions it writes plus the open (`scheduled` / `confirmed`) sessions of the user's communities (id order). This matches every writer's order, and it makes every notification fan-out that already saw the user as a member commit before the deletion (whose deferred trigger on `profiles` then removes the new notification). `create_training` now locks the caller's organizer membership (`FOR NO KEY UPDATE`, like `create_announcement`) for this reason (same signature, grants and errors; the organizer role is re-checked under that lock). Tested in both orders against `set_rsvp` (own and another member's), `record_attendance` (own attendance and on a session the user organized), `update_training` (open and confirmed), `create_training`, `publish_due_announcements`, `set_member_role`, `record_consent`, `export_my_data`, a join into the user's last-member community, plus a mixed storm: no deadlock, no raw constraint error, no row left referring to the user, `going_count` always equal to the going rows. A join racing the deletion of a last-member community either finds the code gone (`invalid_code`) or, if it committed first, turns the deletion into `last_organizer`.

**`private.erase_user(p_user_id uuid) → jsonb`** (no API role can execute it): takes the locks itself, refuses with `last_organizer` whoever calls it, returns null when the auth user no longer exists. The G3 inactive-account job will call it for the accounts it selects (no caller identity needed); it adds no checks of its own.

**Hosted note (unverified).** Deleting the auth user is a plain `delete from auth.users where id = …` inside the security definer function (owner `postgres`), preceded by a `select … for update` of that row. This is the approach the Supabase docs show for self-service account deletion, and the tests run it against the embedded Postgres, but it has **not been run on the hosted project**: there `auth.users` belongs to `supabase_auth_admin`, `postgres` must hold SELECT / UPDATE / DELETE on it (it does on current projects, as far as known), and Auth's own tables (identities, sessions, refresh tokens, MFA factors) must cascade from it. Check once after deploying: delete a throwaway account in the app, then `select count(*) from auth.users where id = '<id>'` and `select count(*) from auth.identities where user_id = '<id>'` return 0. **Fallback if it is refused:** keep `delete_my_account` for the data (`private.erase_user` without its last statement) and delete the auth user from an Edge Function that verifies the caller's JWT, calls the RPC with the caller's token, then `supabase.auth.admin.deleteUser(uid)` with the service role key (the consent ledger rows then go with that cascade). Not built.

**Retention hook (G3).** Inactive-account deletion reuses `private.erase_user`.

New error codes: `last_organizer`, `cannot_change_own_role`, `cannot_remove_self`, `validation_failed:role`, `rate_limited` (export). Existing ones used: `not_authenticated`, `not_a_member`, `forbidden`, `not_found`, `validation_failed:user_id`.

TypeScript (`src/lib/database.types.ts`): `LeaveCommunityResult`, `DeletionBlocker`, `MyDeletionBlockers`, `DeletionBlockedDetail`, `DeleteMyAccountResult`, `MyDataExport`; `AttendanceSheet` gains `former_members`; `attendance_records.user_id` and `attendance_audit_log.user_id` are `string | null`.
---

# GDPR Q7 fixes (append-only)

Migration `20261125000100_gdpr_qa_fixes.sql`; fixes Q7-1, Q7-2, Q7-3, Q7-4 and Q7-6 of `docs/QA_REPORT.md`. Tests: `supabase/tests/gdpr-qa-fixes.test.ts`, the flipped `FIXED Q7-n` tests in `qa-gdpr-consent.test.ts`, `dispatch.test.ts` (dispatcher completes a `no_push_consent` job as skipped). No signature, grant or error code changed; two new private helpers (`private.purge_old_data_export_log()`, `private.purge_stale_push_tokens()`) are executable by no API role.

**Deployment order (owner decision):** the app update that asks existing members for push consent ships first, then this migration. From then on pushes go only to members with a current `push_notifications` consent; this supersedes "Existing users" in G1 ("the dispatcher does not check consent").

## Push consent at send time (Q7-1)

`claim_notification_jobs` hands out a user's tokens only when `private.has_consent(user_id, 'push_notifications')` is true. Otherwise the job has `tokens: []`, `push_allowed: false`, `skip_reason: 'no_push_consent'`; the dispatcher completes it as `skipped` with that reason (it passes any `skip_reason` through; no code change). In-app notifications are unaffected. The `skip_reason` ladder (first match wins): `not_a_member`, `push_disabled`, `category_disabled`, `no_push_consent`, then `no_tokens` (push allowed but no valid token). Consent is read when the job is claimed: a withdrawal that commits after the claim cannot recall a push already handed to the dispatcher (it still deletes the tokens, so no later claim sends). TypeScript: `NotificationSkipReason` gains `no_push_consent`.

## Switching push off (Q7-2)

`withdraw_consent('push_notifications')` always deletes all the caller's push tokens, also when no grant is on record (a member whose token predates the ledger) or the consent is already withdrawn. With no current grant nothing is written to the ledger and the answer is unchanged (`changed: false`); calling it again is harmless. Other purposes are unchanged.

## Retention (Q7-3, Q7-4): final numbers

All run in the existing daily job `trainhive_purge_notification_data` (pg_cron, 03:17 UTC, `purge_old_notification_data()`; its return value is unchanged and does not count these rows). Because the job runs once a day, each limit can be exceeded by up to one day.

| Data | Deleted | Effective maximum |
|---|---|---|
| Export rate-limit records (`private.data_export_log`) | older than **1 hour** (the rate-limit window; nothing else reads them) | about **25 hours** |
| Push token reported invalid by Expo (`invalidated_at`, DeviceNotRegistered) | **30 days** after it was invalidated | 31 days |
| Push token not registered again (`last_seen_at`; the app registers on every start and return to the foreground) | **270 days** after it was last registered | 271 days |
| Push tokens on switch-off, sign-out (best effort, app) and account deletion | immediately | — |

The export README now says "rate-limit records kept for **about a day**" (was "at most a day", which a daily job cannot guarantee). A device whose token was purged gets it back on the next app start if push consent is still current.

## Erasure scrubs audit reasons (Q7-6)

`private.erase_user` (so `delete_my_account`) sets `attendance_audit_log.reason = null` on every audit row **about** the erased user (which also loses `user_id`) and on every row the erased user **wrote** (which loses `changed_by`). Statuses, actions and times stay. Scope: a reason on another member's row that mentions the erased person by name is not changed (no text matching).

---

# Events (P1, append-only)

Migration `20261126000100_events.sql`. Plan: `docs/EVENTS_PLAN.md` ("Confirmed decisions", "1. Events"). Tests: `supabase/tests/events.test.ts`, `events-lifecycle.test.ts`, `events-concurrency.test.ts`, plus the event_subtypes privileges in `qa-privileges.test.ts`.

**Vocabulary.** A training becomes one *kind* of **event**. "Event" is UI vocabulary only: the table stays `training_sessions`, the RPCs keep their names and signatures (`create_training`, `update_training`, `cancel_training`, `set_rsvp`, `finalize_due_sessions`, attendance and statistics RPCs), the notification kinds keep their names (`training_*`, no new enum value) and deep links stay `/trainings/<id>`. No public function was added or removed; grants unchanged.

## Schema

- Enum `event_kind`: `training`, `race`, `sports_event`, `social`.
- Table `event_subtypes(kind event_kind, key text, label text, sort_order int, activity_type text → activity_types.key)`, pk `(kind, key)`. RLS on; **SELECT for `authenticated` only** (anon and service_role nothing); no RPC writes it. `activity_type` is the legacy activity type written for events of that subtype (an addition to the planned columns, so the compatibility mapping is data, not code).

| kind | subtypes (key → legacy `activity_type`) |
|---|---|
| `training` | `running`, `trail_running`, `strength`, `functional_fitness`, `ocr`, `other` (identity; every `activity_types` key is a training subtype) |
| `race` | `trail_running` → trail_running, `asphalt_running` → running, `ocr` → ocr |
| `sports_event` | `crossfit_event` → functional_fitness, `public_training` → other, `other` → other |
| `social` | `social_gathering` → other, `other` → other |

- `training_sessions` new columns: `event_kind event_kind not null default 'training'` (**immutable**), `event_subtype text not null` (composite FK `(event_kind, event_subtype)` → `event_subtypes`), `distance_km numeric(6,2)?` (> 0, ≤ 1000), `elevation_gain_m int?` (0..20000, "D+"), `obstacle_count int?` (0..500), `event_notes text?` (1..1000). `min_participants` is now **nullable**.
- Table checks: `min_participants` set iff `event_kind = 'training'`; a non-training event is never `scheduled`; `max_participants >= coalesce(min_participants, 1)`; ranges above; `distance_km` / `elevation_gain_m` only for subtypes `running`, `trail_running`, `asphalt_running`, `ocr`; `obstacle_count` only for `ocr`. Existing checks (`going_count`, deadline, coordinates, cancel reason, completion) unchanged.
- **`activity_type` compatibility (decision):** kept as a column and always **derived** from `(event_kind, event_subtype)` through `event_subtypes.activity_type`, by a BEFORE trigger on every write path. For trainings it equals the subtype. Every existing reader (history payload `activity_type`, app lists, exports) keeps working. A legacy-shaped insert without `event_subtype` gets the training subtype from `activity_type`; a write of `activity_type` alone on a training moves the subtype with it; a write that changes `event_kind` raises `validation_failed:event_kind`.
- Backfill: every existing row became `event_kind = 'training'`, `event_subtype = activity_type`.

## `create_training` / `update_training` input

Final `p_input` keys: `title`, `description`, `event_kind`, `event_subtype`, `activity_type` (legacy), `starts_at`, `ends_at`, `rsvp_deadline`, `timezone`, `location_name`, `address`, `latitude`, `longitude`, `map_url`, `meeting_instructions`, `min_participants`, `max_participants`, `distance_km`, `elevation_gain_m`, `obstacle_count`, `event_notes`. Unknown keys are still ignored.

- `event_kind`: absent/null → `training` on create, the stored kind on update. A different kind on update → `validation_failed:event_kind`. Not a known kind → `validation_failed:event_kind`.
- `event_subtype`: must belong to the kind (`validation_failed:event_subtype`). Absent/null:
  - training: taken from `activity_type` (default `other`); unknown → `validation_failed:activity_type` (the Milestone 1 behaviour). A training that sends both must send the same value, else `validation_failed:activity_type`.
  - other kinds: create → `sports_event` `other`, `social` `social_gathering`; a race has no default → `validation_failed:event_subtype`. Update → the stored subtype.
  - other kinds ignore a sent `activity_type` (derived).
- `min_participants`: training ≥ 1 (required); every other kind must be null/absent → `validation_failed:min_participants`.
- `max_participants`: ≥ `coalesce(min_participants, 1)` → else `validation_failed:max_participants`.
- `distance_km`: JSON number, > 0, ≤ 1000, at most 2 decimals (never rounded silently); `elevation_gain_m`: integer 0..20000; `obstacle_count`: integer 0..500. On a subtype that does not take them → `validation_failed:<field>`.
- `event_notes`: string ≤ 1000 after cleaning, any kind. The announcement text hygiene (C3/Q4-5): C0/C1 controls and bidi embedding/override/isolate controls stripped, CR LF / CR / U+2028 / U+2029 become LF, trimmed; whitespace-only = null; invisible-only (zero-width, bidi only, ...) → `validation_failed:event_notes`.
- **Absent vs null for the P1 keys on update:** `distance_km`, `elevation_gain_m`, `obstacle_count`, `event_notes` **absent → keep the stored value**, null → clear. So an app build from before P1 (which sends the Milestone 1 form) can edit a race without wiping its fields. The Milestone 1 keys keep their full-replace meaning. Changing to a subtype that does not take a stored field requires sending it as null.
- **Backward compatibility:** the Milestone 1 payload (no kind keys) creates/updates a training exactly as before, subtype = `activity_type`.
- Order of validation (first failure wins): title, description, event_kind, event_subtype / activity_type, starts_at, ends_at, rsvp_deadline (format), timezone, location fields, map_url, meeting_instructions, min_participants, max_participants, distance_km, elevation_gain_m, obstacle_count (ranges, then subtype rules in that order), event_notes; then the time rules of create / update.

## Rules per kind

| | `training` | `race`, `sports_event`, `social` |
|---|---|---|
| Minimum | required (≥ 1) | none (null) |
| Status at creation | `scheduled` | **`confirmed`** (`decided_at` null) |
| Decided by `finalize_due_sessions` | yes, unchanged | **never** (the finalizer only selects trainings with a minimum) |
| `set_rsvp` open while | `scheduled` and before the deadline (a training confirmed by the finalizer keeps answering `rsvp_closed`, as before) | `confirmed` and before the deadline |
| Capacity (`session_full`) | as before | same rule |
| `update_training` while registration is open (before the deadline) | as before (start future, deadline future and < start, max ≥ going) | **same as an open training**: start (future), deadline (future, < start) and max (≥ `going_count`) editable |
| `update_training` after the deadline | as before: deadline, min, max frozen | deadline frozen (`validation_failed:rsvp_deadline`); **max stays editable** (≥ `going_count`); start may move to the future, after the deadline |
| Attendance time freeze (ended or has records) | unchanged | same rule |
| Kind-specific fields, subtype (within the kind), descriptive fields | editable until cancelled / completed | same |
| `cancel_training` | unchanged | unchanged (organizer; `session_has_attendance`, `session_not_cancellable` as before) |
| Attendance | confirmed and ended, as before | same |
| Reminders 24h / 2h | 24h when `scheduled` or `confirmed`, 2h when `confirmed` (unchanged) | both (always `confirmed`) |

Decision on "the deadline may be moved while in the future": the deadline of a non-training event is editable while the **current** deadline has not passed (the new one must be in the future and before the start). Once it has passed, registration cannot be reopened by moving it.

Removing a member (`remove_member`, `leave_community`, membership deletion) now also releases their `going` RSVP on a non-training event whose registration is open (confirmed, before the deadline), like on a scheduled training; after the deadline the count stands.

## Notifications (texts only; recipients, dedupe keys, deep links unchanged)

| Kind | training | race | sports_event | social |
|---|---|---|---|---|
| `training_created` | New training: X | New race: X | New sports event: X | New social event: X |
| `training_updated` (material change) | Training updated: X | Race updated: X | Sports event updated: X | Social event updated: X |
| `training_cancelled` | Training cancelled: X | Race cancelled: X | Sports event cancelled: X | Social event cancelled: X |
| `training_confirmed` | Training confirmed: X | none | none | none |
| `training_reminder` | Tomorrow: X / Starting soon: X | same | same | same |

- `training_confirmed` only comes from the finalizer deciding a training. An event created already `confirmed` fires only the AFTER INSERT trigger (`training_created`); the UPDATE trigger additionally checks `event_kind = 'training'` before sending a confirmation.
- `event_subtype`, `distance_km`, `elevation_gain_m`, `obstacle_count`, `event_notes`, `max_participants` changes are silent (like description and limits).
- The "not enough participants" body only occurs for trainings.

## Statistics

The session set S is unchanged: completed (attendance finalized), non-cancelled sessions of **every kind** count exactly like trainings in the personal and community statistics. `cancelled_insufficient_participation` can only concern trainings; a cancelled event of another kind counts in `cancelled_by_organizer`. Additive fields: history items (`get_my_attendance_history`, `get_member_attendance_history`) gain `event_kind` and `event_subtype`; `top_sessions` items gain `event_kind` and carry `min_participants: null` for non-training events. No field was renamed.

## Error codes

New: `validation_failed:event_kind`, `validation_failed:event_subtype`, `validation_failed:distance_km`, `validation_failed:elevation_gain_m`, `validation_failed:obstacle_count`, `validation_failed:event_notes`. Changed meaning: `validation_failed:min_participants` is also raised for a minimum on a non-training event. Everything else as before.

## TypeScript (`src/lib/database.types.ts`)

Enum `event_kind` (`EventKind`), table `event_subtypes` (`EventSubtype`), `training_sessions` gains the six columns and `min_participants: number | null` (`EventSession` = `TrainingSession`). `TrainingInput` is now `TrainingEventInput | OtherEventInput` (alias `EventInput`); `AttendanceHistoryItem` gains `event_kind`, `event_subtype`; `TopSession` gains `event_kind` and `min_participants: number | null`.

## Hosted deployment

`npx supabase@latest db push --remote` after the app build that understands non-training events and a nullable `min_participants` is installed (an older app keeps creating and editing trainings, but would show races as trainings without a minimum).

## Q8 fixes

- `title`, `description` and `meeting_instructions` of `create_training` / `update_training` now get the same text hygiene as `event_notes` (control and bidi-override characters stripped, line breaks normalized, whitespace-only = null, invisible-only text rejected with `validation_failed:<field>`; length is checked after cleaning). Normal text is unchanged. Migration `20261127000100_events_text_hygiene.sql`; no signature or privilege change.
- Future: `create_invitation` takes an absolute `p_expires_at` computed on the device; a server-side duration parameter would remove the dependency on the phone clock.

## Cancellation reason (migration `20261128000100_cancellation_reason.sql`)

- `training_sessions.cancellation_reason text null`: free-text note, 1..300 characters, only on a `cancelled` event (table check). It is separate from the enum `cancel_reason` (`organizer` / `insufficient_participation`), which stays the machine-readable cause.
- `cancel_training(p_session_id uuid, p_reason text default null) → training_sessions`. The one-argument function was dropped (same name, one function); grant: `authenticated` only. The reason is optional: null, empty or whitespace = none; otherwise cleaned like other free text (control and bidi characters stripped, line breaks normalized) and limited to 300 characters after cleaning; invisible-only or too long -> `validation_failed:cancellation_reason` and nothing is cancelled. Validated after the organizer check. An already `cancelled` event is returned unchanged (its reason is not overwritten). Other errors as before.
- `finalize_due_sessions` (auto-cancel, insufficient participation) stores `Not enough participants: N of M needed.` (N = going, M = minimum).
- Notification `training_cancelled`: body ends `... - cancelled by the organizer. Reason: <reason>` (reason whitespace-collapsed, cut to 200 characters; whole body still limited to 500), or `... - Not enough participants: N of M needed.` for an auto-cancel. Without a reason the text is unchanged.
- App: `cancelTraining(sessionId, reason?)`; the cancel dialog has an optional multiline field (max 300); the event card and details show `Reason: ...` for a cancelled event. `TrainingSession` gains `cancellation_reason: string | null`.
- Hosted deployment: `db push --remote` after an app build that sends `p_reason` is not required (old apps call `cancel_training(uuid)` and PostgREST resolves it to the new function through the default), but old apps will not show the reason.

---

# Event feed (P4, append-only)

Migration `20261129000100_event_feed.sql`. Plan: `docs/EVENTS_PLAN.md` section 4. Tests: `supabase/tests/event-feed.test.ts`, plus the privilege matrix (`qa-privileges.test.ts`) and the Realtime list (`rls.test.ts`). All functions below: `security definer`, `set search_path = ''`, `authenticated` only (anon and service_role: no execute); errors are raised (`P0001`, message = code). No consent gate (posting is part of the service, like RSVP and attendance; no in-community write checks consent, see G1); push consent and preferences apply at send time as for every kind.

## Rules

- **Who:** active organizers of the event's community write top-level posts; every active member (organizers included) replies, one level only. Organizers delete any post; the author of a reply (still an active member) may delete their own reply. Members cannot delete top-level posts or other people's replies.
- **Posting window:** posts and replies are accepted on an event of any status (scheduled, confirmed, cancelled, completed) until **30 days after its end** (`ends_at`, else `starts_at + 2 hours`); afterwards `event_closed`. Reading, marking read and deleting stay allowed.
- **Rate limit:** at most **5 top-level posts per organizer per event per rolling hour** (deleted posts included; replies not counted). The 6th is **refused with `rate_limited`** and nothing is written (no post, no notification). Counted under the organizer's membership lock (`FOR NO KEY UPDATE`), exact under concurrency.
- **Text hygiene:** body through `private.clean_required_text` (multiline), the same cleaner as event notes/title/description: C0/C1 controls and bidi embedding/override/isolate controls stripped, CR LF / CR / U+2028 / U+2029 → LF, trimmed; empty or invisible-only → `validation_failed:body`; over 1000 characters after cleaning → `validation_failed:body`.
- **Leaving / removal:** the member's posts and replies stay (as announcements and attendance history), shown with their name and `author_role: null`; a removed member can no longer read the feed (RLS and RPCs: active members only) and is not notified.

## Tables (RLS on, SELECT only for `authenticated`)

| Table | Columns | Who can select |
|---|---|---|
| `event_posts` | `id`, `session_id` + `community_id` (composite FK → `training_sessions(id, community_id)`, cascade), `author_id? → profiles` (set null; null = deleted account, show "Former member"), `parent_id?` (composite FK `(parent_id, session_id)` → `event_posts(id, session_id)`, cascade: a reply belongs to the same event), `body?` (1..1000; null exactly when deleted), `created_at` (server clock when the post was written), `deleted_at?` | active members of the community (deleted rows are visible as tombstones without a body) |
| `event_feed_reads` | `session_id` (cascade), `user_id → profiles` (cascade), `last_read_at`; pk both | own rows only |

Realtime publication `supabase_realtime` adds `event_posts` (RLS filters per subscriber; subscribe with `session_id=eq.<id>`). A deletion arrives as an UPDATE (body null, `deleted_at` set). `event_feed_reads` is not published.

## RPCs

`create_event_post(p_session_id uuid, p_body text) → event_posts`
- Errors in order: `not_authenticated`, `not_found` (unknown / null event), `forbidden` (members, removed organizers, other communities' organizers), `event_closed`, `validation_failed:body`, then after the locks `forbidden` (removed / demoted meanwhile) and `rate_limited`.
- Notifies (`event_post`) the active members whose RSVP for the event is `going`, never the author.

`reply_to_event_post(p_post_id uuid, p_body text) → event_posts`
- Errors in order: `not_authenticated`, `not_found` (unknown / null post), `not_a_member`, `not_a_top_level_post` (the target is a reply), `post_deleted`, `event_closed`, `validation_failed:body`; after the locks `not_a_member` / `post_deleted` again (a concurrent delete wins).
- Notifies (`event_reply`) only the parent post's author, when that is not the caller and the author is still an active member.

`delete_event_post(p_post_id uuid) → event_posts`
- Soft delete: `deleted_at` set, `body` null. Deleting a top-level post deletes its replies the same way. The in-app notifications quoting the deleted posts (`event_post:<id>` / `event_reply:<id>`) are deleted, their push jobs cascade. Already deleted: returned unchanged.
- Errors: `not_authenticated`, `not_found`, `forbidden` (re-checked under the membership and post locks).

`mark_event_feed_read(p_session_id uuid) → event_feed_reads`
- Active member. Moves the caller's cursor to the server's now (never backwards) and marks the caller's unread `event_post` / `event_reply` notifications of that event read. Errors: `not_authenticated`, `not_found`, `not_a_member`.
- Exactness: writers hold a shared per-event advisory lock and take `created_at` from the clock after it; the cursor takes it exclusively. A post being written while the cursor moves commits first, and a post started later gets a later `created_at`, so a post is never counted as read before it was visible.

`get_event_feed(p_session_id uuid) → jsonb` (`EventFeed`)
```
{ session_id, community_id, is_organizer, closes_at, is_open, can_post (is_organizer and is_open), can_reply (is_open),
  last_read_at (null = never opened), post_count, unread_count,
  posts: [ { id, parent_id: null, author_id, author_name, author_role ('organizer'|'member'|null), body, created_at, is_unread, can_delete,
             replies: [ { id, parent_id, author_id, author_name, author_role, body, created_at, is_unread, can_delete } ] } ] }
```
- Top-level posts newest first, replies oldest first. Deleted posts and the replies of a deleted post are left out. `author_role` is the author's current active role, null when no longer a member; `author_id` / `author_name` null for a deleted account. `can_delete`: the caller is an organizer, or it is the caller's own reply. Counts include replies. **Unread** = not written by the caller and `created_at > last_read_at` (everything of others when the caller never opened the feed). Not paginated. Errors: `not_authenticated`, `not_found`, `not_a_member`.

`get_event_feed_unread(p_community_id uuid) → jsonb` (`EventFeedUnread[]`)
- `[ { session_id, post_count, unread_count, last_post_at } ]` for every event of the community with visible posts, latest activity first. Same counting rules. Errors: `not_authenticated`, `not_a_member` (also for unknown / null communities).

## Notification kinds (added to `notification_kind`)

| Kind | Fired when | Recipients | Title / body | Dedupe key | Deep link |
|---|---|---|---|---|---|
| `event_post` | `create_event_post` | active members with RSVP `going`, minus the author | `New post: <event title>` / post preview (whitespace collapsed, 200 chars) | `event_post:<post id>` | `/events/<event id>/feed` |
| `event_reply` | `reply_to_event_post` | the parent post's author (active, not the replier) | `New reply: <event title>` / `<replier name>: <preview>` | `event_reply:<reply id>` | `/events/<event id>/feed` |

- `related_session_id` = the event. `notifications_deep_link_check` now allows `/activity`, `/trainings/<uuid>`, `/announcements/<uuid>` and `/events/<uuid>/feed` (lowercase uuid, nothing else). **App:** add `/events/<uuid>/feed` to `src/features/notifications/domain/deepLink.ts` and a route for it (it can show the event details scrolled to the feed); until then the app ignores these links.
- Push preferences: both kinds fall in the `training_updates` category of `claim_notification_jobs` (its `else` branch; unchanged, no new preference column), then push consent (`no_push_consent`), exactly like the training kinds. Push expiry: one day.

## GDPR

- **Export** (`export_my_data`): `authored.event_posts: [ { post_id, session_id, community_id, community_name, event_title, parent_id, body, created_at, deleted_at } ]` (the caller's posts and replies; deleted ones with `body: null`), `event_feed_reads: [ { session_id, community_id, event_title, last_read_at } ]`, `truncated.event_posts`, `truncated.event_feed_reads`; the README mentions both. Nothing of other members.
- **Erasure** (`private.erase_user`, so `delete_my_account`): the user's **replies are deleted**, together with the `event_reply` notifications that quote them; the user's **top-level posts stay without author** (`author_id` null, as announcements), so other members' replies under them survive; the user's read cursors are deleted. `DeleteMyAccountResult` is unchanged.

New error codes: `not_a_top_level_post`, `post_deleted`, `event_closed`, `validation_failed:body` (event posts); `rate_limited` (already used by announcements and the export) for the post limit. Existing ones used: `not_authenticated`, `not_found`, `not_a_member`, `forbidden`.

TypeScript (`src/lib/database.types.ts`): tables `event_posts` (`EventPost`), `event_feed_reads` (`EventFeedRead`); `EventFeed`, `EventFeedItem`, `EventFeedUnread`; `NotificationKind` gains `event_post`, `event_reply`; `MyDataExport` gains `event_feed_reads`, `authored.event_posts` and the two `truncated` keys.

---

# About you (P3, append-only)

Migration `20261130000100_about_you.sql`. Plan: `docs/EVENTS_PLAN.md` section 3, `docs/GDPR_PLAN.md` sections 1-2. Tests: `supabase/tests/about-you.test.ts`, `supabase/tests/about-you-qa.test.ts`, plus the privilege matrix (`qa-privileges.test.ts`) and the GDPR suites (`data-export.test.ts`, `account-deletion.test.ts`). All functions below: `security definer`, `set search_path = ''`, `authenticated` only (anon and service_role: no execute); errors are raised (`P0001`, message = code).

## Storage

`private.member_about_you` (one row per member, `user_id` → `profiles`, cascade): `birth_year?`, `gender?` (`woman` | `man` | `prefer_not_to_say`), `emergency_contact_name?` (1-80), `emergency_contact_phone?` (1-30), `emergency_contact_relationship?` (1-40), `tshirt_size?` (`XS` | `S` | `M` | `L` | `XL` | `XXL`), `created_at`, `updated_at`. Every field optional. An emergency contact is name + phone (relationship optional) or nothing; a row with no field is deleted. The table is in the `private` schema: **no API role (anon, authenticated, service_role) holds any privilege on it**, not even SELECT; everything goes through the functions below. Not in the Realtime publication.

## Consent (G1 ledger)

| Field | Needed to SET it | Withdrawal (`withdraw_consent`) |
|---|---|---|
| `birth_year`, `gender` | current `profile_demographics` | `profile_demographics` deletes both |
| `emergency_contact_*`, `tshirt_size` | current `emergency_contact` (GDPR_PLAN groups them: safety at events, race kits) | `emergency_contact` deletes the three contact fields and the T-shirt size |

- Clearing a field (null) never needs consent. Withdrawing deletes the covered fields in the same transaction, also when no grant is on record (`changed: false`, nothing written to the ledger), like push tokens since Q7-2. `withdraw_consent`'s result shape is unchanged.
- Defence in depth: organizer reads and the demographics ignore a field whose consent is not current.
- Saving and withdrawing take the per-user consent lock (`private.lock_consents`), so a save can never interleave with a withdrawal.

## RPCs (own data)

`get_my_about_you() → jsonb` (`AboutYou`)
```
{ has_data, birth_year, gender, emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
  tshirt_size, updated_at (null = nothing stored), birth_year_min, birth_year_max,
  consents: { profile_demographics: boolean, emergency_contact: boolean } }
```
- `birth_year_min` / `birth_year_max` = server year (UTC) - 100 / - 16 (minimum age 16): use them for the picker, not the device clock. Works without a profile (all null). Errors: `not_authenticated`.

`save_my_about_you(p_input jsonb) → jsonb` (`AboutYou`)
- **Partial update:** `p_input` is an object with any of `birth_year`, `gender`, `emergency_contact_name`, `emergency_contact_phone`, `emergency_contact_relationship`, `tshirt_size`. A key that is **absent** leaves the field unchanged; a key with **`null` clears** it. Unknown keys or a non-object → `validation_failed:input`. A save that leaves no field deletes the row.
- Validation: `birth_year` JSON integer in [server year - 100, server year - 16]; `gender` exact lowercase value; `tshirt_size` any case, trimmed, stored upper case; texts through `private.clean_required_text` single-line (controls and bidi controls stripped, whitespace collapsed, trimmed, empty / invisible-only refused), name ≤ 80, relationship ≤ 40, phone ≤ 30 characters made of digits, spaces and `+ ( ) . / -` with 6-20 digits. Empty strings are refused (send `null` to clear).
- Errors in order: `not_authenticated`, `validation_failed:input`, `validation_failed:<field>`, then after the locks `not_a_member` (no profile: never joined, or account being deleted), `consent_required:profile_demographics` (setting birth year / gender), `consent_required:emergency_contact` (setting a contact field or the T-shirt size), and `validation_failed:emergency_contact_name` / `validation_failed:emergency_contact_phone` when the merged contact would be incomplete (to remove a contact send all three as null).

`clear_my_about_you() → jsonb` (`AboutYou & { cleared }`)
- Deletes all the caller's details. Consents stay as they are. `cleared: false` when nothing was stored. Errors: `not_authenticated`.

## RPCs (organizers)

`get_member_emergency_info(p_community_id uuid, p_user_id uuid) → jsonb` (`MemberEmergencyInfo`)
```
{ community_id, user_id, display_name, role, emergency_contact_name, emergency_contact_phone,
  emergency_contact_relationship, tshirt_size, has_emergency_contact, updated_at }
```
- Caller: active organizer of the community. Target: an **active** member of that community (organizers included). Never returns birth year or gender. Fields null when not given, and all four null when the member's `emergency_contact` consent is not current.
- Errors: `not_authenticated`, `forbidden` (not an active organizer there; also null / unknown community), `validation_failed:user_id`, `not_found` (unknown user, member who left or was removed, member of another community).

`list_community_emergency_info(p_community_id uuid) → jsonb` (`CommunityEmergencyList`)
- `{ community_id, members: [MemberEmergencyInfo without community_id], truncated }`: active members (organizers included) with a current `emergency_contact` consent and an emergency contact or a T-shirt size, by display name, at most 500. Errors: `not_authenticated`, `forbidden`.

**Leaving / removal / demotion:** checked at read time from `memberships`, so access ends the moment a member leaves (`leave_community`) or is removed (`remove_member`), and an organizer who is demoted or removed loses access at once. A member active in another community stays visible to that community's organizers.

`get_community_demographics(p_community_id uuid) → jsonb` (`CommunityDemographics`)
```
{ community_id, min_group_size: 5, min_members_with_data: 20, rounded_to: 5, member_count, reference_year,
  insufficient_data: { age_bands: boolean, genders: boolean },
  age_bands: [ { key, count, suppressed } ],   -- under_18, 18_29, 30_39, 40_49, 50_59, 60_plus, not_provided
  genders:   [ { key, count, suppressed } ] }  -- woman, man, prefer_not_to_say, not_provided
```
- Caller: active organizer. Population: the community's **active** members (organizers included); a missing field or one without current consent is `not_provided`. Age = `reference_year` (server, UTC) - birth year (the age reached this calendar year). `member_count` is exact (organizers see the member list anyway). Errors: `not_authenticated`, `forbidden`.
- **Publication rule (each dimension separately, `private.publish_demographic_cells`; `count` null when suppressed). The numbers are approximate group totals (P3-QA-1):**
  1. **Minimum data:** unless at least 20 active members have a value for the dimension (any cell except `not_provided`), every cell is suppressed and `insufficient_data.<dimension>` is true.
  2. **Suppression of the exact counts:** (a) every cell below 5 (0 included) is suppressed; (b) while the suppressed cells are only one, or add up to less than 5, the smallest remaining cell (first in the listed order on ties) is suppressed too; (c) stop when nothing is suppressed, when at least two suppressed cells add up to 5 or more, or when everything is suppressed. Why: the organizer knows `member_count`, so the sum of the suppressed cells can be estimated by subtraction; the rule makes it cover at least 5 people over at least 2 categories.
  3. **Rounding:** every shown count is the real count rounded to the nearest multiple of 5 (`rounded_to`; remainder 0-2 down, 3-4 up), so it is at least 5 and within 2 of the real count; a cell whose rounded value would be 0 is never shown (cannot happen after step 2). The app must present them as approximate ("about 10").
  There is no age × gender cross-table.
- **What this protects:** no organizer ever sees a person's age or gender; a group's exact size is never returned; adding a few accounts once (sock puppets through an invitation code) no longer reveals a hidden group: with 1, 2 or 3 real members in a group the answer is identical (test "P3-QA-1" in `about-you-qa.test.ts`). Honest privacy wording: "organizers see only approximate group totals (rounded to 5), and nothing until at least 20 members have answered".
- **Known limits (not prevented):** repeated differencing over time: an organizer who adds or removes accounts (or watches members join, leave or edit) one at a time and queries after each change can find where a rounded total crosses a rounding boundary and so infer a hidden group's size (each added account needs an invitation code redemption, which is recorded; test "KNOWN LIMIT: adding accounts one at a time ..."); an organizer of two communities with overlapping members can compare the two results. The app should not offer history or comparisons of these numbers.

## GDPR

- **Export** (`export_my_data`): `extensions.about_you: { birth_year, gender, emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, tshirt_size, created_at, updated_at } | null` (always present); the README mentions it.
- **Erasure** (`private.erase_user`, so `delete_my_account`): the row is deleted (explicitly, and by the cascade from `profiles`). `DeleteMyAccountResult` is unchanged.

New error codes: `consent_required:profile_demographics`, `consent_required:emergency_contact`, `validation_failed:input`, `validation_failed:birth_year`, `validation_failed:gender`, `validation_failed:emergency_contact_name`, `validation_failed:emergency_contact_phone`, `validation_failed:emergency_contact_relationship`, `validation_failed:tshirt_size`. Existing ones used: `not_authenticated`, `not_a_member`, `forbidden`, `not_found`, `validation_failed:user_id`.

TypeScript (`src/lib/database.types.ts`): functions `get_my_about_you`, `save_my_about_you`, `clear_my_about_you`, `get_member_emergency_info`, `list_community_emergency_info`, `get_community_demographics`; types `AboutYou`, `AboutYouInput`, `AboutYouGender`, `TshirtSize`, `ClearAboutYouResult`, `MemberEmergencyInfo`, `CommunityEmergencyList`, `DemographicsCell`, `AgeBand`, `CommunityDemographics`; `MyDataExport.extensions.about_you`. No table type (the table is not reachable by the API).

---

# Workout logs (P5, append-only)

Migration `20261201000100_workout_logs.sql`. Plan: `docs/EVENTS_PLAN.md` section 5, `docs/GDPR_PLAN.md`; definitions: `docs/STATS_DEFINITIONS.md` "Workout statistics (P5)". Tests: `supabase/tests/workout-logs.test.ts`, plus the privilege matrix (`qa-privileges.test.ts`) and the GDPR suites (`data-export.test.ts`, `account-deletion.test.ts`, `about-you.test.ts`). All functions below: `security definer`, `set search_path = ''`, `authenticated` only unless stated (anon and service_role: no execute); errors are raised (`P0001`, message = code).

## Storage

`private.workout_logs`: one row per (member, event), unique `(user_id, session_id)`. Columns: `id`, `user_id → profiles` (cascade), `session_id` (no foreign key: a log outlives its event), `community_id`, `log_type` (`strength` | `running` | `race`), event snapshot `event_title`, `event_starts_at`, `event_kind`, `event_subtype` (refreshed on every save), `distance_m?` (1..1 000 000), `duration_s?` (1..604 800), `pace_s_per_km?` (generated: `round(duration_s × 1000 / distance_m)`, null unless both), `exercises?` (strength: JSON array), `strength_volume_kg?` (strength: Σ reps × weight_kg), `notes?` (1..1000), `created_at`, `updated_at`. `private.workout_prompt_runs(session_id → training_sessions cascade, sent_at)`: the events the prompt job has handled. Both tables are in the `private` schema: **no API role (anon, authenticated, service_role) holds any privilege on them**; not in the Realtime publication. **Logs are private to their owner: no function returns another member's log, organizers included.**

## Log type (derived from the event, never chosen by the client)

| Event | `log_type` |
|---|---|
| kind `race` (trail_running, asphalt_running, ocr) | `race` |
| kind `training` / `sports_event` whose activity type is `running`, `trail_running` or `ocr` | `running` |
| kind `training` / `sports_event` whose activity type is `strength` or `functional_fitness` (CrossFit events included) | `strength` |
| anything else: `social` events, activity `other` (training "Other", public trainings) | not loggable (`not_loggable`, no prompt) |

## Who can log

An **active member** of the event's community whose RSVP is **`going`** OR whose attendance is recorded **`present`** (walk-ins included), on a **`confirmed` or `completed`** event whose **end has passed** (end = `ends_at`, else `starts_at + 2 hours`). There is no upper time limit. Reading, listing and deleting one's own logs need neither membership nor consent.

## Consent (G1 ledger)

- **Saving** a log requires a current **`workout_logs`** consent, otherwise `consent_required:workout_logs` (nothing written). The app should ask for it on the log screen (`has_consent` in `get_my_workout_log`) with `record_consent('workout_logs', <privacy version>)`, then save.
- **Withdrawing** (`withdraw_consent('workout_logs')`) deletes **every** log of the member in the same transaction, also when no grant is on record (`changed: false`), like push tokens and About you. Result shape unchanged.
- The **prompt is sent regardless of consent** (owner decision 2026-11-23: a neutral reminder). Saving and withdrawing take the per-user consent lock, so a save never interleaves with a withdrawal.
- Defence in depth: the community totals ignore logs of members without a current consent.

## RPCs (own logs)

`save_workout_log(p_session_id uuid, p_input jsonb) → jsonb` (`WorkoutLog`)
- **Creates or replaces the whole log** (not a partial update: a key left out is cleared). `p_input` by log type, unknown keys → `validation_failed:input`:
  - `strength`: `{ exercises?: [ { name, sets: [ { reps, weight_kg? } ] } ], notes? }`; at least one exercise or a note (else `validation_failed:exercises`). At most 30 exercises (`validation_failed:exercises`, also for a non-array, a non-object item or an extra key); `name` string, single-line text hygiene, 1..80 (`validation_failed:exercise_name`); `sets` 1..20 objects with only `reps` / `weight_kg` (`validation_failed:sets`); `reps` JSON integer 1..1000 (`validation_failed:reps`); `weight_kg` JSON number 0..1000 in steps of 0.25, absent / null = 0 (bodyweight) (`validation_failed:weight_kg`). Stored normalized (`{ name, sets: [ { reps, weight_kg } ] }`).
  - `running`: `{ distance_m?, duration_s?, notes? }`; at least one of distance / duration (else `validation_failed:distance_m`).
  - `race`: `{ distance_m?, duration_s, notes? }`; `duration_s` = finish time, required (`validation_failed:duration_s`). The app can prefill the distance from the event's `distance_km` (`get_my_workout_log`).
  - `distance_m` JSON integer 1..1 000 000 (`validation_failed:distance_m`), `duration_s` JSON integer 1..604 800 = 7 days (`validation_failed:duration_s`), `notes` multiline text hygiene (`private.clean_required_text`: controls and bidi controls stripped, line breaks normalized, trimmed), at most 1000 characters, blank = no note, invisible-only or over 1000 → `validation_failed:notes`.
  - **Plausibility (P5-QA-7):** when both `distance_m` and `duration_s` are given, the pace must lie between **1:00 and 30:00 min/km** inclusive (`60 <= 1000 × duration_s / distance_m <= 1800`, exact, before rounding), else `validation_failed:duration_s` (the app should show it on the time field, e.g. "Check the time: the pace would be faster than 1:00 or slower than 30:00 per km"). A distance or a time alone is not checked.
  - Pace is computed by the database (`pace_s_per_km`).
- Errors in order: `not_authenticated`, `validation_failed:input` (not an object), `not_found` (unknown / null event), `not_a_member`, `not_loggable` (kind / activity, or status `scheduled` / `cancelled`), `event_not_ended`, `not_eligible` (neither going nor present), `validation_failed:input` (key not allowed for this type), `validation_failed:<field>`, then after the locks `not_a_member` (no profile: account being deleted), `consent_required:workout_logs`, `not_found` (event deleted meanwhile).

`get_my_workout_log(p_session_id uuid) → jsonb` (`WorkoutLogScreen`)
```
{ session_id, community_id,
  event: { title, starts_at, ends_at, event_kind, event_subtype, distance_km, status } | null,   -- null: event deleted
  log_type: 'strength'|'running'|'race'|null,                                                    -- null: not loggable
  can_log, cannot_log_reason: null|'not_a_member'|'not_loggable'|'event_not_ended'|'not_eligible'|'not_found',
  has_consent, log: WorkoutLog | null }
```
- A member who left or was removed keeps read access to their own log (`can_log: false`, `not_a_member`) but gets **`event: null`** and `log_type` from the log (P5-QA-6: never the current, possibly edited event; the log's own `event_title` / `event_starts_at` / `event_kind` / `event_subtype` snapshot is what the screen shows). Errors: `not_authenticated`, `not_found` (unknown event and no own log), `not_a_member` (event exists, caller not an active member and has no log of it).

`WorkoutLog`:
```
{ id, session_id, community_id, log_type, event_title, event_starts_at, event_kind, event_subtype,
  distance_m, duration_s, pace_s_per_km, exercises: [ { name, sets: [ { reps, weight_kg } ] } ] | null,
  strength_volume_kg, notes, created_at, updated_at }
```

`delete_my_workout_log(p_session_id uuid) → jsonb` → `{ session_id, deleted }` (false when there was none). Works after leaving and for a deleted event. Errors: `not_authenticated`.

`list_my_workout_logs(p_limit integer default 20, p_before timestamptz default null) → jsonb` → `{ logs: WorkoutLog[], next_before }`
- The caller's logs in every community (also ones left), newest event first (`event_starts_at desc, id desc`). `p_before`: only events that started strictly before it. A page holds `p_limit` logs plus any further logs with the same event start as the last one (a page boundary never splits a tie); pass `next_before` as `p_before` for the next page (null = no more). Errors: `not_authenticated`, `validation_failed:limit` (not 1..100).

## Statistics

`get_my_workout_stats(p_community_id uuid default null, p_from timestamptz default null, p_to timestamptz default null) → jsonb` (`MyWorkoutStats`)
```
{ community_id, from, to, sessions_logged, running_sessions, race_sessions, strength_sessions,
  total_distance_m, total_duration_s, average_pace_s_per_km (null when no log has both), pace_sessions,
  strength_volume_kg, strength_sets }
```
- Own logs only; `p_community_id` null = all; window on the event start recorded in the log, `p_from <= start <= p_to`. Errors: `not_authenticated`, `validation_failed:range` (`p_from > p_to`). Definitions: `docs/STATS_DEFINITIONS.md`.

`get_community_workout_stats(p_community_id uuid, p_window text default '30d') → jsonb` (`CommunityWorkoutStats`)
```
{ community_id, window, from, to, min_contributors: 20, insufficient_data,
  members_contributing, sessions_logged, total_distance_km, total_duration_minutes, average_pace_s_per_km }
```
(Shape unchanged by the P5-QA-1/2/3 fix; only `min_contributors` (now 20), the rule and the rounding changed.)
- **Organizers only** (active organizer of the community); members get `forbidden` (decision: members see no community totals). Population: logs of the community's non-cancelled events starting in the window (`7d` / `30d` / `90d` / `all`, as the attendance statistics), by members who are **active now** and hold a current consent (leaving removes a member's contribution at once; their own logs stay).
- **Publication rule (fixed after P5-QA-1/2/3):** nothing (all metrics null, `insufficient_data: true`) unless **at least 20 distinct members** logged in the window; each metric also needs 20 contributors of its own (distance: 20 with a distance; time: 20 with a duration; pace: 20 with both), else null; **nested windows:** a window (and each metric of it) is published only when the members with a log in the band between it and the next smaller window in which it was published number **0 or at least 20** (so no two published answers can be subtracted to isolate fewer than 20 members; `insufficient_data: true` also covers a window suppressed by this rule); shown values are **rounded**: members and sessions to the nearest 5, distance to the nearest **10 km**, time to the nearest **30 minutes**, pace to the nearest **10 s/km**. The app must present them as approximate ("about 25 sessions"). Known limit: differencing over time and accounts controlled by the organizer, to within the rounding (see `STATS_DEFINITIONS.md`).
- Errors: `not_authenticated`, `forbidden` (also null / unknown community), `validation_failed:window`.

## The post-event prompt (notification kind `workout_log_prompt`)

`enqueue_workout_log_prompts() → integer` (**service_role** only; pg_cron job `trainhive_workout_log_prompts`, every minute, same guarded pattern as the other jobs: a warning with the manual `cron.schedule` command when pg_cron is unusable).

| Kind | Fired when | Recipients | Title / body | Dedupe key | Deep link |
|---|---|---|---|---|---|
| `workout_log_prompt` | an event's end + 15 minutes has passed (end = `ends_at`, else `starts_at + 2 h`), the event is `confirmed` or `completed`, loggable, and its end lies within the **last 48 hours** (P5-QA-8: no backfill flood on the first run or after an outage) | active members whose RSVP is `going` (organizers included) who have no log of it yet; **regardless of the `workout_logs` consent** | `How did it go?` / `Log your workout: <event title>` | `workout_log_prompt:<event id>` | `/events/<event id>/log` |

- Idempotent: each event is claimed once in `private.workout_prompt_runs`, and the dedupe key stops a second notification per member (tested: repeated and concurrent runs send one each). Cancelled, scheduled (undecided), unloggable, future and older-than-48-hours events get nothing (never, also on later runs); neither do members who are not going or no longer active.
- `related_session_id` = the event. `notifications_deep_link_check` now allows `/activity`, `/trainings/<uuid>`, `/announcements/<uuid>`, `/events/<uuid>/feed` and **`/events/<uuid>/log`** (lowercase uuid, nothing else).
- Push: preference category **`training_updates`** (the `else` branch of `claim_notification_jobs`, unchanged), then push consent at send time, like every kind. Push expiry: one day. Texts carry no workout data.
- **App:** add `/events/<uuid>/log` to `src/features/notifications/domain/deepLink.ts` and a route `events/[id]/log`; add `workout_log_prompt` to `KIND_ICON` in `src/features/notifications/components/NotificationRow.tsx` (its `Record<NotificationKind, IconName>` does not typecheck without it).

## GDPR

- **Export** (`export_my_data`): `extensions.workout_logs: [ WorkoutLog without id, with log_id ]` (oldest event first, at most 5000) and `truncated.workout_logs`; the README mentions it. Nothing of other members.
- **Erasure** (`private.erase_user`, so `delete_my_account`): every log of the user is deleted (explicitly, and by the cascade from `profiles`). `DeleteMyAccountResult` is unchanged.
- **Withdrawal:** see Consent. **Leaving / removal:** the member keeps their logs (personal data); they no longer count in that community's totals.
- **Event deleted** (only when its community is deleted with its last member's account): the log stays with its snapshot; `get_my_workout_log` returns `event: null`, `cannot_log_reason: 'not_found'`; it can still be deleted by session id.

New error codes: `not_loggable`, `event_not_ended`, `not_eligible`, `consent_required:workout_logs`, `validation_failed:exercises`, `validation_failed:exercise_name`, `validation_failed:sets`, `validation_failed:reps`, `validation_failed:weight_kg`, `validation_failed:distance_m`, `validation_failed:duration_s`, `validation_failed:notes`, `validation_failed:limit`, `validation_failed:range`. Existing ones used: `not_authenticated`, `not_found`, `not_a_member`, `forbidden`, `validation_failed:input`, `validation_failed:window`.

TypeScript (`src/lib/database.types.ts`): functions `save_workout_log`, `get_my_workout_log`, `delete_my_workout_log`, `list_my_workout_logs`, `get_my_workout_stats`, `get_community_workout_stats`, `enqueue_workout_log_prompts`; types `WorkoutLogType`, `WorkoutSet`, `WorkoutExercise`, `WorkoutLogInput`, `WorkoutLog`, `WorkoutLogBlockReason`, `WorkoutLogScreen`, `DeleteWorkoutLogResult`, `WorkoutLogPage`, `MyWorkoutStats`, `CommunityWorkoutStats`; `NotificationKind` gains `workout_log_prompt`; `MyDataExport.extensions.workout_logs` (optional: absent in files exported before P5) and `truncated.workout_logs`. No table type (the tables are not reachable by the API).

Legal / app notes: `FEATURES.workoutLogs` stays false until the app ships. The tripwire `src/features/legal/qa-gdprCopy.test.ts` looks for `public.workout_logs ` in the migrations, but the table is `private.workout_logs`, so the app task must update that check when it turns the flag on. The privacy notice must then describe the logs (what, why, owner only, organizers see only rounded totals from 20 members, deleted on withdrawal or account deletion).

---

# Retention (G3, append-only)

Migration `20261202000100_retention.sql`. Tests: `supabase/tests/retention.test.ts`; privilege matrix in `qa-privileges.test.ts`. Plan: `docs/GDPR_PLAN.md` section 4 item 6. Register of every table: `docs/RECORD_OF_PROCESSING.md` section 7.

**Rule (only while enabled).** An anonymous account (`auth.users.is_anonymous`) with no activity for **24 months** gets an inactivity notice. Any activity ends the notice. When the notice is **30 days** old and the account is still inactive, it is erased with `private.erase_user`, exactly like `delete_my_account` (attendance anonymized, a community where it is the last active member deleted, auth user deleted). The last active organizer of a community with other active members is never erased (counted as `blocked_last_organizer`, notice kept, retried every run). At most 100 erasures per run. Linked (non-anonymous) accounts are not handled.

**Kill switch: disabled by default** (`private.retention_settings.inactive_erasure_enabled = false`). While disabled nothing is noticed or erased and the job writes nothing. Switching off clears every pending notice, so switching on always starts a fresh 30-day window.

**Activity** (`private.account_last_activity(user)`, computed by the job; no existing RPC changed): the latest of `auth.users.created_at` / `last_sign_in_at`, `record_app_open`, profile update, membership join, consent ledger entry, push token registration (`last_seen_at`), RSVP change, the member's `present` attendance records, attendance the member recorded, notifications read, announcements read, event feed read, event posts written, announcements and events authored (`updated_at`), workout logs, About you, data exports, invitation attempts.
Limits: (1) a member who only reads, with push off, in an app version that does not call `record_app_open`, leaves no trace; enable the clean-up only after the app version that calls it is the one in use. (2) `auth.sessions` / refresh tokens (token refreshes) are not used: their columns differ between Supabase Auth versions and a mismatch would break the migration; after deploying, the owner can check them with `select column_name from information_schema.columns where table_schema = 'auth' and table_name = 'sessions';` and they can be added later. (3) Some signals move on other people's actions (an organizer editing old attendance or an event): they can only keep an account longer.

## `record_app_open() → jsonb` (authenticated)

Call on app start and on every return to the foreground, once signed in. Records the app open (at most one write per hour per account) and ends a pending notice. Returns `AppOpenResult` `{ inactivity_erasure_enabled, inactive_after_months: 24, notice_days: 30, notice: { noticed_at, erase_after } | null }`: `notice` is the notice that was pending **before** this call (now ended); when it is not null show a one-time banner such as "This account had been inactive for 2 years and was going to be deleted on <erase_after>. Because you opened the app, it is kept." Errors: `not_authenticated` (no user, or the account no longer exists, also when it was erased while the call waited). Fire and forget: a failure must not block the app.

## `retention_preview() → jsonb` (service_role; also `postgres` in the SQL editor)

Dry run, counts only, writes nothing. `RetentionPreview` `{ enabled, inactive_after_months, notice_days, generated_at, anonymous_accounts, inactive_accounts, inactive_without_notice, notices_pending, due_for_erasure, blocked_last_organizer, communities_deleted_with_due, communities_of_inactive_sole_members, last_run: { ran_at, notices_created, notices_cleared, accounts_erased, communities_deleted, blocked_last_organizer, deferred } | null }`.

## `run_account_retention() → jsonb` (service_role; pg_cron `trainhive_account_retention`, daily 03:41 UTC)

`RetentionRunResult` `{ enabled, notices_created, notices_cleared, accounts_erased, communities_deleted, blocked_last_organizer, deferred, due_remaining }`. Disabled: `enabled: false`, all zero, nothing written. Steps: end notices of accounts that came back; give new notices; erase due accounts (per account: `private.lock_user_for_erasure`, re-check the activity under those locks, then `private.erase_user`); log the counts in `private.retention_runs` (kept 2 years). Idempotent. One run at a time (the settings row is locked). `lock_timeout` 5 s: an account whose rows are busy, or a deadlock, is counted as `deferred` and retried next day; any other error aborts the whole run.

## `admin_set_retention_enabled(p_enabled boolean) → jsonb` (service_role; also `postgres`)

`RetentionSwitchResult` `{ enabled, changed, notices_cleared }`. Errors: `validation_failed:enabled` (null). Enable deliberately: `select public.admin_set_retention_enabled(true);`.

## Export, erasure, privileges

- `export_my_data`: `extensions.account_activity: { last_app_open_at, inactivity_notice_at } | null`; README sentence added. Nothing else changed.
- Erasure: `private.account_activity` goes with the auth user (cascade); `private.erase_user` unchanged.
- Tables `private.retention_settings`, `private.account_activity`, `private.retention_runs`: no API role has any privilege. Helpers `private.account_last_activity`, `private.inactive_accounts`, `private.retention_inactive_after`, `private.retention_notice_period`: no API role can execute them.
- Lock order: job = settings row → per account the erasure order (consent lock → … → `auth.users` FOR UPDATE → …) → the account's activity row. `record_app_open` = `auth.users` FOR KEY SHARE → activity row. The job's notice insert skips accounts that already have a notice, so it never holds the activity row of an account it may erase in the same run (tested: a concurrent `record_app_open` either keeps the account or gets `not_authenticated` after the erasure).

New error code: `validation_failed:enabled`. TypeScript (`src/lib/database.types.ts`): functions `record_app_open`, `retention_preview`, `run_account_retention`, `admin_set_retention_enabled`; types `AppOpenResult`, `RetentionPreview`, `RetentionRunLog`, `RetentionRunResult`, `RetentionSwitchResult`; `MyDataExport.extensions.account_activity` (optional).

**App (not done, mobile task):** call `record_app_open()` on start and foreground (signed in only), show the one-time banner, mention the new export key in the download summary if wanted. **Legal:** the notice must describe the clean-up before it is enabled (`docs/CLAIMS_AUDIT.md`, gap B).

---

# Invitation expiry on the server (O1) and the account-deletion fallback (append-only)

Migration `20261203000100_invitation_duration.sql`. Tests: `supabase/tests/invitation-duration.test.ts`, `supabase/tests/delete-account-fallback.test.ts`; privilege matrix in `qa-privileges.test.ts`.

## `create_invitation(p_community_id uuid, p_expires_at timestamptz default null, p_max_redemptions integer default null, p_expires_in_hours integer default null) → invitation_codes`

Replaces the three-argument signature (dropped; one function, no overload; `authenticated` only, as before). The new parameter is last and defaulted, so old APKs calling by name `{p_community_id, p_expires_at, p_max_redemptions}` and SQL callers with 1-3 positional arguments keep working.

- **`p_expires_in_hours` (current apps):** `0` = never expires; `1..2160` (90 days) = `expires_at = clock_timestamp() + hours` on the **server** clock. Negative, above 2160, or sent together with a non-null `p_expires_at` → `validation_failed:expires_in_hours`.
- **`p_expires_at` (legacy, old APKs):** still accepted, now validated against the server clock: must be after `clock_timestamp()` and at most 90 days after it, else `validation_failed:expires_at` (it used to accept any future time).
- **Both null / omitted:** never expires (unchanged; the only way an old APK says "Never"). Decision: the SQL default stays "no expiry" rather than 30 days, because PostgREST cannot tell an old APK's explicit `p_expires_at: null` ("Never") from an omitted argument. The app's defaults (Quick invite 30 days, the form 7 days) are chosen by the app and sent as a duration.
- Order of checks unchanged: `not_authenticated`, `forbidden` (before any bound, so a non-organizer learns nothing), expiry, `validation_failed:max_redemptions`. Redemption still refuses `expired` with `clock_timestamp()` (`preview_invitation` / `redeem_invitation` unchanged).
- The app sends `{ p_community_id, p_expires_at: null, p_max_redemptions, p_expires_in_hours }`; presets map to 0 / 24 / 168 / 720 hours.
- Unchanged and already server-side: the organizer bootstrap code of `admin_create_community` (`now() + 7 days`), creator codes (`admin_create_creator_code`, `p_expires_in_days`), and `create_community_with_code` (creates no invitation code).
- **Deployment order:** migration first, then the app update (a new app against the old function fails with an unknown-argument error; old apps keep working against the new one).

New error code: `validation_failed:expires_in_hours`.

## Account deletion fallback (supersedes "Fallback if it is refused ... Not built." under `delete_my_account`)

Only for the case that the hosted project refuses the `delete from auth.users` inside `delete_my_account`. The app is NOT wired to it; `delete_my_account` stays the documented path. Owner guide: `docs/ACCOUNT_DELETION_FALLBACK.md`.

### `private.erase_user(p_user_id uuid, p_delete_auth_user boolean default true) → jsonb`

Same body and summary as before; with `false` it skips its last statement (the `auth.users` delete), so the auth row and, through its cascade, the consent ledger and `private.account_activity` stay. `delete_my_account` and `run_account_retention` call it with one argument (→ `true`): unchanged. No API role can execute it. Later migrations replace `private.erase_user(uuid, boolean)`; creating `private.erase_user(uuid)` again would be an ambiguous overload.

### `admin_erase_user_data(p_user_id uuid) → jsonb` (service_role only)

`private.erase_user(p_user_id, false)`: the full `delete_my_account` erasure (same locks, same `last_organizer` refusal with the same DETAIL) except the auth user. Returns `DeleteMyAccountResult`. Errors (P0001): `validation_failed:user_id` (null), `not_found` (no such auth user), `last_organizer`. Repeatable: a second call for a user whose data is already gone returns a summary of zeros. It takes a user id because its only caller is the Edge Function, which has verified the user's token; `authenticated` and `anon` cannot execute it (pinned in `qa-privileges.test.ts`, `SERVICE_TARGET_USER_ARGS`).

### Edge Function `delete-account` (`supabase/functions/delete-account/`, not deployed)

`POST` with `Authorization: Bearer <the user's access token>`; no body is read.
1. Verifies the token with Supabase Auth (`auth.getUser(token)` on an anon-key client); the user id comes only from it.
2. `my_deletion_blockers()` called **as the caller** (anon key + the caller's token): `can_delete: false` → `409 { error: 'last_organizer', details: { communities: [...] } }`.
3. `admin_erase_user_data(user id)` with the service role (re-checks `last_organizer` under its locks → 409 with the parsed DETAIL).
4. `auth.admin.deleteUser(user id)` (hard delete): Auth's cascade removes sessions, identities, the consent ledger and the activity row.

Responses: `200 { ok: true, ...DeleteMyAccountResult }`; `401 { error: 'not_authenticated' }` (no / malformed / rejected token, or the user is already gone); `405 method_not_allowed`; `409 last_organizer`; `503 auth_unavailable` (Auth unreachable); `500 deletion_failed` (unexpected database error, nothing deleted by the function); `500 { error: 'auth_delete_failed', data_erased: true, retry: true }` (data erased, auth user left: calling again with the same token finishes). Logs carry error codes only (no token, no user id). No CORS handling (not called from a browser today).

TypeScript (`src/lib/database.types.ts`): `create_invitation` Args gain `p_expires_in_hours`; function `admin_erase_user_data`.

---

# Anonymous comments (append-only)

Migration `20261204000100_anonymous_comments.sql`. Tests: `supabase/tests/anonymous-comments.test.ts`, plus `event-feed.test.ts`, the privilege matrix (`qa-privileges.test.ts`) and the GDPR suites. Owner request: "Members should be able to comment anonymously on the events", plus funny nicknames for anonymous authors.

**Interpretation:** (1) every active member (organizers too) writes their own top-level **comments** on an event, not only replies to organizer posts; (2) a member's comment or reply can be posted **anonymously**. Organizers never post anonymously (`anonymous_not_allowed`), and organizer posts (`create_event_post`, unchanged) are never anonymous.

## Anonymity

- An anonymous item is shown with a per-event **nickname** ("Sleepy Capybara": 40 adjectives x 40 animals, family friendly, ASCII) in `author_name`, `author_id: null`, `author_role: null`, `is_anonymous: true`, to every reader, organizers included. The author sees the same plus `mine: true` and may delete it.
- Nickname: assigned on the person's first anonymous item on that event; stable within the event, unique among the event's anonymous authors, unrelated across events (salted hash start, per-database random salt; next free one on a collision). All 1600 taken: `alias_pool_exhausted`, nothing written. Nicknames go with the event (cascade) and with erasure.
- The author is never readable through the API: `public.event_posts.author_id` is stored **null** for an anonymous row (so direct selects, Realtime payloads and service_role reads carry no author); the author and the nickname mapping live in `private.event_post_anonymous_authors` / `private.event_aliases` (no privilege for anon, authenticated or service_role). Organizers moderate by content (delete any item), not by identity. Whoever has database access (the operator) can see the author.
- Notifications: a reply to any top-level item notifies its author (the real one, also when that item is anonymous; never oneself) as `New reply: <event title>` / `<replier name or nickname>: <preview>`. **Top-level comments notify nobody** (decision: comments stay quiet; organizer posts keep notifying going members).

## Rules

- **Window, hygiene, length:** as P4 (until 30 days after the event's end, `event_closed`; `private.clean_required_text`, 1..1000 characters, `validation_failed:body`).
- **Rate limit:** anonymous writes only (comments and replies together): at most **10 per member per event per rolling hour**, deleted ones included; the 11th is `rate_limited`, nothing written. Exact under concurrency (membership row `FOR NO KEY UPDATE`). Named comments and replies are not limited.
- **Delete:** organizers any item (as before); the author (still an active member) their own comments and replies, anonymous ones included; never an organizer post. Deleting a top-level comment deletes its replies (like a post).
- **Leaving:** items stay (anonymous ones stay anonymous with their nickname).

## Table changes

`event_posts` gains `kind text` (`'post'` organizer top-level, `'comment'` member top-level, `'reply'`; existing rows backfilled) and `is_anonymous boolean` (default false). Checks: `kind` matches `parent_id`; `is_anonymous` implies `author_id is null` and `kind <> 'post'`. `author_id` null and `is_anonymous` false = deleted account ("Former member").

## RPCs

`create_event_comment(p_session_id uuid, p_body text, p_anonymous boolean default false) → event_posts` (authenticated)
- Errors in order: `not_authenticated`, `not_found`, `not_a_member`, `anonymous_not_allowed` (organizer + anonymous), `event_closed`, `validation_failed:body`; after the locks `not_a_member`, `anonymous_not_allowed` (promoted meanwhile), `rate_limited` (anonymous only), `alias_pool_exhausted`. `p_anonymous` null = false. Returns the row (`author_id` null when anonymous).

`reply_to_event_post(p_post_id uuid, p_body text, p_anonymous boolean default false) → event_posts` (replaces the 2-argument function; old named calls resolve through the default). Target: a top-level post **or comment**. Errors as P4 plus `anonymous_not_allowed` (after `not_a_member`), `rate_limited` and `alias_pool_exhausted` (anonymous only). **App:** the contract test requires every declared argument, so send `p_anonymous` (false for a named reply).

`delete_event_post(p_post_id uuid)`: unchanged signature; rules above.

`get_event_feed(p_session_id uuid) → EventFeed`, new fields:
```
{ ..., can_comment (is_open), can_comment_anonymously (is_open and not is_organizer),
  posts: [ { id, parent_id: null, kind ('post'|'comment'), author_id, author_name (nickname when anonymous),
             author_role, is_anonymous, mine, body, created_at, is_unread, can_delete,
             replies: [ { ..., kind: 'reply', is_anonymous, mine, ... } ] } ] }
```
Top-level list = organizer posts and comments, newest first. `can_delete`: organizer, or the caller's own comment / reply. Counts and unread rules unchanged (the caller's own anonymous items are never unread). `get_event_feed_unread`: same shape, comments counted.

## GDPR

- **Export:** `authored.event_posts` items gain `kind`, `is_anonymous` and `alias` (the caller's own nickname for an anonymous item, else null) and include the caller's anonymous items; new `authored.event_aliases: [ { session_id, community_id, event_title, alias, created_at } ]` (own nicknames only) and `truncated.event_aliases`; README sentence. Nobody else's anonymous items or nicknames.
- **Erasure:** the user's comments and replies (named or anonymous) are deleted, with the `event_reply` notifications quoting the replies; replies of others under a deleted comment go with it; nicknames deleted; organizer posts stay without author (as before). `private.account_last_activity` also counts anonymous items.

New error codes: `anonymous_not_allowed`, `alias_pool_exhausted`. TypeScript: `EventPostKind`; `event_posts` Row `kind`, `is_anonymous`; `create_event_comment`; `reply_to_event_post` `p_anonymous?`; `EventFeedItem` `kind?`, `is_anonymous?`, `mine?`; `EventFeed` `can_comment?`, `can_comment_anonymously?` (optional only so the current app fixtures compile; always sent); `MyDataExport` additions (optional, absent in older files).
