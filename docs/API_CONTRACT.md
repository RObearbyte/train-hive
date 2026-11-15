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
