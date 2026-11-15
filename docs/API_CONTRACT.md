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
