# TrainHive — Architecture

One Pack. Stronger together.

## 1. Shape of the system

```
Expo app (React Native, Expo Router, TanStack Query)
   │  supabase-js: anonymous auth, table reads under RLS, RPC calls, Realtime
   ▼
Supabase
   ├─ Postgres: schema, RLS, SECURITY DEFINER RPCs (all mutations), pg_cron jobs
   ├─ Realtime: postgres_changes on sessions / RSVPs → client query invalidation
   └─ Edge Functions: only where Postgres cannot do the job (push delivery, M3)
```

No other services. The database is the authority for every rule that matters.

## 2. Key decisions

| Decision | Why |
|---|---|
| **All mutations go through Postgres RPCs** (`security definer`, `search_path = ''`). Tables expose `select` policies only. | One transactional place for validation, authorization, capacity and status rules. Clients cannot write status or counts. |
| **Session lifecycle is a stored enum** (`scheduled → confirmed / cancelled → completed`); the "Awaiting minimum / Minimum reached" label is **derived** from `going_count` vs `min_participants` while `scheduled`. | Separates the finalized decision from provisional RSVP progress, so the decision cannot oscillate. |
| **`going_count` is a column** on `training_sessions`, maintained only inside `set_rsvp` under a `FOR UPDATE` lock on the session row. | Atomic capacity enforcement, consistent counts under concurrency, and one Realtime row update carries the new count to every member. |
| **Deadline decision runs in `finalize_due_sessions()`**, scheduled by `pg_cron` every minute, using `now()` on the server and `FOR UPDATE SKIP LOCKED`. | Runs with no app open, is idempotent, never trusts a client clock. `set_rsvp` also rejects once `now() >= rsvp_deadline`, so a late cron tick cannot let late RSVPs in. |
| **Invitation functions return `{ok:false,error}`** instead of raising. | A raised exception would roll back the rate-limit attempt record. |
| **Organizer bootstrap** = `admin_create_community()`, executable by `service_role` only, which returns a single-use organizer invitation code. The first organizer then joins through the normal invitation flow. | No public path to the organizer role; one onboarding flow to build and test. |
| **Anonymous Supabase auth**; `profiles.id = auth.users.id`. | Later `linkIdentity` / `updateUser` upgrades the same user id, so memberships and attendance survive. Limitation: an anonymous account is lost if the device or app data is lost. |
| **Realtime events only trigger query invalidation**, never patch the cache. | Duplicate or out-of-order events are harmless: the refetch is always the server truth. |
| **Timestamps are `timestamptz` (UTC)**, each session stores an IANA `timezone` (defaults to the community's). | Display and scheduling are done in the session's zone. |
| **Tests: Vitest + embedded Postgres** (real Postgres binaries from npm, no Docker). A shim creates the Supabase roles, `auth.users`, `auth.uid()` and the `supabase_realtime` publication, then applies the real migrations. | Verifies RLS, RPCs and concurrency on real Postgres. Realtime, pg_cron scheduling and push are not covered until a hosted project is connected (see `docs/SUPABASE_SETUP.md`). |
| **No Zustand yet.** | Server state lives in TanStack Query, session state in a small React context. Add Zustand only when real client state appears. |

## 3. Data model (Milestone 1)

- `communities` — name, IANA timezone.
- `profiles` — one per auth user, display name.
- `memberships` — user ↔ community, `role` (organizer/member), `status` (active/removed), unique per pair. Multiple memberships are supported by the schema; the UI assumes one.
- `invitation_codes` — code, role granted, optional expiry, optional max redemptions, redemption count, revoked_at.
- `invitation_redemptions` — who redeemed which code (unique per pair).
- `invitation_attempts` — per-user attempt log for rate limiting.
- `activity_types` — lookup table (key, label, sort order), so types are extensible without a migration of an enum.
- `training_sessions` — see contract; includes `going_count`, `status`, `cancel_reason`, `decided_at`.
- `training_rsvps` — one row per (session, user), `response` in going / not_going / no_response.

Later milestones add: `attendance_records`, `attendance_audit_log` (M2); `announcements`, `notifications`, `device_push_tokens`, `notification_delivery_jobs` (M3). Statistics (M4) are SQL functions over these tables.

Exact columns, RPC signatures and error codes: `docs/API_CONTRACT.md`. That file is the contract between backend and mobile work.

## 4. Folder structure

```
src/
  app/                     Expo Router routes only (thin screens)
    _layout.tsx            providers + session gate
    (onboarding)/          welcome, code, name
    (app)/(tabs)/          index (Home), trainings, profile   [+ activity M3, stats M4]
    (app)/trainings/       [id], new, [id]/edit
    (app)/invitations.tsx  organizer only
  features/
    onboarding/  community/  trainings/  rsvp/  invitations/  profile/
      api/         supabase calls, typed
      domain/      pure TypeScript rules + zod schemas (no react-native imports; unit tested)
      hooks/       TanStack Query hooks
      components/  feature UI
  lib/                     supabase client, secure storage, query client, datetime, errors
  ui/                      theme tokens + reusable components
supabase/
  migrations/              ordered SQL migrations (source of truth)
  functions/               Edge Functions (M3)
  tests/                   Vitest integration tests against embedded Postgres
docs/
```

## 5. Navigation (Milestone 1)

Tabs: **Home** (next training + RSVP), **Trainings** (upcoming / past), **Profile** (name, community, invitations for organizers). Activity and Statistics tabs appear only when Milestones 3 and 4 are functional.

## 6. Derived training status (single source: `features/trainings/domain`)

| Stored status | Condition | Label |
|---|---|---|
| scheduled | going < min | Awaiting minimum — "N more needed" |
| scheduled | going ≥ min | Minimum reached (provisional) |
| scheduled | deadline passed, not yet decided | Finalizing… |
| confirmed | — | Confirmed |
| cancelled | reason insufficient_participation | Cancelled — insufficient participation |
| cancelled | reason organizer | Cancelled by organizer |
| completed | — | Completed |
