# TrainHive — QA report

## Milestone 1, part 1: backend (M1-Q1)

Scope: `supabase/migrations/*.sql` (5 files) and `supabase/tests/`. Reviewed against the product rules and `docs/API_CONTRACT.md`, not against the developers' summaries. The mobile half of Milestone 1 is not covered here.

### Verdict

**The backend half of Milestone 1 passes.** No critical, high or medium defect was found. Authorization, community isolation, RSVP counting, capacity and the deadline decision held under every adversarial and concurrent test written for this review, including checks at every committed write of randomized runs and 15 mutation checks.

Six low-severity defects are open. All of them are on paths the app does not expose in Milestone 1 (user deletion, admin removal or deletion, lock waits, unusual zone names). They are documented by `it.fails` tests, so `main` stays green and each test turns red the moment the defect is fixed (remove `.fails` then).

### Defects

| Id | Severity | Where | Summary |
|---|---|---|---|
| Q1-1 | low | `20261114000400_trainings_rpcs.sql:481-486, 518-523`; `20261114000300_trainings_schema.sql:97` | Deleting a user deadlocks with that user's first RSVP to a session. |
| Q1-2 | low | `20261114000300_trainings_schema.sql:31` | The account of anyone who created a training cannot be deleted. |
| Q1-3 | low | `20261114000400_trainings_rpcs.sql:597-618` | A member removed after the deadline but before the finalizer runs changes the decision. |
| Q1-4 | low | `20261114000400_trainings_rpcs.sql:623-627, 637-640` | Two bypass paths leave `going_count` different from the real state. |
| Q1-5 | low | `20261114000400_trainings_rpcs.sql:192-195`; `20261114000200_invitations_and_onboarding.sql:405-406` | Non-IANA zone names such as `Factory` are accepted as a time zone. |
| Q1-6 | low | `20261114000200_invitations_and_onboarding.sql:156` | A redemption that waits for the row lock can succeed after the code expired. |

**Q1-1 — deadlock between user deletion and a first RSVP.**
Reproduction: `qa-concurrency.test.ts`, "DEFECT Q1-1". Hold the session row; start `set_rsvp` for a user with no RSVP row yet (it share-locks the membership, then waits for the session); delete that user from `auth.users` (the cascade deletes the profile, then waits for the membership); release the session.
Expected: both finish, or the RSVP fails with a business error. Actual: one of the two is aborted with `40P01 deadlock detected`. Data stays consistent.
Cause: `set_rsvp` locks membership → session → profile (foreign-key check of the insert); the delete cascade locks profile → membership.
Suggested fix: in `set_rsvp`, take `for key share` on the caller's `profiles` row before the membership lock, so both paths lock the profile first.

**Q1-2 — organizer accounts cannot be deleted.**
Reproduction: `qa-lifecycle.test.ts`, "DEFECT Q1-2". Create a training, then `delete from auth.users` for its creator.
Expected: the account is deleted and the session survives. Actual: `23503` on `training_sessions_organizer_id_fkey`.
Suggested fix: make `organizer_id` nullable with `on delete set null` (as `cancelled_by` already is), or decide explicitly that organizers must hand over first and document it.

**Q1-3 — the decision is not taken from the count at the deadline.**
Reproduction: `qa-lifecycle.test.ts`, "DEFECT Q1-3". Two going, minimum two; move the deadline into the past; set one membership to `removed`; run the finalizer.
Expected: `confirmed` with `going_count = 2` (the header of the RPC migration states that nothing can change the decision once the deadline has passed). Actual: `cancelled / insufficient_participation`, `going_count = 1`.
Cause: the removal trigger releases RSVPs on every `scheduled` session, including those past their deadline. The user-deletion trigger (`:637-640`) does the same.
Suggested fix: in both triggers, only touch sessions with `status = 'scheduled' and rsvp_deadline > clock_timestamp()`. Product decision needed: whether a removed member should still count for a decision that is already due.

**Q1-4 — `going_count` safety nets are incomplete.**
(a) `qa-lifecycle.test.ts`, "DEFECT Q1-4a": deleting a user who is `going` on a confirmed session removes the RSVP row but leaves `going_count` unchanged, so the count and the participant list disagree (2 vs 1).
(b) "DEFECT Q1-4b": deleting a membership row (instead of setting `status = 'removed'`) fires no trigger; the RSVP stays `going` and a non-member keeps counting toward the minimum.
Suggested fix: (a) decide whether decided sessions keep history; if so, keep the RSVP row (for example `on delete set null` on a nullable `user_id`) rather than only the number. (b) add an `after delete` trigger on `memberships` that reuses the removal logic, or forbid deleting memberships.

**Q1-5 — non-IANA zone names are accepted.**
Reproduction: `qa-input.test.ts`, "DEFECT Q1-5". `create_training` with `timezone: 'Factory'` succeeds. `pg_timezone_names` also lists `posixrules`, `localtime`, `posix/...` and `right/...` on some builds.
Expected: `validation_failed:timezone`. Risk: `Intl` / `@date-fns/tz` on the device may reject such a name when rendering the session for every member.
Suggested fix: additionally require `name ~ '^[A-Z][A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)+$' or name = 'UTC'` and exclude the `posix/` and `right/` prefixes. Same check in `admin_create_community`.

**Q1-6 — expiry is checked against the transaction start time.**
Reproduction: `qa-invitations.test.ts`, "DEFECT Q1-6". A code expires in 400 ms; a redemption waits 800 ms for the invitation row lock.
Expected: `expired`. Actual: `{ ok: true }`. The overrun is bounded by the lock wait.
Suggested fix: use `clock_timestamp()` in `private.check_invitation`, as `set_rsvp` already does for the RSVP deadline.

### Observations (no defect filed; decisions for the lead)

- **O1** `create_training` and `create_invitation` have no idempotency key: a client retry after a lost response creates a duplicate (`qa-lifecycle.test.ts`). The mobile app should disable the submit button while pending and not auto-retry these mutations.
- **O2** The spec says "deadline before start"; the contract and the table check allow `rsvp_deadline = starts_at`.
- **O3** A training starting in less than two hours cannot be created without an explicit deadline, and the error is `validation_failed:rsvp_deadline`, a field the organizer left empty (`qa-input.test.ts`). The form should pre-fill the deadline or map this error.
- **O4** The invitation rate limit is per auth user. With anonymous sign-in a fresh user gets five fresh attempts (`qa-invitations.test.ts`). Code space is 30^8 (about 39 bits), so the real bound on guessing is Supabase Auth's anonymous sign-in rate limit and CAPTCHA, which must be enabled on the hosted project.
- **O5** Existence oracle: `set_rsvp`, `update_training`, `cancel_training` and `revoke_invitation` answer `not_found` for an unknown id and `not_a_member` / `forbidden` for a foreign one (`20261114000400_trainings_rpcs.sql:303-311, 410-418, 471-489`; `20261114000200_invitations_and_onboarding.sql:366-376`). Ids are random uuids, so this is informational. `preview_invitation` distinguishes `expired` / `revoked` / `exhausted` from `invalid_code`, as the contract specifies.
- **O6** No index on `training_sessions.organizer_id`, `training_sessions.cancelled_by` or `invitation_codes.created_by`; deleting a profile scans those tables. Irrelevant at Milestone 1 sizes.
- **O7** Weak existing assertion: `rls.test.ts:104` ("lets authenticated execute exactly the contract functions") uses `arrayContaining`, so it would pass if an extra function became executable. `qa-privileges.test.ts` now pins the exact matrix. No other weakly asserted item from the Milestone 1 test list was found.

Reviewed and found sound: every public function is `security definer` with an empty `search_path` and a single grantee; no function takes a caller id; no dynamic SQL; policies call only definer helpers (no recursion); `training_rsvps.community_id` is kept honest by a composite foreign key; code generation uses rejection sampling (no modulo bias); lock order is consistent across `set_rsvp`, member removal, `update_training`, `cancel_training` and the finalizer; the finalizer uses the transaction start time and the RPCs use `clock_timestamp()`, so the finalizer can never decide before an RSVP that was accepted.

### Verified by test

| Acceptance criterion | Tests |
|---|---|
| Valid invitation acceptance; expired / revoked / exhausted rejection | `invitations.test.ts`; `qa-invitations.test.ts` (exact expiry instant, expired bootstrap code) |
| Concurrent redemption, atomic | `invitations.test.ts`; `qa-invitations.test.ts` (6 users race for a real organizer bootstrap code: exactly one organizer) |
| Secure code generation | `qa-invitations.test.ts` (6000 codes: format, uniqueness, chi-square overall and per position; the check is shown to catch a modulo-biased generator) |
| Rate limiting | `invitations.test.ts`; `qa-invitations.test.ts` (no leak when limited, success does not reset the counter); mutation check |
| No public path to organizer; secure bootstrap | `rls.test.ts`, `invitation-management.test.ts`; `qa-privileges.test.ts`, `qa-invitations.test.ts`; mutation check (`create_invitation` minting organizer codes) |
| Role-based access, role is per community | `qa-authz.test.ts` (member of A and organizer of B cannot act as organizer in A; removed organizer loses every operation) |
| Community isolation, no direct writes | `rls.test.ts`; `qa-authz.test.ts` (removed member reads nothing; input cannot move a session across communities); `qa-privileges.test.ts` (exact function and table privilege matrix for anon / authenticated / service_role); mutation checks (policy opened, RLS disabled) |
| Training creation and editing, validation | `trainings.test.ts`; `qa-input.test.ts` (every field against every wrong JSON type, megabyte strings, special timestamp words, numeric extremes, injection strings, table constraints) |
| RSVP creation and modification, idempotent | `rsvp.test.ts`; `qa-lifecycle.test.ts` (concurrent duplicates) |
| Concurrent RSVP updates, capacity atomic | `rsvp.test.ts`; `qa-concurrency.test.ts` (randomized storm; count checked at every write) |
| Minimum threshold transitions | `rsvp.test.ts` |
| Deadline finalization: server-side, idempotent, never oscillates | `rsvp.test.ts`, `trainings.test.ts`; `qa-concurrency.test.ts` (burst of RSVPs at the deadline; finalizer vs organizer cancel and `update_training`; cancel of a confirmed session never undone); mutation checks (5) |
| Cancellation scenarios | `trainings.test.ts`; `qa-concurrency.test.ts` |
| No deadlocks between RPCs | `qa-concurrency.test.ts` (storm and removal probe: zero unexpected errors). Exception: Q1-1 |
| Timezone handling | `trainings.test.ts` (UTC round trip, spring-forward); `qa-input.test.ts` (repeated hour on the fall-back day, decision independent of the database session zone) |

How the concurrency invariants are checked: a test-only audit trigger (`qa-helpers.ts`, installed and dropped by `qa-concurrency.test.ts`) records every session write with the real number of going rows at that moment. After each run, six rules are evaluated over all recorded writes: legal status transitions only, `going_count` equals the real count, the finalizer decides only at or after the deadline and confirms iff going ≥ min, nothing changes after the decision except organizer cancel, limits and deadline are frozen once the deadline passed, and no count change after the deadline. A self-check test forces each violation and confirms the audit reports it.

Mutation checks (`qa-mutation.test.ts`): 14 mutants of the live schema plus the biased-generator check. Each rule holds on the pristine schema, the probe notices the mutant, and the rule holds again after the revert. All 15 were noticed.

### Not verifiable locally

- **pg_cron** (`20261114000500_schedule_finalizer.sql`): the test database has no pg_cron, so the block is a no-op there. Unverified: that `create extension pg_cron with schema pg_catalog` succeeds for the migration role; that the job runs as a role allowed to execute `finalize_due_sessions()` (it is revoked from every API role and relies on the owner); that the job actually fires every minute. If pg_cron is listed in `pg_available_extensions` but not preloaded, the migration fails instead of skipping.
- **Hosted default privileges**: the shim grants `all` on new public tables and functions to the three API roles, mirroring Supabase. The privilege tests prove the migrations are safe under that assumption only. Re-run the privilege queries from `qa-privileges.test.ts` against the hosted project after the first deploy.
- **`auth.uid()`, `auth.users`, anonymous sign-in**: the shim's implementations are stand-ins. Anonymous sign-in rate limits and CAPTCHA (see O4) are project settings.
- **Realtime**: delivery, RLS filtering of change events and behaviour with default replica identity are untested. Expect that a removed member receives no event for their own removal, because the row no longer passes the policy; the client must not rely on Realtime to learn it was removed.
- **PostgREST**: one transaction per RPC call is assumed. If `Prefer: tx=rollback` were ever allowed on the project, rate-limit records could be rolled back by the caller.
- **Zone data**: the set of names in `pg_timezone_names` differs between Postgres builds (Q1-5 was reproduced with `Factory` on the embedded build).
- **`pgcrypto` in `extensions`** and ownership of the `supabase_realtime` publication on the hosted project.

### What was run

On Windows, embedded Postgres, 2026-11-15:

- `npm test` → `Test Files 29 passed (29)`, `Tests 784 passed | 7 expected fail (791)`.
- `npm run typecheck` → exit 0, no output.
- `npm run lint` → exit 0, no output.
- `qa-concurrency.test.ts` was additionally run 6 times in a row after its last change: 6 of 6 green.

### Test inventory

| Suite | Files | Tests |
|---|---|---|
| Database, developers (`supabase/tests/*.test.ts` without `qa-`) | 5 | 260 |
| Database, QA (`supabase/tests/qa-*.test.ts`) | 7 | 77 (70 passing, 7 expected-fail defect tests) |
| Unit (`src/**/*.test.ts`, owned by mobile, not reviewed in this part) | 17 | 454 |
| Total | 29 | 791 |

QA files: `qa-privileges` (12), `qa-authz` (9), `qa-concurrency` (8), `qa-mutation` (15), `qa-lifecycle` (8), `qa-input` (14), `qa-invitations` (11); shared helpers in `qa-helpers.ts`.

---

## Milestone 1, part 2: mobile app (M1-Q1)

Scope: `src/app`, `src/features`, `src/lib`, `src/ui` (read critically), every Supabase call checked against `supabase/migrations/*.sql`, against the Milestone 1 spec and `docs/API_CONTRACT.md`, not against the developers' summaries. App code was not changed; defects are reported for the owning role. QA tests added: 8 files named `qa-*.test.ts` under `src/`.

### Verdict

**Milestone 1 mobile passes review with conditions: it should not be called done until Q2-1, Q2-2 and Q2-5 are fixed and the manual script below has been run on a phone.** Onboarding, the gate, RSVP, status derivation, timezone handling, the form logic and the data layer are carefully built. The adversarial cases written here held (timezone sweeps over every 2026 transition of 12 awkward zones, hostile map text, number parsing, a status matrix, contract checks against the SQL), and all Supabase calls match the migrations (table, column, embed foreign key, argument names, grants). No security defect was found in the client: no service-role use, no color literal outside the theme, codes are kept out of routes and logs, the session is stored only in secure storage on native.

The defects that matter are all **offline / flaky-network behaviour**, which the spec lists explicitly ("network failures handled"): a returning member in airplane mode can be left on the splash screen forever (Q2-1), a new member on a bad connection can be stuck on a spinner after a successful join (Q2-2), and an RSVP made offline is queued silently (Q2-5). Nothing has run on a device or against hosted Supabase; see the unverifiable list.

### Defects

| Id | Severity | Where | Owner | Summary |
|---|---|---|---|---|
| Q2-1 | medium | `src/lib/queryClient.ts:21-29`; `src/features/community/hooks/useCurrentMembership.ts:40-45`; `src/app/_layout.tsx:36-49` | mobile | Offline cold start never leaves the splash screen. |
| Q2-2 | medium | `src/app/(onboarding)/name.tsx:40-41, 95-108`; `useCurrentMembership.ts:44-45` | mobile | Join succeeds, the membership refetch fails: spinner forever, the "You have joined / Try again" banner can never show. |
| Q2-5 | medium | `src/features/rsvp/hooks/useSetRsvp.ts:50-100`; `src/lib/queryClient.ts:21-29` | mobile | RSVP offline: optimistic answer and spinner, request held back silently, sent late. |
| Q2-6 | low | `src/features/trainings/hooks/useTrainings.ts:59-62`; `src/features/rsvp/components/RsvpControl.tsx:32-52` | mobile / ux | While "my answers" are loading or failed, cards say "No answer yet" and offer live buttons. |
| Q2-3 | low | `src/features/rsvp/domain/rsvpCache.ts:44-58, 100-106` | mobile | Rollback of one session restores a whole-list snapshot and wipes another session's pending change. |
| Q2-4 | low | `src/features/rsvp/hooks/useSetRsvp.ts:53-62`; `src/features/trainings/hooks/useTrainingsRealtime.ts:21-35` | mobile | A refetch started during the RSVP request overwrites the optimistic answer. |
| Q2-7 | low | `src/lib/database.types.ts:234, 262` | backend | `training_sessions.organizer_id` typed `string`, nullable in the SQL since the Q1-2 fix. |
| Q2-8 | low | `src/features/trainings/domain/schema.ts:221, 225` | mobile | Title / location length counted in UTF-16 units; Postgres counts characters. |
| Q2-9 | low | `src/features/trainings/domain/maps.ts:76` | mobile | Android `geo:` label keeps raw parentheses. |
| Q2-10 | low | `src/features/rsvp/domain/rsvp.ts:43`; `src/features/trainings/domain/status.ts:41`; `src/features/invitations/components/CreateInvitationForm.tsx:36` | mobile (decision: lead) | The device clock decides whether the RSVP buttons exist, when "Finalizing" shows and the invitation expiry time. |
| Q2-11 | low | `src/features/trainings/hooks/useTrainings.ts:92`; `TrainingForm.tsx:586`; `update_training` | mobile + backend | Lost update: two organizers editing, and an edit form prefilled from a stale list copy, overwrite each other silently. |

**Q2-1 — offline cold start: infinite splash.**
Reproduction (node, real TanStack objects): `qa-queryBehavior.test.ts`, "an offline first load ends in an error state". `queryClient.ts` sets no `networkMode`, so the default `online` applies; `bindQueryLifecycle` feeds NetInfo into `onlineManager`. With airplane mode on and a stored session whose access token is still valid (it is for up to an hour; `getSession` needs no network), the membership query is `pending` + `fetchStatus: 'paused'`: never fetched, never failed. `useCurrentMembership` maps that to `state: 'pending'`, `decideRoute` returns `loading`, `RootNavigator` never calls `SplashScreen.hide()`. The "Can't reach TrainHive" screen is only reachable when the radio reports online but the server cannot be reached. The same pause leaves every first load of Home and Trainings on a spinner instead of an error.
Expected: an offline start shows the error screen with Retry (or the cached app). Suggested fix: `networkMode: 'always'` for queries (a failed fetch then becomes `network_error` and the existing retry / error states apply), or treat `fetchStatus === 'paused'` as an error state in `useCurrentMembership`. Persisting the query cache would let a returning member into the app offline (O5). Whether an expired-token offline start behaves is covered: that path goes to the error route (`unavailable`).

**Q2-2 — joined, but stuck.**
Premise tested in `qa-queryBehavior.test.ts` ("keeps the old data (null) and reports isError"); the rest is code review. During onboarding the membership query already holds `null` (signed in, not a member). After `redeem_invitation` succeeds, `onSuccess` awaits `invalidateQueries`; if that refetch fails (a weak signal reported as `network_error`, a 5xx), TanStack keeps `data = null` and sets `isError`. `useCurrentMembership` checks `data !== undefined` first, so `state` is `'none'`, never `'error'`. `name.tsx` shows the recovery banner only for `membership.state === 'error'` (line 95), and the Join button is `loading` because `joined = redeem.isSuccess` (lines 40-41); Back and the input are disabled too. The user is stuck until they kill the app (the next launch finds the membership).
Expected: a visible "You have joined, we could not load your community. Try again". Fix: let `isError` win over stale data in the hook (`query.isError` first), or use `membership.error !== null` in `name.tsx`.

**Q2-5 — RSVP offline is queued, not failed.**
`qa-queryBehavior.test.ts`, "an RSVP attempted offline fails fast" and the characterization next to it. Same cause as Q2-1, for mutations. `onMutate` runs (the answer looks saved), the RPC is held, `isMutating > 0` makes `submit` ignore every further tap, and the spinner stays. When the connection returns minutes later the stale request is sent, possibly after the deadline (`rsvp_closed`), and only then is the change rolled back. Expected: "No connection" at once and a rollback. Fix: `networkMode: 'always'` on the mutations.

**Q2-6 — unloaded answers shown as "No answer yet".**
`useCommunityTrainings` falls back to `{}` while `fetchMyRsvps` is loading or failed, so every card shows unselected buttons and the details screen says "No answer yet" for sessions the member has answered. A tap in that window passes `previous = 'no_response'`: tapping "I'm going" on a session the member already goes to adds an optimistic +1 until the server result arrives. Code review only. Expected: skeleton or disabled control until `mine` has loaded, and a visible error when it failed (today only a screen-level banner mentions it).

**Q2-3 — rollback restores more than it changed.**
`qa-rsvpRaces.test.ts`, "rolling back A leaves B optimistic change in place". `useSetRsvp` allows one mutation per session, so a member can answer on two cards at once. The snapshot of A holds the whole list array and the whole "my answers" map; if A fails, B's pending count and answer vanish from the list (the detail cache still shows B's change: list and detail disagree) until B's reconcile / `onSettled` refetch. It heals itself. Fix: snapshot and restore only the one session entry and the one answer.

**Q2-4 — refetch lands in the middle of the request.**
`qa-rsvpRaces.test.ts`, "an invalidation during the mutation does not undo the optimistic answer". `onMutate` cancels reads that are already running, but a Realtime event (another member answering) or pull-to-refresh starts a new read afterwards, whose answer predates the RPC. The tapped button flips back for the length of the request and forward again on success. It ends correct (the `onSettled` refetch cancels a stale in-flight read). Fix: skip those invalidations while `isMutating` for that session.

**Q2-7 — stale generated type.**
`qa-backendContract.test.ts`, "Row of training_sessions agrees with the SQL about nullability". No runtime impact today (`organizer_id ?? ''` is used), but the compiler will not catch a null organizer anywhere else. Fix: `organizer_id: string | null` in Row, nullable in Insert / Update.

**Q2-8 — emoji titles.**
`qa-form.test.ts`, "accepts a title of 41 emoji" and "a location of 61 emoji". `String.length` against `char_length`. The form is stricter than the server, never looser, so no bad data passes; an organizer with a long emoji title is told it is too long when it is not. Fix: count `Array.from(text).length` as `displayName.ts` already does.

**Q2-9 — parentheses in a place name.**
`qa-maps.test.ts`, "percent-encodes parentheses inside the label". The link is `geo:LAT,LNG?q=LAT,LNG(Parc%20Carol (poarta nord))`; maps apps cut the label at the first `)`. Fix: replace `(` and `)` with `%28` / `%29` after `encodeURIComponent`.

**Q2-10 — the device clock decides things.**
`qa-status.test.ts`, characterization "the decision uses whatever clock it is handed". `RsvpControl` hides the buttons when the device clock says the deadline passed; a phone 10 minutes fast loses the ability to answer while the server would still accept it, and shows "Finalizing" early. `CreateInvitationForm` computes `expires_at` from the device clock (a slow clock gives a code that dies early; a clock a day behind gets `validation_failed:expires_at` with an apt message). The spec says the client clock is display-only; the server is always the final judge, so nothing is wrongly accepted. Suggested rule: always render the buttons for a `scheduled` session and let `rsvp_closed` explain, or add a tolerance and a "closing soon" state; let the server compute expiry from an interval. Lead decision.

**Q2-11 — lost update.**
`update_training` is a full replace with no version check (`updated_at` is not compared), and `useTraining` shows a copy from the list cache (`placeholderData`) which the edit form takes as its once-only `defaultValues`. Two organizers editing the same session, or an edit opened from a stale list copy, silently overwrite each other; untouched timestamps are sent back verbatim, so they restore old values. Single-organizer Milestone 1 makes this rare. Fix: send `updated_at` as an expected version (backend), and in the form wait for the real fetch (`!isPlaceholderData`) before prefilling.

### Observations (no defect filed)

- **O5** Nothing is persisted offline: the app needs the network on every cold start (a persisted query cache would fix it). Acceptable for Milestone 1 once Q2-1 is fixed.
- **O6** The details screen lists Going and Not going only; `DESIGN.md` also lists "No response". Members who never answered have no row, so that group cannot be built from `training_rsvps`; the design doc should say so.
- **O7** A removed member stays in the app until the next membership refetch (30 s stale time, foreground, rejected RSVP, SUBSCRIBED catch-up). Pull-to-refresh on Trainings does not refetch membership. Realtime cannot tell them (part 1, "Not verifiable"). They see an empty list, then onboarding; the code screen then answers "invalid code" (removed members cannot rejoin), which reads as a typo rather than a removal.
- **O8** Create / save buttons are guarded by React state (`saving`), not by a synchronous check as RSVP is. A double tap faster than one render could send two `create_training` (part 1 O1: no idempotency key). Not reproduced.
- **O9** Clearing app data creates a new anonymous user and resets the per-user invitation-attempt limit: part 1 O4 stands (CAPTCHA / project settings).
- **O10** If the refresh token is rejected, supabase-js signs out, the gate sends the member to onboarding and the account is gone: the same communicated limitation as deleting the app.
- **O11** `retryRestoreSession` gives no feedback when it fails again; the Retry button looks dead offline.

### Criteria to evidence

Key: **code** = read in the source; **test** = automated test, ran green (node, real objects, no database); **contract** = compared with the migrations by `qa-backendContract.test.ts`; **device** = needs the manual script below. No browser run with a stubbed backend was done: a stub would only prove the stub, so only the web and Android bundles were built.

| Milestone 1 criterion | Evidence | Result |
|---|---|---|
| No login screen; welcome, code, validate, name, join, dashboard | code (`(onboarding)/*`, `Stack.Protected` in `_layout.tsx`); gate sequences in `gate.test.ts` (developers) | holds; device for the real flow |
| Returning users go straight in, no onboarding flash | `gate.test.ts` (loading, present + pending, app); splash held until the route is known (`_layout.tsx:33-35`); code | holds online. **Offline: Q2-1** |
| Session persisted securely | code (`authStorage.ts`: SecureStore, chunked, crash-safe flip) + `chunkedStorage.test.ts`; `qa-hygiene` (no AsyncStorage) | holds; device for Keystore behaviour |
| Anonymous-account limitation communicated | code: name-screen banner, Profile "Your account" card | holds |
| Invitation errors (invalid, expired, revoked, exhausted, rate limited) | code (`code.tsx`, `errors.ts`) + `errors.test.ts`, `invitationCode.test.ts` | holds |
| Card: title, date and time, location, activity, count, minimum, status, my answer, one tap | code (`TrainingCard.tsx`); `qa-status.test.ts` wording | holds; **Q2-6** for the loading window |
| Five questions at a glance | code order of blocks; accessibility label carries all five | holds |
| RSVP Going / Not going / No response, immediate feedback | code; `rsvp.test.ts`, `rsvpCache.test.ts`, `qa-rsvpRaces.test.ts` | holds |
| Optimistic UI with correct rollback | `rsvpCache.test.ts` (exact restore), `qa-rsvpRaces.test.ts` | single change holds; **Q2-3, Q2-4** for interleavings |
| Closed / cancelled sessions reject changes | server (part 1, `rsvp_closed`); client `canChangeRsvp` tested at the boundary; error shown with rollback (code) | holds; **Q2-10** (client can block too early) |
| Changeable until the deadline | server (part 1); `qa-status.test.ts` (1 ms before, at the deadline) | holds |
| "7 / 10 confirmed", "3 more participants needed" | `qa-status.test.ts` exact strings | holds |
| Awaiting / Minimum reached (provisional) / Confirmed (final) / Cancelled insufficient vs organizer / Completed | `qa-status.test.ts` (11 stored states, boundaries, decided states ignore the clock) | holds |
| Provisional visibly different from final | `qa-status.test.ts` on `statusMeta` (filled vs dashed outline, distinct glyph and label); contrast table in `DESIGN.md` not re-computed | holds on paper; device for dashed borders on Android |
| Realtime: counts, progress, status, own RSVP without refresh | code (`useTrainingsRealtime.ts`: one channel, coalesced invalidation, rebuild with backoff, foreground catch-up, cleanup); `coalesce.test.ts` | unverified live (needs hosted project) |
| Duplicate / out-of-order events harmless | by design (events only invalidate, the refetch is the truth); `coalesce.test.ts`; **Q2-4** for the in-flight case | holds |
| Details: all fields, map action, organizer, progress, status, RSVP, participants | code (`trainings/[id].tsx`); `maps.test.ts`, `qa-maps.test.ts`; embeds checked against the SQL | holds; **Q2-9** |
| Organizers get edit and cancel; members never see organizer actions | code (`isOrganizer` guard, redirects on new / edit / invitations); server authorization (part 1) | holds |
| Client clock display-only | `qa-hygiene.test.ts` (files that read the clock); code | mostly; **Q2-10** |
| External data validated | `setRsvp` checks the result shape; rows are cast to generated types; `previewInvitation` / `redeemInvitation` read fields from `data as ...` without a runtime shape check | partial |
| Network failures handled | `errors.test.ts`, retry policy, error / empty / loading states on every screen | **Q2-1, Q2-2, Q2-5** |
| No swallowed errors, no raw technical text | `qa-hygiene.test.ts` (no empty catch, every floating `.catch` reports); `userMessage` for every code | holds |
| Loading / empty states | code | holds |
| Accessibility | `qa-hygiene.test.ts` (every `Pressable` has a role, no raw `TextInput`, touch target >= 44); code (`RsvpToggle` radio group, `ProgressBar` value, glyph + text status) | holds on paper; device with TalkBack |
| No service-role secrets | `qa-hygiene.test.ts` (only the two `EXPO_PUBLIC_*` variables; no service-role call); `qa-backendContract.test.ts` | holds |
| No hard-coded colors outside the theme | `qa-hygiene.test.ts` | holds |
| Timezone-correct display | `qa-datetime.test.ts` (every 2026 transition of 12 zones in 15-minute steps; Today / Tomorrow at midnight in the session zone; 23 h and 25 h days); `qa-form.test.ts` (untouched timestamps round-trip across DST, repeated hour, half-hour zones) | holds, no defect found |
| Data layer matches the backend | `qa-backendContract.test.ts` (9 RPCs, table reads, every column, embed hints, grants) | holds; **Q2-7** |

### Cannot be verified until hosted Supabase and a device exist

1. Anonymous sign-in on the hosted project, its rate limits and settings.
2. `SecureStore` on a real Android Keystore: a session survives restart and OS upgrade; chunked writes hit no size limit.
3. Realtime delivery and RLS filtering of events, resubscribe after losing the connection, behaviour in the background and on return, the cost of the catch-up refetch.
4. `pg_cron` deciding at the deadline, and the app showing Confirmed / Cancelled without a refresh afterwards.
5. Cold start with and without network on a real phone (Q2-1), including NetInfo's answer on Wi-Fi without internet.
6. Dashed status border, `HexMotif`, status bar and dark theme on Android; TalkBack reading of cards, the RSVP radio group, progress bar and badges; 1.6x font scale.
7. The Android date / time dialogs (`DateTimePickerAndroid` with `onValueChange` / `onDismiss`), `geo:` links, the Share sheet, the clipboard, the hardware back button in the form.
8. React Compiler at runtime (lint passes and nothing suspicious was found by reading, but nothing was rendered).
9. `expo-router/js-tabs` and `Stack.Protected` inside Expo Go (the web and Android bundles compile).
10. Performance with a large community (200 sessions, long participant lists) and on slow networks.

### Manual test script: Android phone, Expo Go, two accounts

Setup: the hosted Supabase project from `docs/SUPABASE_SETUP.md`, `.env.local` filled, `npx expo start`, Expo Go on two phones (or one phone and the web build as the second account). Get the organizer code from `admin_create_community`. Account A = organizer, B = member, C = a third member. Times are in the community's time zone. Numbers in brackets are the Milestone 1 acceptance criteria: 1 onboarding without login, 2 returning user, 3 persistence and the anonymous notice, 4 card content, 5 RSVP changes and feedback, 6 closed / cancelled rejection, 7 minimum display, 8 status distinctions, 9 realtime, 10 details and organizer rights, 11 engineering quality (time zones, offline, accessibility).

1. **(1)** Fresh install on phone A. Open the app. Expect the splash, then the welcome screen, no login or password field anywhere.
2. **(1)** Tap "I have an invitation code". Type the organizer code in lower case with a space in the middle. It must appear as `ABCD-EFGH`. Tap Check code: a success banner with the community name and "organizer".
3. **(1, 3)** Tap Continue. Enter a one-character name: inline error. Enter a valid name, tap Join. The Join button spins, then the Home tab appears with "Hi, <name>". Read the blue notice on this screen: the account lives on this device.
4. **(1)** Phone B: enter a wrong code (`AAAAAAAA`): field error "not valid". Enter a malformed code (`ABC`): the format hint, and no network call (the attempt counter must not go up). Five wrong codes in a row: the "wait 15 minutes" warning. Then use a member code created by A (see step 22) and join as B.
5. **(2, 3)** Phone A: force-stop the app and reopen it. Expect the splash, then straight to Home, no welcome screen flashing by. Then turn on airplane mode, force-stop, reopen, and record what happens (expect Q2-1: the splash may never go away). Turn the network back on.
6. **(3)** Profile tab (A): role Organizer, community time zone, the "Your account lives on this device only" card, app version. Change the name: the Home greeting updates. Try a 1-character name: inline error.
7. **(10)** Phone A, Trainings tab, New training. Create "Saturday long run": date in 3 days, start 09:00, end 10:30, location "Herastrau Park", minimum 3, maximum 4, deadline left on the default. The helper text must show the default deadline with date and time. Create; the details screen of the new training opens.
8. **(4, 7, 8)** On Home (B) the training appears within a few seconds without refresh. Verify the card answers: when ("<weekday>, 09:00"), where, "0 / 3 confirmed", "3 more participants needed", the badge "3 more needed" with an outline and "Not final yet", my answer, the I'm going / Not going buttons.
9. **(5, 9)** B taps "I'm going". The button turns teal at once and the card shows "1 / 3 confirmed" immediately. On phone A (details screen open) the count and the participant list update within about 2 seconds without pull-to-refresh, B under Going.
10. **(5)** B taps "I'm going" again (selected): the answer clears, count 0, A sees it. B taps "Not going": grey, A lists B under Not going. Set it back to going.
11. **(5, 8)** Have A and C answer going. At 3 / 3 expect "3 confirmed (minimum 3)", the badge "Minimum reached" with a dashed outline, and the sentence saying it is not final. C changes to Not going: it returns to "1 more needed" on every phone.
12. **(5)** Reach the maximum (4 going) with a fourth account, or lower the maximum to the going count via Edit. The next member who taps "I'm going" sees "full" and no change of count. A member who is already going can still step down.
13. **(5, 11)** Double-tap "I'm going" quickly on a card: the count changes by one only. Turn on airplane mode, tap "Not going", and record what the app does (Q2-5); turn it off.
14. **(10)** Open the training as B: no Edit or Cancel anywhere, and the Profile tab has no Invitations row. As A: Edit and Cancel are present.
15. **(10)** Details content: title, activity, status banner sentence, date range, "Open in maps" (opens the maps app on the place name, or the pin when coordinates are set), meeting instructions, organizer name, About, progress bar with the minimum marker, participants. Edit to add coordinates `44,4268` and `26,1025` and a place name with parentheses: "Open in maps" shows the pin; note the label (Q2-9).
16. **(6, 8)** Create a second training that starts in 2 hours 10 minutes with the default deadline and 1 going against a minimum of 3. Within about a minute of the deadline expect "Cancelled: too few" (red tint, cross), the sentence about too few people, and "Responses are closed" instead of the buttons. Create a third training, reach the minimum, wait for the deadline: "Confirmed" (filled teal, check) and "Final: this training is happening". B cannot change the answer. Compare the screens: provisional (outline, dashed) versus final (filled) must be obvious without color.
17. **(6)** Keep a card open on B past the deadline without refreshing, then tap an answer before the 30-second clock tick: expect "Responses are closed" and the previous state restored.
18. **(10, 6)** A cancels the first training (Cancel training, confirm in the dialog). B sees "Cancelled by organizer" within seconds (filled danger, ban glyph), different wording from the insufficient case, buttons gone. A no longer gets Cancel, and no Edit.
19. **(10)** A edits a training that is still open: change the title and the start time; B sees it live. Open Edit on the confirmed one: deadline and limits are locked, with the explanation.
20. **(11)** Time zones: set phone B to a zone with a different offset. Open a training: times still read in the community zone, with "Shown in <city> time, which differs from this device." Set it back.
21. **(11)** Pull-to-refresh on Home, Trainings and the details screen. Go to the background for 5 minutes and return: lists refresh. Turn off the network on B, kill and reopen the app, return the network: record the behaviour (Q2-1).
22. **(1, 10)** A: Profile, Invitations: create a code (7 days, 1 use). Share and Copy work. Use it on a new account; the second use fails with "used the maximum number of times". Revoke another code: confirmation dialog, row turns Revoked, the code no longer works.
23. **(10)** Remove B's membership from the SQL editor (`update public.memberships set status = 'removed' where ...`). On B pull to refresh and record how long the app takes to show onboarding (O7) and what the code screen says for a fresh member code.
24. **(11)** Accessibility: turn on TalkBack on B. A card is read as one button: title, time, location, count, status ("not final" when provisional) and answer. The I'm going / Not going pair is read as radio buttons with state; the progress bar reads "x of y confirmed. Minimum z, reached / not reached". Set the largest font size: no clipped text on the card, form or buttons.
25. **(11)** Dark theme: look at Home, details, the form and the status badges in dark mode: text readable, the dashed badge visible.

### What was run

On Windows, embedded Postgres, 2026-11-15:

- `npm test` -> `Test Files  41 passed (41)`, `Tests  1058 passed | 8 expected fail (1066)`. The 8 expected failures are the new `DEFECT Q2-*` tests (Q2-1, Q2-3, Q2-4, Q2-5, Q2-7, Q2-8 twice, Q2-9). The suite also contains the in-progress attendance tests of the backend developer; they were green in this run.
- `npm run lint` -> exit 0, no output.
- `npm run typecheck` -> three errors, all in `supabase/tests/attendance*.test.ts` (`attendance_finalized_at` / `attendance_finalized_by` missing on `Session` in `src/lib/database.types.ts`). They belong to the unfinished Milestone 2 work (untracked migration `20261115000100_attendance_schema.sql`), not to QA files; owner backend. Before that work appeared the command passed with exit 0.
- `npx expo export --platform web` -> `Exported: dist` (1.1 MB entry bundle).
- `npx expo export --platform android` (extra: proves the Hermes bundle builds) -> one `.hbc` bundle of 5.3 MB, `Exported`.
- `npx expo-doctor` -> `20/20 checks passed. No issues detected!`

### Test inventory (part 2)

New files, all under `src/`, all run by `npm test` (no database needed):

| File | Covers |
|---|---|
| `lib/qa-backendContract.test.ts` | table reads, columns, embed hints, RPC argument lists and grants, no service-role RPC from the client, generated types vs SQL (Q2-7) |
| `lib/qa-hygiene.test.ts` | color literals, secrets and env vars, console use, codes in routes / logs, swallowed errors, Pressable roles, clock readers |
| `lib/qa-queryBehavior.test.ts` | offline first load (Q2-1), failed refetch after join (Q2-2 premise), offline mutation (Q2-5) |
| `lib/qa-datetime.test.ts` | every 2026 transition of 12 zones, midnight labels, 23 h and 25 h days |
| `features/rsvp/domain/qa-rsvpRaces.test.ts` | interleaved optimistic changes (Q2-3), refetch mid-request (Q2-4), clamped counts |
| `features/trainings/domain/qa-form.test.ts` | emoji length (Q2-8), number and coordinate parsing, deadline rules, DST round trip of untouched timestamps, server error mapping |
| `features/trainings/domain/qa-maps.test.ts` | parentheses (Q2-9), hostile `map_url` and names |
| `features/trainings/domain/qa-status.test.ts` | exact product strings, 11 stored states, deadline boundaries, provisional vs final, list sectioning, RSVP control rules |

The `it.fails` tests keep `main` green; each turns red the moment its defect is fixed (remove `.fails` then). The Q2-1 and Q2-5 tests copy the `defaultOptions` of `queryClient.ts` because that file imports NetInfo and cannot load in node; if those options change, update the tests.

---

## Milestone 2: attendance, backend and mobile (M2-Q1)

Scope: `supabase/migrations/20261115000100_attendance_schema.sql`, `20261115000200_attendance_rpcs.sql` (read as an attacker, against the Milestone 2 section of `docs/API_CONTRACT.md` and the product rules, not the developers' summaries), `src/features/attendance/**`, the attendance routes, the entry points on details / Home / Trainings / Profile, the extended Realtime hook, `src/features/community/api/members.ts`. App code and migrations were not changed. New QA tests: `supabase/tests/qa-attendance.test.ts` (25 tests) and `src/features/attendance/domain/qa-attendance.test.ts` (31 tests).

### Verdict

**Milestone 2 passes review with conditions: no critical or high defect; one medium (Q3-1) should be fixed before the milestone is called done, and the manual script below must be run on a phone against hosted Supabase.** The security model held under every attack tried: only active organizers of the session's community can read or change attendance (members, outsiders, organizers of another community, removed organizers and `anon` all get `forbidden` or a privilege error), members see only their own rows by every path tried (direct select, joins, counts, filters, the sheet RPC), no client can write the tables or alter an audit row, locks are taken in the Milestone 1 order (no deadlock in 4 randomized mixed storms with cancel, edit, removal and account deletion), every real change writes exactly one audit row and no-ops write none, and `unrecorded` is never turned into `absent` (finalization, the UI wording and the history screen were all checked for that).

The defects are about interplay and polish, not about the attendance core: an edit of a confirmed session can make an already-marked session "not ended" again (Q3-1); an organizer removed while a call was waiting still completes it (Q3-2); "Mark all present" can overwrite a mark entered meanwhile (Q3-3); a screen opened before the end time does not notice the end and blames the phone clock (Q3-4). Q3-1 and Q3-2 are demonstrated by `it.fails` tests (four of them, `DEFECT Q3-n`); Q3-3 and Q3-4 are found by reading, because the wiring lives in a React component that cannot be rendered here. Nothing ran on a device or against hosted Supabase.

### Defects

| Id | Severity | Owner | Where | Summary |
|---|---|---|---|---|
| Q3-1 | medium | backend | `20261114000400_trainings_rpcs.sql:326-364` (`update_training`) | A confirmed, ended session that already has marks can be edited so it is "not ended" again or moved into the future. |
| Q3-2 | low | backend | `20261115000200_attendance_rpcs.sql:24-45, 157, 254, 318, 403` | Authorization is checked before the session lock wait and never repeated: an organizer removed during the wait completes the call. |
| Q3-3 | low | mobile | `AttendanceScreen.tsx:132-145` | "Mark all present" overwrites a mark the organizer set on a not-yet-processed row during the run. |
| Q3-4 | low | mobile | `AttendanceScreen.tsx:102-105, 58-65`; `sheet.ts:95-103` | A sheet loaded before the end time keeps `ended: false`; when the device clock passes the end the screen says "Waiting for the server ... check the date and time on your phone" and never refetches by itself. |

**Q3-1 — editing a session that has marks.**
Reproduction: `qa-attendance.test.ts`, "DEFECT Q3-1" (two `it.fails`): `confirmedSession(1,1)`, mark the member present, then `update_training` with the stored form and `ends_at` = now + 24 h (start unchanged, so no future check applies), or `starts_at` / `ends_at` in the future.
Expected: rejected, or at least refused once attendance rows exist (the contract blocks edits only for `completed`, but marks on a training that "has not happened yet" are nonsense, and statistics later count only `completed`). Actual: succeeds. Consequence (test "documents the consequence"): the sheet reports `ended = false`, further marks and the finalization are refused with `session_not_ended`, the marks already taken stay, and the session reappears under "upcoming" for everyone. Recoverable by editing the end back, so not data loss.
Suggested fix: in `update_training`, when `status = 'confirmed'` and any `attendance_records` row exists (or when the session has already ended), reject changes to `starts_at` / `ends_at` with `validation_failed:starts_at` / `ends_at` (keep title, description and place editable). Product decision: also refuse cancel once marks exist (see O1).

**Q3-2 — removed organizer still completes a queued call.**
Reproduction: `qa-attendance.test.ts`, "DEFECT Q3-2" (two `it.fails`, `record_attendance` and `finalize_attendance`): hold the session lock, start the call (it waits), remove the organizer's membership, release. Expected: `forbidden`. Actual: `ok`; the mark or completion is written after the removal committed. A fresh call from the removed organizer is refused (test passes). The window is the lock wait. Same pattern as `update_training` / `cancel_training` in Milestone 1.
Suggested fix: re-evaluate `public.is_organizer(v_community_id)` after `select ... for update` of the session (in `private.lock_session_for_attendance` and in `finalize_attendance`).

**Q3-3 — mark all overwrites a concurrent mark.** `startMarkAll` captures the target ids once and calls `markAsync({ userId, next: 'present' })` for each, with no check of the row's current status and no `isRowPending` check, while the rows stay tappable (`editable` ignores `markAll.phase`). An organizer who taps Absent on a not-yet-reached row during a long run gets that row overwritten by Present (audited as a correction, but silently). Two mutations for the same row can also overlap, so rollback snapshots chain. Suggested fix: lock the toggles while `markAll.phase === 'running'`, and have the worker skip any row whose current cached status is no longer `unrecorded` or which `isRowPending`. Not demonstrated by a test (component wiring).

**Q3-4 — stale `ended` after the end time passes.** The sheet is fetched once (stale time 30 s); `useNow` ticks every 30 s but nothing refetches when the device clock crosses the end. The screen then shows `hint: 'server_behind'` ("Waiting for the server ... check that the date and time on your phone are right"), which blames the phone although the cache is simply old; the organizer has to pull to refresh. Suggested fix: refetch the sheet once when `deviceSaysEnded` flips to true while `sheet.ended` is false, and reword the hint ("Refreshing ...") so the clock wording only appears if the refetch still says not ended. Not demonstrated by a test.

### Observations (no defect filed; decisions for the lead)

- **O1** `cancel_training` is allowed on a confirmed session that already ended and has marks (the contract says so). The marks then stay but can never be corrected (`session_not_confirmed`), the entry points disappear, nothing is audited, and statistics ignore them (`qa-attendance.test.ts`, "cancelling a confirmed, ended session ..."). Decide whether cancel should be refused once attendance exists.
- **O2** A session without `ends_at` takes attendance and can be finalized from its start time, while the training is still running (test "sessions without an end time"). Contract-conformant; the UI should say so or the form should encourage an end time.
- **O3** A walk-in can be marked Absent or cleared to Unrecorded (the row stays `is_walk_in`). "Absent walk-in" is meaningless; the UI offers both buttons for walk-ins.
- **O4** The audit log is append-only for every client and every RPC (test "append-only through every RPC"), but not against account deletion: deleting an attendee deletes their audit rows (cascade, by contract) and deleting an organizer nulls `changed_by`, so the history then reads "a former organizer". `service_role` and superusers can edit anything (trusted keys).
- **O5** Realtime: `attendance_records` is published with default replica identity. INSERT and UPDATE events pass the select policy per subscriber (RLS is enabled, test "realtime publication"), but Supabase does not apply RLS to DELETE events; they carry only the primary key (no user, no status), and rows are deleted only by cascades. Cannot be verified without a hosted project. The audit log is not published.
- **O6** `training_sessions.attendance_finalized_by` and `_at` are readable by every member (whole-row RLS): members can see which organizer finalized. No absence information leaks.
- **O7** Finalization placeholders (`unrecorded`) carry `recorded_by` = the finalizing organizer, which reads as "recorded by" for a row that records nothing. Cosmetic.
- **O8** A free-text reason is offered only after finalization (`correct` mode); corrections before finalization carry none. The server stores a reason only on a real change.
- **O9** Realtime attendance invalidation is skipped while any record mutation is in flight; the settle refetch covers the sheet and audit only. An organizer who marks themselves can see a stale "my record" or history until the next refetch. Negligible.
- **O10** `fetchMyAttendance` applies `.limit(1000)` before the client-side `completed` filter and without an order; rows of cancelled sessions count against the cap. Irrelevant at Milestone 2 sizes.
- **O11** No index supports `training_sessions.status = 'completed'` scans (Milestone 4). Index coverage of the new tables is otherwise complete: the unique `(session_id, user_id)` serves the session lookups, plus indexes on `user_id`, `community_id`, `recorded_by`, `changed_by` and `(session_id, changed_at)`.
- **O12** `get_attendance_sheet.ended` uses the statement time (`now()`), the writers use `clock_timestamp()`. Harmless (a read), but it explains a sheet that says "not ended" a moment before a mark is accepted.

Reviewed and found sound (backend): every function is `security definer` with an empty `search_path` and a single grantee; the private helpers are unreachable for API roles; the caller is always `auth.uid()` (the only user id parameter is the attendee, and an attendee who is not an active member of the session's community cannot get a new row); composite foreign keys keep `community_id` honest; `had_rsvp_going <> is_walk_in` and `status = 'completed' iff attendance_finalized_at is not null` are table checks; `clock_timestamp()` after the lock wait is used for the "ended" rule (proved by the developers' test); the lock order profile, membership, session is the Milestone 1 order, and finalize additionally key-share-locks the going members' profiles before the session, so a concurrent account deletion cannot deadlock; the first mark is audited `record` and every later one `correct`; finalization creates placeholders only for active going members and is idempotent.

### Evidence map: Milestone 2 requirements

Key: **test** = automated, ran green; **dev** = the developers' suites (`attendance*.test.ts`, `src/features/attendance/domain/*.test.ts`); **qa** = QA files; **code** = read in the source; **device** = needs the manual script; **hosted** = needs a hosted Supabase project.

| Requirement | Evidence | Result |
|---|---|---|
| RSVP is intention, attendance is actual participation | dev (`attendance.test.ts` going / walk-in / snapshot); qa (snapshot stays when the RSVP row changes; a walk-in cannot RSVP going after confirmation) | holds |
| After the session ends the organizer opens it and sees who RSVP'd | dev (sheet); code (`AttendanceScreen`, entry points on details, Home "Needs attendance", Trainings cue) | holds; device |
| Mark Present / Absent, fast toggling | code (two large radio buttons, tap again clears, one change per row, optimistic with single-row rollback); dev + qa (`sheetCache`, tap matrix) | holds on paper; device for feel; Q3-3 |
| Add a walk-in | dev (backend, modal logic); qa (a not_going member is a walk-in; a going member is refused; the search is plain text) | holds; O3 |
| Finalize, history updates | dev; qa (placeholders after later removal, queue orders with cancel and edit); code (finalize invalidates lists, detail, sheet, audit, my history and my record) | holds; hosted for the live refresh on a member's phone |
| Present / Absent / Unrecorded; Unrecorded is not Absent | dev (finalize never converts); qa (wording scan: no "absent / missed / no-show" in any member-facing text for unrecorded, distinct glyph and color, header counts) | holds |
| Corrections after finalization with who / when / what | dev; qa (audit rows are append-only through every RPC; a correction after finalization records actor, old, new and the trimmed reason) | holds; O4 |
| Cancelled sessions never count toward statistics | qa (a cancelled session keeps marks, a `completed`-only query returns 0; history filter on the client) | holds as a rule; O1; the statistics themselves are Milestone 4 |
| DB uniqueness prevents duplicates | dev (constraint); qa + dev (concurrent identical marks and walk-ins, mixed storms) | holds |
| Unauthorized attendance edits | dev (`attendance-security.test.ts`); qa (removed organizer, fresh call and queued call; direct writes and joins) | holds; Q3-2 low |
| Members see only their own attendance | dev; qa (counts, joins, filters, an organizer of another community, the sheet RPC) | holds; hosted for Realtime |
| Audit trail consistency | dev (trace trigger: audit equals real changes); qa (chains from `unrecorded` to the stored status in 4 mixed storms; append-only snapshot test) | holds |
| Concurrency (mark vs finalize vs cancel vs edit vs removal vs account deletion) | dev; qa (deterministic queue tests in both orders; 4 randomized storms, zero unexpected errors) | holds; Q3-1 shows an edit interplay |
| Timezone and clock | dev (server clock after a lock wait); qa (no end time, one second before the start, history month in the session's zone across the new year, unknown zone) | holds; Q3-4 for the screen's clock use |
| Query shapes match the schema | qa (`qa-attendance.test.ts` reads the SQL: sheet jsonb keys equal the TypeScript types, RPC argument names, named foreign keys incl. the two links from the audit log to `profiles`, every selected column exists) | holds; hosted for PostgREST embed resolution |
| A removed member's name | code: the sheet comes from the RPC (definer; shows removed members as "No longer a member"); the audit "changed by" is an RLS-filtered embed, so a removed organizer renders as "a former organizer" (acceptable) | holds |
| Accessibility | code (radio group with per-member labels, `checked` / `busy` state, status as glyph plus text, dashed chip for Not recorded, 44 px targets, History button labelled with the name); `qa-hygiene` (roles, touch targets, no color literals) | holds on paper; device (TalkBack, 1.6x font; no live region on the mark-all banner) |
| Realtime | code (one channel, community filter, coalesced, skipped while a change is saved); dev (`coalesce`); qa (publication and RLS) | unverified live |
| Expo Go | web export builds; code reading found no native-only API outside Expo Go | device |

### Not verifiable until hosted Supabase and a device exist

1. Realtime for `attendance_records`: delivery, RLS filtering per subscriber with the definer helpers, DELETE events (O5), the `community_id` filter, and that a member's phone learns of finalization and corrections.
2. PostgREST: resolving the `training_sessions!attendance_records_session_fkey` embed (a composite foreign key) and the `profiles!attendance_audit_log_changed_by_fkey` embed; the composite return of the record RPCs as a single JSON object.
3. Default privileges on the new tables and functions on the hosted project (re-run the privilege queries of `qa-privileges.test.ts`).
4. React Compiler behaviour of the new components at runtime, the modals on Android (the back button closes the sheet and the reason dialog), `FlatList` with 100+ rows, keyboard behaviour of the reason field.
5. TalkBack reading of the toggles, chips and banners; the dashed "Not recorded" chip on Android; dark theme.
6. Whether a phone clock that differs from the server's makes the entry-point cue and the screen disagree (Q3-4).

### Manual test script additions (continue the numbering of the Milestone 1 script)

Setup: accounts A (organizer), B, C, D (members), optionally E (second organizer). A training that is confirmed: minimum 2, short deadline, A's phone knows B and C answer going, D does not answer; let the deadline pass and the training start and end (use a short training that starts about 10 minutes after the deadline). An owner with SQL access can move the times as the tests do.

26. **(M2)** A: Home. Expect a "Needs attendance" section with the training once it is over (warning glyph plus the words). The Trainings tab card shows the same cue. B (member): neither appears.
27. A: open the training from Home. Expect the "Attendance" screen: header "Present 0 · Absent 0 · Unrecorded 2 · of 2 who said going", the sentence that Not recorded is never counted as absent, B and C listed as "Said going" with a dashed "Not recorded" chip.
28. A: tap Present on B. The button turns teal and filled at once with a check, the chip changes to Present, the count updates. Tap Present on B again: back to Not recorded. Tap Absent on B: red, filled, chip Absent. Tap rapidly three times on one row: no stacking, no flicker back to an old value.
29. A: turn on airplane mode, tap Present on C. Expect the row to return to Not recorded with "Not saved ... The previous value is back." and no other row affected. Turn the network on and tap again: saved.
30. A: tap Add attendee, search D by part of the name (also try a name with an accent). D is listed "Add as walk-in (Present)". Tap D: banner "D was added as Present", D drops out of the list and appears on the sheet as "Walk-in", Present. Tap Done.
31. A: with C still unrecorded tap Mark all present: the confirmation states how many; confirm. Expect progress text, then success, C Present. In a run with many rows, tap Absent on a row further down while it runs and record what happens (Q3-3).
32. B: open the training: nothing about attendance yet (not finalized). Profile tab, "My attendance": expect the empty state.
33. A: clear C back to Not recorded, tap Finalize attendance. The dialog states the number of people who stay Not recorded and that they are NOT counted as absent. Confirm. Expect the screen to switch to "Attendance is finalized ... by <A>" and the training to read Completed on the details screen and in the lists within seconds, without a refresh.
34. C (said going, left Unrecorded): open the training: the card says "Attendance not recorded" (never "absent"). Profile, My attendance: the training appears under its month with "Not recorded", and the counts line says "Not recorded 1", not "Absent". B sees "You were marked absent" (or present, as marked). D (walk-in): "You were present".
35. A: View / correct attendance. Tap Present on C. A "Save correction" dialog with an optional reason appears: enter "arrived late" and save. Expect Present. Tap History on C: exactly one line, "Corrected: Not recorded to Present", time in the session's zone, "by <A>", "Reason: arrived late". Save another correction with an empty reason: no reason line.
36. A: tap the same segment again (clear C) with a 200-character reason; try to type a 201st character (the field stops at 200). C's History lists the changes in order.
37. E (second organizer) corrects B while A corrects C: both succeed. Correct the same member from both phones within a second: the later one wins and both histories show both changes.
38. With B's and C's phones open on the training details, A corrects them: the outcome text updates within a few seconds without a refresh (Realtime).
39. A: Edit the finalized training: "can no longer be edited"; Cancel: "already completed and cannot be cancelled".
40. A cancelled training and one still awaiting the minimum: the attendance screen explains why nothing can be recorded, no buttons. Open the attendance screen of a confirmed training in the future, with a correct phone clock: "has not ended yet".
41. Set A's phone clock one hour ahead and open a confirmed training that ends in 30 minutes: the entry shows "Record attendance", the screen says the server has not registered the end. Record that the hint blames the phone clock and whether a pull to refresh clears it (Q3-4). Reset the clock.
42. Open the attendance screen 2 minutes before a training ends and keep it open past the end: record whether it updates by itself (Q3-4).
43. Remove D's membership (SQL) after finalization: the sheet still lists D as "No longer a member", and a correction works; D's phone shows onboarding and no history. Repeat before finalization with a going member: that member gets no placeholder row.
44. TalkBack on A: a row reads "Attendance of <name>" with Present / Absent as radio buttons and their state; the chip reads "Status: Not recorded"; the History button reads "History of <name>". Largest font size: no clipped names or buttons. Dark theme: the dashed chip, filled buttons and banners are readable.
45. B opens `/trainings/<id>/attendance` (deep link, or by typing the route on the web build): redirected to the details screen, no sheet.

### What was run (M2-Q1)

On Windows, embedded Postgres, 2026-11-15:

- `npm test` (run twice in a row) -> both times `Test Files  47 passed (47)`, `Tests  1180 passed | 4 expected fail (1184)`. The 4 expected failures are the `DEFECT Q3-1` (2) and `DEFECT Q3-2` (2) tests; the Milestone 1 `it.fails` tests no longer exist. Each defect test was also run once with `.fails` removed and failed for the stated reason (`promise resolved ... instead of rejecting`; `expected 'ok' to be 'P0001:forbidden'`).
- `npm run typecheck` -> exit 0, no output.
- `npm run lint` -> exit 0, no output.
- `npx expo export --platform web` -> `Exported: dist`.
- `npx expo-doctor` -> `20/20 checks passed. No issues detected!`
- Not run: the Android bundle, any device, any hosted Supabase.

### Test inventory (M2-Q1)

| File | Tests | Covers |
|---|---|---|
| `supabase/tests/qa-attendance.test.ts` | 25 (21 passing, 4 expected fail) | update_training and cancel_training on sessions with marks; deterministic lock queues (record / cancel / finalize / edit in both orders); removed organizer mid-wait; snapshot integrity; append-only audit; leakage through joins and counts; realtime publication and RLS; sessions without an end; placeholders of later-removed members; mixed concurrent storm (4 rounds) |
| `src/features/attendance/domain/qa-attendance.test.ts` | 31 | sheet JSON keys vs SQL, RPC argument names, FK names and columns vs SQL; "Not recorded" wording and glyphs; tap matrix; mark-all targets and stop rules for every error code; counts and sorting; walk-in search; mode matrix (status, ended, device clock); history grouping across zones; overlapping optimistic rows |

## Milestone 3: communications and notifications (M3-Q1)

Scope: migrations `20261115000300..600`, the Edge Function `supabase/functions/dispatch-notifications/` (`dispatch.ts`, `index.ts`), `src/features/notifications/`, `src/app/(app)/(tabs)/activity.tsx`, `src/app/(app)/announcements/`. Reviewed against the spec, `docs/API_CONTRACT.md` and the Expo push documentation (https://docs.expo.dev/push-notifications/sending-notifications/, read 2026-11-15). Nothing was run against Expo, FCM, a hosted Supabase project or a device.

### Verdict

**The backend core of Milestone 3 passes; the push dispatcher has one medium defect that must be fixed before real users register tokens.** Authorization, community isolation, scheduled publication, fan-out recipients, deduplication and the outbox state machine held under every adversarial and concurrent probe. Six defects are open (one medium, two low-medium, three low). The six `it.fails` tests (Q4-1, Q4-2, Q4-4, Q4-5 twice, Q4-6) turn red when the defects are fixed (remove `.fails` then).

### Defects

| Id | Severity | Where | Summary | Owner |
|---|---|---|---|---|
| Q4-1 | medium | `supabase/functions/dispatch-notifications/dispatch.ts:239-241, 328-354` | One foreign-project token makes Expo reject a whole chunk; every job in it (up to 100 users) is marked `dead`. | backend |
| Q4-2 | low-medium | `dispatch.ts:328-391` | Jobs are completed only after all Expo requests of the run; a run killed between chunks re-sends already accepted pushes. | backend |
| Q4-3 | low | `src/features/notifications/hooks/PushProvider.tsx:62`; no caller of `unregister_push_token` | A token change that arrives while a registration is running is dropped; the token is never unregistered. Code review only, no test. | mobile |
| Q4-4 | low-medium | `src/features/notifications/components/ActivityScreen.tsx:222`; `domain/activityCache.ts:87,104`; `20261115000400_notifications_rpcs.sql:729-753` | "Mark all read" leaves announcements unread, so the tab badge keeps a number; the optimistic notification read claims the server marks the announcement too, it does not. | mobile (or backend) |
| Q4-5 | low | `20261115000400_notifications_rpcs.sql:32-55` | Titles of only zero-width / no-break spaces pass; control characters and bidi overrides are stored and pushed. | backend |
| Q4-6 | low (defense in depth) | `20261115000300_notifications_schema.sql:105-106` | The `deep_link` check accepts `//evil.example` and `/trainings/../..`. Not reachable today (definer functions build fixed routes, the app allowlists). | backend |

**Q4-1.** Reproduction: `qa-comms-dispatch.test.ts`, "DEFECT Q4-1". Three members, three tokens, one belonging to another Expo project; the fake Expo answers HTTP 400 `PUSH_TOO_MANY_EXPERIENCE_IDS` for a request that contains it. Expected: the other two users are delivered (the Expo docs say to remove the tokens of other experiences and resend). Actual: all three jobs are `dead` (`permanent:HTTP_400`). `register_push_token` accepts any well-formed token and anonymous sign-in is free, so any visitor can plant one. Fix: on a 400 with more than one message, bisect the chunk (or read `details` of `PUSH_TOO_MANY_EXPERIENCE_IDS`), invalidate only the offending token, resend the rest.

**Q4-2.** Reproduction: "DEFECT Q4-2". 130 jobs; while the second Expo request is in flight, 0 jobs are `sent` (expected 100). With up to 10 tokens per user and sequential 15 s timeouts a run can exceed the Edge limit, leaving accepted jobs in `sending`; after 5 minutes they are pushed again. Fix: complete each chunk's jobs right after its answer. Related: one run claims at most 100 jobs, so an announcement to 1,000 members takes 10+ minutes at one run per minute; loop until the claim is empty or a time budget is used.

**Q4-3.** `registerDevice` returns when `busy.current` is set, so `onPushTokenChanged` firing during a run is lost until the next foreground. `unregister_push_token` exists but nothing calls it (the app has no sign-out; "push off" keeps the token and the server honours the preference). Harmless today; revisit if sign-out is added.

**Q4-4.** Reproduction: `src/features/notifications/domain/qa-notifications.test.ts`, "DEFECT Q4-4"; the backend side is pinned (passing) by `qa-comms.test.ts` "read-state asymmetry". After `mark_all_notifications_read`, `unread_announcement_count` is still 1, and `combinedUnreadCount` counts the announcement again because its notification is read and no longer "covers" it. Fix: have the same action also call `mark_announcements_read`, or make `mark_all_notifications_read` insert the matching `announcement_reads`; correct the comment at `activityCache.ts:87`.

**Q4-5.** Reproduction: "DEFECT Q4-5" (two tests in `qa-comms.test.ts`). Expected `validation_failed:title` for `​​`, NBSP-only, `⠀`; actual: stored. `\u0007` and `‮` are stored and sent in the push title. Fix: reject or strip control, zero-width and bidi characters and treat Unicode whitespace as blank in `clean_required_text`.

**Q4-6.** Reproduction: "DEFECT Q4-6". A direct insert of `//evil.example/x`, `/trainings/../../admin` or `/x?next=//evil.example` succeeds. Fix: `deep_link ~ '^/(trainings|announcements)/[0-9a-f-]{36}$'`.

### Observations (no defect filed)

- **O-1** Nothing limits announcement volume (25 announcements to 3 members created 75 notifications and 75 jobs, `qa-comms.test.ts`). The organizer is a trusted role; a per-community rate limit would bound spam and fan-out cost.
- **O-2** The purge never deletes notifications (tested), so the table grows by members x events without bound. Add a retention to `purge_old_notification_data`.
- **O-3** The push badge (`unread_count`) counts every unread notification of the user, including hidden ones of a community the user left (tested).
- **O-4** Token ownership. `register_push_token` re-assigns a token to whoever registers it (pinned in `qa-comms.test.ts`). Whoever knows a device's Expo token can cut that device off from its owner's pushes; they never receive the owner's content, the device receives theirs. Expo tokens are not public but not strong secrets either. Accepted risk; mitigation if wanted: rate-limit reassignments.
- **O-5** A scheduled time in a DST gap (Bucharest 2027-03-28 03:30) is silently moved to 04:30 and an ambiguous time takes the first occurrence; the form shows no warning (`qa-notifications.test.ts`). Notification text carries no UTC offset, so the repeated hour of a fall-back reads identically twice (tested).
- **O-6** The client counts a title with runs of spaces by raw characters, the server after collapsing them; the client is stricter in that rare case. A joining member sees the community's old announcements as unread.
- **O-7** `verify_jwt = false` is acceptable: the function rejects everything without the exact secret (constant time; an unset or empty secret rejects all; tested), reads the service key only from its own environment, and calls only the fixed Expo URL (no SSRF); logs and `last_error` hold counts and codes only (tested). There is no rate limit on the 401 path (platform level).
- **O-8** Receipts are not read (documented); `DeviceNotRegistered` is noticed one send late.

Reviewed and found sound: every new function has a single grantee and an empty `search_path` (the M1 matrix covers the new names); `notification_delivery_jobs` has no grant; recipients are always active members and the actor is excluded; RSVP changes never notify (storm test); a repeated identical edit fires nothing and a revert fires once; the 24h window is exactly (23h, 24h] (edges tested) and a rescheduled session gets fresh reminders; DST text follows the session zone; scheduled announcements publish once, cancelled ones never; a demoted organizer loses all powers and the scheduled announcement still publishes; the outbox claim is exclusive, stale `sending` jobs are reclaimed, preferences and membership are applied at claim time; the triggers take no lock on profiles (no deadlock with deletion); the deep-link allowlist rejected 40+ hostile shapes and a 1 MB string in under 500 ms; the dispatcher payload round-trips through the app parser; the `default` Android channel is the same in the plugin config, the native module and the dispatcher; RPC argument names in the app equal the SQL declarations.

### Evidence map: Milestone 3 requirements

Key: **dev** developers' suites; **qa** QA files (`qa-comms*.test.ts`, `qa-notifications.test.ts`); **code** read in source; **device** needs the manual script; **hosted** needs hosted Supabase / Expo / FCM.

| Requirement | Evidence | Result |
|---|---|---|
| Organizers publish now or scheduled; only organizers | dev (`announcements.test.ts`); qa (other community, demoted, member) | holds |
| Scheduled messages run server-side, independent of the phone | dev + qa (`publish_due_announcements` once, concurrent runs, cancel race); migration `500` (pg_cron, guarded) | holds in tests; hosted for the real schedule |
| Feed with unread indicators; no chat | dev; qa (read state, isolation); code (no messaging UI) | holds; Q4-4 |
| Push for new / updated / confirmed / cancelled trainings, reminders, announcements | dev; qa (recipient exactness for edge membership states, reminder windows, rescheduling) | holds |
| No community-wide push per RSVP change | dev; qa (RSVP storm creates no notification) | holds |
| Backend-managed dispatch, idempotent outbox, retry transient, dedupe | dev (`dispatch.test.ts`, outbox); qa (Q4-1, Q4-2, partial failure, logs) | holds except Q4-1, Q4-2 |
| Permission requested appropriately | code (`PushProvider` reads at start, `enable` only from a user action); qa (state machine over all combinations) | holds; device |
| Tokens stored / refreshed, multiple per user | dev; qa (format fuzz, swap and storm concurrency, cap 10) | holds; Q4-3 |
| In-app records persisted; meaningful with push denied | dev (always stored, `skipped no_tokens`); code (settings and prompt copy) | holds |
| Invalid push tokens | dev (`DeviceNotRegistered`); qa (format fuzz, O-4, Q4-1) | holds except Q4-1 |
| Deep links, foreground / background | qa (allowlist fuzz, round trip, queue); code (`useNotificationLinks`, foreground handler) | holds on paper; device |
| Required tests: scheduled publication, notification idempotency, duplicate dispatch prevention, invalid tokens | dev + qa | present |

### Not verifiable without hosted Supabase, an Expo account, FCM and a device

1. Real delivery through Expo and FCM; ticket and receipt behaviour; the HTTP status Expo uses for `PUSH_TOO_MANY_EXPERIENCE_IDS` and how it treats a malformed or foreign token (the docs page does not state it; Q4-1 relies on its statement that a 4xx means the whole request failed).
2. `index.ts` under Deno: `npm:@supabase/supabase-js@2.119.0` resolution, `Deno.serve`, `--no-verify-jwt`, secrets; the platform's wall-clock limit (Q4-2). Only `dispatch.ts` runs, under Node.
3. pg_cron, pg_net, Vault: the three cron jobs and the dispatch job, `vault.decrypted_secrets` privileges, the guarded migrations on a real project, `net._http_response` growth.
4. Realtime: per-subscriber RLS for `announcements` and `notifications`, DELETE events (primary key only, not RLS-filtered), the filters.
5. PostgREST embeds and composite return types of the RPCs.
6. Android: development build, the permission dialog on Android 13+, channel `default`, killed / background / foreground taps, Expo Go on Android (the static import of `expo-notifications` may log a warning or error at load; the code avoids native calls there). `extra.eas.projectId` is not in `app.json` yet (push shows "not configured" until `eas init`) and there is no `google-services.json`.
7. TalkBack, large fonts and dark theme on the new screens; the React Compiler at runtime for the new components.

### Manual test script additions (continue the numbering of the Milestone 2 script)

Setup: organizer A, members B, C, D on separate phones or accounts; B has the development build with push allowed; C has push denied; D has the app closed. The owner needs SQL access for the cron checks.

46. **(M3)** A: Activity tab, Announcements. Tap New announcement, enter a title and message, leave "Publish now", Publish. A confirmation dialog warns that the whole community is notified; confirm. Expect it in the feed without a refresh; A gets no notification and no unread dot for it.
47. B (app open): within seconds a banner appears; Activity shows the tab badge, an unread dot on the announcement and an unread notification. Open it: the dot and badge clear. C and D: the announcement is in their feed (C has no push, D sees it on next open).
48. A: New announcement, "Schedule for...", date and time 3 minutes ahead (the helper line names the community's time zone). Save. Expect it under "Scheduled and cancelled" with the time in the community's zone. B and C see nothing.
49. A: close the app completely and lock the phone. After the time passes (allow up to 2 minutes) B receives the push without A's phone being involved, and the announcement is in everyone's feed. Record the delay.
50. A: schedule another for 10 minutes ahead, open it, Edit, change text and time, save; then Cancel announcement ("Nobody has been notified"). Wait past the time: nothing is published, nothing is pushed.
51. A: schedule for a time in the community's DST gap if one is near; a past time shows "must be in the future"; 366 days ahead shows the limit. Paste 101 emoji into Title: the counter and error show the 100 limit.
52. B: Notifications section: rows for training and announcement events with the time in the community's zone. Tap "Mark all read": record whether the tab badge and the Announcements count clear (Q4-4).
53. A creates a training: B and C get "New training" (push for B). Change only the description: no notification. Change the location: "Training updated" for everyone except A and members who said not going. B switches RSVP going / not going repeatedly: nobody receives anything.
54. Let a training reach its deadline with enough RSVPs: going members and A get "Training confirmed"; with too few: everyone not "not going" gets "Training cancelled ... not enough participants". A cancels another by hand: B gets "cancelled", A does not.
55. Reminders: a confirmed training starting in about 24 hours and one in about 2 hours: going members get "Tomorrow:" and "Starting soon:" once each; reschedule by 30 minutes: fresh reminders only if the new start is inside a window; a member who said not going gets none.
56. Push in a development build (follow `docs/PUSH_SETUP.md`): fresh install, sign in; Activity shows the "Get notified" card and nothing was asked at launch. Tap Enable: the system dialog appears; allow. Profile, Notifications: "This device receives push notifications".
57. C (permission denied): Profile, Notifications shows the denied state with a button; when the system blocks asking again the button opens system settings. C still sees everything in Activity.
58. Preferences: B turns off Announcements, A publishes: B gets no push but has the in-app row. Turn off "Push notifications": no pushes of any kind, in-app rows stay. Turn them back on.
59. Deep links: send each kind of push to B in three states. (a) app killed: tap the push; expect the app to open on the right training or announcement after the gate, not a blank screen, and Back leads to the tabs. (b) app in background: tap; same. (c) app in foreground: the banner shows; tapping opens the screen and the notification is marked read. Tap the same notification twice: it opens once.
60. Hostile payload (test sender or Expo's push tool): data `{"deepLink":"//evil.example"}`, `{"deepLink":"/trainings/<id>/edit"}`, `{"deepLink":"/announcements/not-a-uuid"}`: the app opens nothing and does not crash. A link to a training the member cannot see shows the not found state.
61. Remove B from the community (SQL): B's phone shows onboarding and receives no further pushes (job `skipped`, `not_a_member`); old notifications are not shown.
62. Uninstall the app on B, publish an announcement, wait a minute: the job is `skipped` with `no_valid_tokens` and the token has `invalidated_at` (SQL). Reinstall and allow push: a new token is registered and pushes arrive again.
63. Two phones signed in as B: both receive the push (multiple tokens). Sign B in on a phone that was A's: the token moves and A's phone stops receiving (O-4).
64. Cron: `select jobname, schedule, active from cron.job` lists the four `trainhive_*` jobs; `cron.job_run_details` shows a run each minute; `net._http_response` shows 200 from the function; `curl` without the secret header returns 401.
65. TalkBack on Activity: rows read "Unread. <title>. <preview and time>", the segmented control reads the unread counts, the settings switches are labelled; largest font: nothing clipped; dark theme: unread dots, badges and banners readable.
66. Expo Go on Android: the app starts without a red error from `expo-notifications`; Profile, Notifications says push needs a development build; Activity still works.

### What was run (M3-Q1)

On Windows, embedded Postgres, 2026-11-15:

- `npm test` -> `Test Files  65 passed (65)`, `Tests  1486 passed | 6 expected fail (1492)` (166 s). The 6 expected failures are the new `DEFECT Q4-n` tests (Q4-1, Q4-2, Q4-4, Q4-5 twice, Q4-6); the earlier milestones have no expected failures left.
- Q4-1 and Q4-2 were re-run once with `.fails` removed and failed for the stated reasons (`expected 'dead' to be 'sent'`; `expected +0 to be 100`).
- `npm run typecheck` -> exit 0, no output.
- `npm run lint` -> exit 0, no output.
- `npx expo export --platform web` -> `Exported: dist`.
- `npx expo-doctor` -> `20/20 checks passed. No issues detected!`
- Not run: Android bundle, Deno, any device, Expo, FCM, hosted Supabase.

### Test inventory (M3-Q1)

| File | Tests | Covers |
|---|---|---|
| `supabase/tests/qa-comms.test.ts` | 30 (27 passing, 3 expected fail) | isolation matrix for every new table and RPC; removed, demoted and reinstated members; fan-out recipient exactness; edit repeat and revert; reminder window edges, rescheduling, cancelled; DST text; text and token fuzzing; token ownership and concurrency; growth and abuse observations; realtime publication |
| `supabase/tests/qa-comms-dispatch.test.ts` | 8 (6 passing, 2 expected fail) | shared-secret edge cases; Q4-1; Q4-2; partial chunk failure; log and `last_error` leak check |
| `src/features/notifications/domain/qa-notifications.test.ts` | 26 (25 passing, 1 expected fail) | deep-link and push-data fuzz; payload round trip; Android channel consistency; navigation queue; unread and badge; Q4-4; form vs server rules, DST, limits; push state machine over all combinations; RPC argument names and columns vs SQL |
---

## Milestone 4: statistics (M4-Q1)

Scope: `supabase/migrations/20261117000100_statistics.sql` and `20261117000200_announcement_read_lock.sql`, `src/features/statistics/`, the tab and route wiring, reviewed against `docs/STATS_DEFINITIONS.md`, the Milestone 4 section of `docs/API_CONTRACT.md` and the product spec, not the developers' summaries. The reference implementation was written from the definitions before the SQL was read.

### Verdict

**The statistics SQL passes; the app passes with small defects; there is one product-level decision the owner has to take before release (Q5-1).**

- Independent recomputation: a TypeScript reference (`supabase/tests/qa-stats-reference.ts`) agrees field by field with all five RPCs on 36 seeded random seasons, every window, before and after corrections, deleted records, moved sessions, a removal and a changed community time zone. No SQL defect was found. The harness is proven sensitive (an unmodelled correction is reported).
- Authorization held under every attack (member, other community, removed member and organizer, demoted organizer, anon, service_role, private helpers, malformed ids). No member-visible payload contains another member's id or name.
- Five defects are filed, none critical or high: two medium (a copy/behaviour contradiction about "Not recorded", and the organizer cannot see a member's history although the definitions say so) and three low. They are documented by `it.fails` tests, so `main` stays green and each turns red when fixed (remove `.fails` then).
- Nine definition choices deviate from, or go beyond, the spec's literal wording. They are listed as decisions for the owner below; three of them change numbers visibly (D1, D2, D3).

### Defects

| Id | Sev | Where | Summary | Owner |
|---|---|---|---|---|
| Q5-1 | medium | `src/features/statistics/domain/copy.ts:8, :25`; `components/MemberStatsView.tsx:63`; SQL `20261117000100_statistics.sql:284` | The screens say Not recorded "is not counted as an absence", but the attendance rate keeps it in the denominator, so for the rate it is exactly an absence. | lead decides (D2), then mobile (copy) or backend (definition) |
| Q5-2 | low | `components/CommunityOverview.tsx:33, :68` | The small-sample label of "RSVP to attendance" reads "based on 2 trainings", but the denominator is a number of going RSVPs (people). | mobile |
| Q5-3 | low | `domain/chart.ts:53`; `components/CommunityOverview.tsx:103` | The middle tick of a count chart is `max / 2` printed with one decimal: 0.75 is labelled "0.8" (1.25 as "1.3"). | mobile |
| Q5-4 | medium | no RPC; `components/MemberDetailScreen.tsx:25`; `docs/STATS_DEFINITIONS.md:21` | "Historical attendance" is part of the member statistics "visible to that member and to organizers"; only `get_my_attendance_history` exists, so an organizer cannot see the sessions behind a member's numbers. | backend (new RPC), mobile |
| Q5-5 | low | `src/lib/database.types.ts:1412` | `MemberStatisticsSummaryRow` inherits `recorded` from `MemberStatisticsCounts`, but summary lines do not carry it (the contract lists none). | backend (types) |

**Q5-1 reproduction** (`qa-stats-app.test.ts`, "DEFECT Q5-1"): one session present, one going-and-unrecorded, none marked absent: `absent: 0`, `not_recorded: 1`, `attendance_rate: 50`. Expected by the copy: 100 (not counted as an absence). Actual: 50, identical to a member marked absent. `RATE_NOTE` does state the denominator, so the number is explainable, but "Not an absence" next to a rate that treats it as one misleads. Options: (a) change the copy ("Not recorded does not count as attended; it stays in the denominator"), (b) change the definition so the rate is over recorded sessions (then the spec's formula "attended eligible / eligible" no longer holds literally). Numbers for both are in D2.

**Q5-2** (`qa-stats-app.test.ts`, "DEFECT Q5-2"): one training, two going and present: `rsvp_going_recorded: 2`, label "based on 2 trainings". Expected: a label that names recorded RSVPs, or none.

**Q5-3** (`qa-statistics.test.ts`, "DEFECT Q5-3"): cosmetic; bars are positioned correctly, only the axis text is rounded.

**Q5-4** (`qa-stats-app.test.ts`, "DEFECT Q5-4": checks that a second history function exists). Fix: `get_member_attendance_history(p_community_id, p_user_id, p_window, p_limit, p_before)` for active organizers, same payload as the member's own, and a History section on the member screen. Until then an organizer sees counts but not which trainings were Not recorded.

**Q5-5** (`qa-stats-app.test.ts`, "DEFECT Q5-5"): harmless today (the app never reads `row.recorded`); make the type omit it or return it from the SQL.

### Observations (no defect filed)

- **O1** `MemberDetailScreen.tsx:32, :54`: the member's name comes from the route parameter (capped at 60 characters), not from the payload, and the banner for a removed member says "has left the community" although an organizer may have removed them. A hand-written link can show any name. Low; use the payload's membership status, a neutral sentence ("is no longer a member") and look the name up from the summary.
- **O2** `HistorySection.tsx:105`: a failed refetch of the first page while older pages are cached shows the stale list with no banner (only a failed "Load more" has one).
- **O3** `StatisticsScreen.tsx:123`: if the membership query fails after loading (no community), the member view shows the skeleton forever (disabled queries stay pending). Unreachable behind the route gate.
- **O4** `list_member_statistics_summary` stops at 500 members, ordered by name; an organizer of a larger community cannot reach the members after the cut (the screen says so, `truncatedNote`).
- **O5** A history page can exceed the limit by the size of a same-instant group (documented in the contract; tested with 60 sessions at one instant: nothing is skipped or repeated).
- **O6** A stored community time zone the database cannot resolve makes the member and community functions fail with a raw `22023` (history and summary keep working). Unreachable through the API (no RPC writes the zone, the table is select-only; the creation RPC validates it).
- **O7** In zones whose DST rule moves local midnight (America/Havana, America/Asuncion, Asia/Tehran, Antarctica/Vostok) a month or week bucket starts at 01:00 or 23:00 local instead of 00:00. Buckets stay contiguous (verified for every zone in `pg_timezone_names`, 2020 to 2030); only a session in the skipped hour could be affected.
- **O8** The summary and member views include organizers: an organizer who never attends shows 0% with every session Not recorded (scenario below, Olga). Consistent with the definitions (any role), possibly surprising.
- **O9** The client's `isOrganizer` comes from the cached membership; a demoted organizer gets `forbidden` from the server (the overview handles it with "Organizers only"; the member list shows a generic error instead).
- **O10** The second migration (`announcement_read_lock`) was reviewed together with the existing `announcement-read-lock.test.ts`; nothing further found.

### Decisions needing the owner's confirmation

These are not bugs against `STATS_DEFINITIONS.md` (it states each of them) but they deviate from, or go beyond, the product spec's literal wording. Numbers are from the scenario at the end of this section (4 trainings in 30 days).

| # | Decision shipped | Spec's literal wording | Effect on the scenario |
|---|---|---|---|
| D1 | RSVP reliability = going and present / going **with a recorded outcome** | "attended with RSVP Going / finalized trainings with RSVP Going" | Cora: 100% (2 of 2) vs literal 66.7% (2 of 3; one going session was never marked). Ana and Bogdan are the same either way. |
| D2 | Attendance rate keeps **Not recorded in the denominator** (the spec's formula) while the screen calls it "not an absence" (Q5-1). Alternative: rate over recorded sessions. | "attended eligible trainings / eligible trainings" and "never count unrecorded as absences" (the two conflict as soon as a sheet is not fully marked) | Bogdan: 50% (2 of 4) vs 66.7% (2 of 3 recorded). Cora: 75% vs 100%. |
| D3 | Sessions where the member said "not going" or never answered stay in their eligible set; organizers mark only going members and walk-ins, so those sessions are Not recorded. | "eligible = finalized, completed, not cancelled, scheduled after joining" (no RSVP condition) | Bogdan's Run 3 ("not going") lowers his rate. Someone who attends half of the trainings they signed up for and skips the rest looks like someone who attends half of all. |
| D4 | A removed member's own numbers (organizer view) use sessions after the removal as eligible, so the rate is diluted by trainings they could not attend. | Rule 3: not counted for sessions after removal (the schema has no `left_at`) | A member removed after Run 1 shows 1 of 4 (25%). The fix needs a removal timestamp. |
| D5 | A reinstated member (status back to active, `joined_at` unchanged) is eligible for sessions held while they were removed. | not specified | same dilution as D4; there is no reinstate RPC today, only SQL. |
| D6 | Community session totals count every real record (removed members, walk-ins who joined at the training); per-member figures count active members only. | "no per-member eligibility" for community | `total_attendances` can exceed the sum over the member list by exactly the records of removed members. |
| D7 | Windows are N x 24 h back from now (both ends inclusive); weeks start on Monday; "all" buckets start at the first session. | "7, 30, 90 days, all time" | A 7-day window opened Monday 10:00 starts the previous Monday 10:00. |
| D8 | Average RSVP participation includes sessions never marked; "most attended" can list a 0-present session (the app hides those). | "average RSVP participation" | A never-marked session leaves the attendee average alone (excluded) but counts in the RSVP average. |
| D9 | Organizers are members for every statistic (summary list, active members, rates). | "active members" | Olga: 0%, 4 not recorded. |

### Evidence map (spec -> tests)

| Requirement | Evidence |
|---|---|
| Attendance rate, eligible set, one decimal half up | `qa-stats-reference.test.ts` (30 pinned seasons x 4 windows x every member); `qa-stats-attack.test.ts` rounding grid (n <= d <= 160, averages to 500 over 60); `qa-stats-scenario.test.ts`; developer `stats.test.ts` |
| RSVP reliability and its deviation | reference test; attack "SPEC LITERAL vs DEFINITIONS"; scenario (Cora) |
| Missing data, never fabricate, Not recorded vs absent | reference (never-marked sheets, missing records, deleted records); attack D2/D3 tests; `qa-stats-app.test.ts` labels |
| Cancelled sessions | reference (cancelled kinds with RSVPs and records); scenario (Run 5); developer `stats-mutation.test.ts` |
| Historical membership eligibility, late joins, removals | reference (members join 0 to 350 days before the base, walk-ins before and after joining, removal in the mutation phase); attack D4/D5; `stats-buckets.test.ts` (join at the start instant) |
| Corrections and changed dates apply at once | reference second pass (corrections, deletions, moved sessions, zone change); scenario step test; attack "reads while attendance is being rewritten" |
| Zero denominators give null, never 0% or an error | reference (windows with no sessions, members with no eligible sessions); `qa-statistics.test.ts` formatters; developer `stats.test.ts` |
| Time zones, DST, month and week buckets | attack: every zone in `pg_timezone_names` 2020 to 2030, reference vs database for 9 zones 2025 to 2027; reference test (9 zones, sessions exactly on the 7/30/90-day boundaries) |
| Visibility: members see only themselves; organizers only their community | attack: private helpers, hostile input, leakage check, demotion; developer `stats-security.test.ts` |
| Pagination | attack: random tie structures, limits 1 to 7, pages vs the full list; 60 same-instant sessions; the reference test pages through every history |
| Lightweight charts, descriptions, accessibility text | `qa-stats-app.test.ts` (spoken summaries and axis labels from real payloads, no NaN/null text), `qa-statistics.test.ts` (scale, bars, caps at 24 buckets); device checks below |
| Performance | attack: 400 members x 500 sessions (200k pairs): community all 453 ms, summary all 371 ms, member 71 ms, history 79 ms (embedded Postgres on Windows) |

### What was run (M4-Q1)

Windows, embedded Postgres, 2026-11-16, one suite at a time:

- `npm test` -> `Test Files  84 passed (84)`, `Tests  1694 passed | 5 expected fail (1699)` (245 s). The 5 expected failures are Q5-1 to Q5-5; the earlier milestones have none left.
- `npm run typecheck` -> exit 0, no output.
- `npm run lint` -> exit 0, no output.
- `npx expo export --platform web` -> `Exported: dist`, exit 0.
- `npx expo-doctor` -> `20/20 checks passed. No issues detected!`
- Not run: Android bundle, a device, hosted Supabase, Deno.

### Test inventory (M4-Q1)

| File | Tests | Covers |
|---|---|---|
| `supabase/tests/qa-stats-reference.ts` | helper | independent reference: windows, eligibility, member / community / summary / history, calendar buckets in any zone, half-up rounding, seeded PRNG |
| `supabase/tests/qa-stats-world.ts` | helper | seeded random season builder and mutations (corrections, deletions, moves, removal, zone change) |
| `supabase/tests/qa-stats-reference.test.ts` | 4 | 30 pinned seasons and 6 live seasons through the public RPCs, harness sensitivity, coverage of the generator |
| `supabase/tests/qa-stats-attack.test.ts` | 26 | rounding grid; private helper privileges; hostile windows, limits, cursors, ids; demotion; leakage; cross-community keys; pagination fuzz; same-instant pile; zone-wide bucket contiguity; odd zones; consistent snapshot under a concurrent writer; non-blocking reads; spec-literal and decision tests D1 to D5; 200k-pair scale |
| `supabase/tests/qa-stats-app.test.ts` | 10 (4 expected fail) | payload types vs SQL keys; every screen string from real payloads; history flattening; Q5-1, Q5-2, Q5-4, Q5-5 (expected failures) |
| `supabase/tests/qa-stats-scenario.test.ts` | 6 | the manual script's SQL and every hand-computed number below |
| `src/features/statistics/domain/qa-statistics.test.ts` | 15 (1 expected fail) | chart scale and bars, periods across the year boundary, spoken summaries, formatting, filter store; Q5-3 (expected failure) |

### Not verifiable here

1. Anything on a device: Expo Go and a development build on Android, TalkBack reading of the chart images and cards, largest font scale, dark-theme contrast of the single-colour bars (non-text contrast of `colors.primary` on the card), touch-target sizes, the pull-to-refresh gesture, the sideways scroll of a long chart inside the vertical scroll view.
2. The React components themselves (the Node test environment cannot render React Native): layout, skeleton, empty and error states, the `useFocusEffect` refetch, Banner and Button behaviour were read, not run.
3. Hosted Supabase: PostgREST handling of the five `stable` functions, real clock skew between phone and database, the real invitation and finalization flow feeding the statistics (covered once by the developer's "real lifecycle" test, not on a phone).
4. Realtime-driven invalidation (`invalidateAttendanceUnlessPending` to statistics) is covered by the developer's unit test with a fake client, not against a live channel.
5. The notification clean-up of the scenario script on a hosted project (triggers, push outbox): verified on the embedded database only (no notification or delivery job remains); on a real project check Activity after running it.

### Manual test script additions (continue the numbering of the Milestone 3 script)

Setup: the hosted project from `docs/SUPABASE_SETUP.md`. A community named `Test Pack` with the organizer **Olga** and three members **Ana**, **Bogdan**, **Cora** (display names exactly like that; invite them the normal way, on phones or one after another on one phone). No trainings yet. Open the Supabase SQL editor.

67. Paste the script below into the SQL editor and run it (edit nothing if the names match). It creates four finalized trainings (Run 1 to Run 4, 20, 15, 10 and 6 days ago) and one cancelled for too few signed up (Run 5, 3 days ago), with RSVPs and attendance, then removes the "New training" notifications the inserts would create. Expected: no error; Activity shows no new notification; nobody gets a push. The same script is run by `qa-stats-scenario.test.ts`.

```sql
do $$
declare
  v_community uuid := (select id from public.communities where name = 'Test Pack');
  v_tz text;
  v_ana uuid; v_bogdan uuid; v_cora uuid;
  v_ids uuid[] := '{}';
  v_id uuid;
  r record;
begin
  select timezone into v_tz from public.communities where id = v_community;
  select p.id into v_ana from public.profiles p join public.memberships m on m.user_id = p.id
    where m.community_id = v_community and p.display_name = 'Ana';
  select p.id into v_bogdan from public.profiles p join public.memberships m on m.user_id = p.id
    where m.community_id = v_community and p.display_name = 'Bogdan';
  select p.id into v_cora from public.profiles p join public.memberships m on m.user_id = p.id
    where m.community_id = v_community and p.display_name = 'Cora';
  if v_community is null or v_ana is null or v_bogdan is null or v_cora is null then
    raise exception 'community or member names not found';
  end if;

  -- Five sessions: Run 1..4 finalized, Run 5 cancelled for too few signed up.
  for r in select * from (values
      (1, 'Run 1', 20, 'completed'), (2, 'Run 2', 15, 'completed'), (3, 'Run 3', 10, 'completed'),
      (4, 'Run 4', 6, 'completed'), (5, 'Run 5', 3, 'cancelled')
    ) as t(n, title, days_ago, kind)
  loop
    insert into public.training_sessions (
      community_id, title, starts_at, ends_at, rsvp_deadline, timezone, location_name,
      min_participants, status, cancel_reason, decided_at, cancelled_at, attendance_finalized_at)
    values (
      v_community, r.title,
      now() - r.days_ago * interval '1 day',
      now() - r.days_ago * interval '1 day' + interval '1 hour',
      now() - r.days_ago * interval '1 day' - interval '2 hours',
      v_tz, 'Park',
      case when r.kind = 'cancelled' then 3 else 2 end,
      r.kind::public.session_status,
      case when r.kind = 'cancelled' then 'insufficient_participation'::public.cancel_reason end,
      now() - r.days_ago * interval '1 day' - interval '2 hours',
      case when r.kind = 'cancelled' then now() - r.days_ago * interval '1 day' - interval '1 hour' end,
      case when r.kind = 'completed' then now() - r.days_ago * interval '1 day' + interval '2 hours' end)
    returning id into v_id;
    v_ids[r.n] := v_id;
  end loop;

  -- (session, member, RSVP, attendance). A null RSVP with 'present' is a walk-in.
  for r in select * from (values
      (1, 'A', 'going', 'present'),     (1, 'B', 'going', 'present'),   (1, 'C', 'going', 'present'),
      (2, 'A', 'going', 'present'),     (2, 'B', 'going', 'absent'),    (2, 'C', 'going', 'unrecorded'),
      (3, 'A', 'going', 'present'),     (3, 'B', 'not_going', null),    (3, 'C', 'going', 'present'),
      (4, 'A', 'going', 'absent'),      (4, 'B', 'going', 'present'),   (4, 'C', null, 'present'),
      (5, 'A', 'going', null)
    ) as t(n, who, rsvp, att)
  loop
    if r.rsvp is not null then
      insert into public.training_rsvps (session_id, community_id, user_id, response)
      values (v_ids[r.n], v_community,
              case r.who when 'A' then v_ana when 'B' then v_bogdan else v_cora end,
              r.rsvp::public.rsvp_response);
    end if;
    if r.att is not null then
      insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going, is_walk_in)
      values (v_ids[r.n], v_community,
              case r.who when 'A' then v_ana when 'B' then v_bogdan else v_cora end,
              r.att::public.attendance_status, coalesce(r.rsvp = 'going', false), r.rsvp is null);
    end if;
  end loop;

  update public.training_sessions s
  set going_count = (select count(*) from public.training_rsvps x where x.session_id = s.id and x.response = 'going')
  where s.id = any(v_ids);

  -- The insert trigger announced the sessions as new trainings: remove those rows.
  delete from public.notifications where related_session_id = any(v_ids);
end $$;
```

What the script sets up (Run 1 to 4 finalized; "not recorded" = no mark):

| | Run 1 | Run 2 | Run 3 | Run 4 |
|---|---|---|---|---|
| Ana | going, present | going, present | going, present | going, **absent** |
| Bogdan | going, present | going, **absent** | said not going, no mark | going, present |
| Cora | going, present | going, **not recorded** | going, present | no RSVP, **walk-in present** |

Run 5 (3 days ago): cancelled, too few signed up (Ana was going).

68. **Ana**, Statistics tab, 30 days. Expect: Attendance rate **75%** ("3 of 4 trainings"); Not recorded **0**; Attended **3**; Confirmed RSVPs **4**; Missed **1**; RSVP reliability **75%** ("3 of 4 recorded going RSVPs"). No Walk-ins card. The monthly chart's captions add up to 3/4. History, newest first: Run 4 Absent, Run 3 Present, Run 2 Present, Run 1 Present; Run 5 is not listed.
69. **Bogdan**, 30 days. Expect: rate **50%** ("2 of 4 trainings"); Not recorded **1** ("Not an absence", see Q5-1); Attended **2**; Confirmed RSVPs **3**; Missed **1**; RSVP reliability **66.7%** ("2 of 3"). History: Run 4 Present, Run 3 "Said not going" with the neutral Not recorded chip, Run 2 Absent, Run 1 Present.
70. **Cora**, 30 days. Expect: rate **75%** ("3 of 4"); Not recorded **1**; Attended **3**; Confirmed RSVPs **3**; Missed **0**; Walk-ins **1**; RSVP reliability **100%** ("2 of 2"). History: Run 4 Present with "Walk-in", Run 3 Present, Run 2 Not recorded (neutral chip, not styled as a miss), Run 1 Present.
71. **Olga** (organizer), Statistics tab: the Me / Community switch appears for her only (Ana, Bogdan and Cora have none). Me: rate **0%** ("0 of 4"), Not recorded **4**, RSVP reliability "—" with "No recorded going RSVPs yet".
72. Olga, Community, 30 days. Expect: Completed trainings **4**; Total attendances **8**; Average attendees per training **2** ("across 4 sessions"); Average RSVP participation **2.5**; RSVP to attendance **77.8%** ("7 of 9 recorded going RSVPs"); Active members **4** ("3 attended in this period"); Cancelled, too few signed up **1** ("0 cancelled by an organizer"). Attendance trend: weekly bars whose values add up to 8 attendees over 4 sessions (each caption shows its sessions). Most attended: Run 1 (3 present), Run 4 (2), Run 3 (2), Run 2 (1), in that order.
73. Olga, Members list (30 days): Ana 75%, Bogdan 50%, Cora 75%, Olga 0% ("4 not recorded"), ordered by name. Tap Bogdan: his screen shows the numbers of step 69 and a Back button; the time filter is kept. With TalkBack the row reads "Bogdan, 2 of 4 trainings, 50 percent, 1 not recorded".
74. Olga, 7 days: Community shows Completed trainings **1**, Total attendances **2**, Average attendees **2**, Average RSVP participation **2**, RSVP to attendance **50%** ("1 of 2"), Cancelled, too few signed up **1**. Ana on 7 days: rate **0%** ("0 of 1 training", "based on 1 training"), Missed 1. Cora on 7 days: rate 100% "based on 1 training", RSVP reliability "—". 90 days and All time show the same totals as 30 days; the monthly chart lists every month between Run 1 and now.
75. **Live correction**: in the SQL editor run
    ```sql
    update public.attendance_records set status = 'present'
    where session_id = (select id from public.training_sessions where title = 'Run 2' and community_id = (select id from public.communities where name = 'Test Pack'))
      and user_id = (select id from public.profiles where display_name = 'Bogdan');
    ```
    Pull to refresh (or reopen the tab) on Bogdan's phone: rate **75%** ("3 of 4"), Missed **0**, RSVP reliability **100%**. Olga, Community: Total attendances **9**, Average attendees **2.3** (9 / 4 = 2.25 rounds half up), RSVP to attendance **88.9%** ("8 of 9"). Undo it with the same statement and `'absent'`, refresh: back to steps 69 and 72.
76. **Moved session**: run
    ```sql
    update public.training_sessions
    set starts_at = starts_at - interval '30 days', ends_at = ends_at - interval '30 days', rsvp_deadline = rsvp_deadline - interval '30 days'
    where title = 'Run 4' and community_id = (select id from public.communities where name = 'Test Pack');
    ```
    Refresh. 30 days: Ana **100%** ("3 of 3"), Missed 0; Olga, Community: Completed trainings **3**, Total attendances **6**, Average attendees **2**, Average RSVP participation **2.7**. 90 days: Completed trainings **4** again and the trend is monthly. Move it back by running the statement with `+ interval`.
77. Empty and small-sample states: a member who joined after Run 4 (invite a fifth person) opens Statistics: the "No finalized trainings" card with its explanation, dashes, no "0%", no error; History says "No finalized trainings in this period yet."
78. Time zone: set the phone to a zone far from the community's (for example UTC+13) and reopen: month and week labels and training times do not shift (they follow the community's zone).
79. Airplane mode: pull to refresh on Statistics: the last numbers stay with a "Try again" banner; with nothing cached an error state with Retry appears; back online, Retry loads the numbers. Switching the filter while offline shows the error for that filter only.
80. TalkBack on Statistics: each stat card is read as one sentence (label, value, detail, help); each chart is one image whose description lists the buckets ("Monthly attendance rate. October 2026: 66.7 percent, 2 of 3 trainings. ..."); history rows read "<title>, <date and RSVP>, <outcome>". Largest font: nothing clipped, cards stack, the chart scrolls sideways. Dark theme: bars, outcome chips and the neutral Not recorded chip stay readable; the outcome is never only a colour (the word is always there).
81. Expo Go on Android: the Statistics tab and a member's screen open without a red error; the filter and charts work.
82. Pagination (optional, needs more rows): add 25 more finalized sessions for Ana following the script's pattern and open History: 20 rows, "Load more", then the rest; no row twice, newest first.
83. Cleanup: `delete from public.training_sessions where community_id = (select id from public.communities where name = 'Test Pack') and title like 'Run %';` (RSVPs and attendance cascade) before using the community for real trainings.


---

## Community creation, switching and invitation message (C1/C2) (C-Q1)

Scope: `supabase/migrations/20261119000100_creator_codes.sql`; `src/features/communities/`, `src/features/community/` (active community), the onboarding and `(app)/add-community/*` routes, `community-settings`, the Home switcher, the Profile entries, `useNotificationLinks`; `src/features/invitations/domain/invitationMessage.ts`, `src/lib/appLink.ts`, `InvitationCodeActions.tsx`. Reviewed against the owner's product rules and the C1 section of `docs/API_CONTRACT.md`, not against the developers' summaries.

### Verdict

**The authorization model and the creation flow hold; ten defects are open, none critical or high.** Nobody without a platform-issued code can create a community, an invitation code can never create one or make anybody organizer, a creator code can never join an existing community or change a role, and `update_community` follows the membership of the community it acts on, for a user who is organizer of A, member of B and removed from C (`qa-community.test.ts`). The five-community limit, the shared 5-failure limiter and the request id replay held under every attack and under parallel storms (`qa-community-concurrency.test.ts`: no deadlock, no torn row, exactly one community per request id). The generator is unbiased (chi-square over 30,000 codes, every position).

Open defects, all documented as `it.fails` tests so `main` stays green and each turns red when fixed (remove `.fails` then):

- **One medium on the server (Q6-1):** display names accept invisible-only text, control characters and a right-to-left override. Display names are global, so one spoofed name shows in every community the user belongs to.
- **One medium in the app by reading (Q6-9):** a notification tap for another community can leave the tap undelivered (and deliver it later at an unrelated moment), or leave notification navigation dead for the rest of the session. Not executable here (needs the React hook on a device).
- **Eight low:** the server's invisible-character list is incomplete for community names (Q6-2); a deleted account's still-valid token gets a raw foreign-key error (Q6-3); the invitation message turns zero-width joiners into spaces and breaks emoji and Persian names (Q6-4); "works until <date>" overstates by up to a day (Q6-5); the message tells existing users to tap a button they do not have (Q6-6); `EXPO_PUBLIC_APP_DOWNLOAD_URL` is returned raw, not normalized (Q6-7); the client zone rule is looser than the server's (Q6-8); the training screen shows organizer controls by the active community instead of the training's (Q6-10).

### Defects

| Id | Sev | Where | Summary | Owner |
|---|---|---|---|---|
| Q6-1 | medium | `20261114000200_invitations_and_onboarding.sql:45-56` (`clean_display_name`), used at `20261119000100_creator_codes.sql:290` and by `redeem_invitation` | Display name: no control / bidi / invisible handling. | backend |
| Q6-2 | low | `20261116000100_m3_qa_fixes.sql:53-61` (`clean_required_text`) | Hand-made invisible list misses U+061C, U+E0100 and others. | backend |
| Q6-3 | low | `20261119000100_creator_codes.sql:214, 310, 318` | A valid token of a deleted user gets a raw `23503` with table and constraint names. | backend |
| Q6-4 | low | `invitationMessage.ts:13-19` | `U+200B..U+200F` replaced by a space: ZWJ and ZWNJ destroyed. | mobile |
| Q6-5 | low | `invitationMessage.ts:43-48, 67` | The expiry line gives a date; the code stops at a time of day. | mobile |
| Q6-6 | low | `invitationMessage.ts:72` | Step 2 names "Join a community"; signed in, it is "Join another community" under Profile. | mobile |
| Q6-7 | low | `src/lib/appLink.ts:9-16` | Validates with `new URL` but returns the raw string; credentials and hidden characters pass. | mobile |
| Q6-8 | low | `communityForm.ts:34-35` | Zone names are accepted case-insensitively on the client, the server wants exact names. | mobile |
| Q6-9 | medium (by reading) | `useNotificationLinks.ts:52-66, 93-99` | The tap queue is switched off by hand and switched on only by a state change that may never come. | mobile |
| Q6-10 | low | `src/app/(app)/trainings/[id].tsx:148, 203, 288` | Organizer controls follow the active community, not the training's. | mobile |

**Q6-1 — display name is a spoofing channel.**
Reproduction: `qa-community.test.ts`, "DEFECT Q6-1" (four tests). `private.clean_display_name(E'​​')` returns the two characters; the same for two U+3164, two U+2800; `'Olga' || U+202E || ' (organizer)'` keeps the override; `'Ana' || U+0007 || U+0008 || 'Runner'` keeps the controls. Probed against the real function: 6,079 of the 6,085 probed whitespace, format, control and default-ignorable code points are accepted as a display name (the community name rejects all but a few hundred, see Q6-2).
Expected: the same rule as the community name (the contract says "as `redeem_invitation`", and `redeem_invitation` has had this gap since M1): strip control and bidi characters, reject invisible-only. Actual: the name is stored and shown in participant lists, attendance sheets and statistics of every community the user is in. An RLO inside a name reorders the text after it (for example making a member appear as "Olga (organizer)"); an invisible-only name is a blank row.
Suggested fix: call `private.clean_required_text(p_display_name, 'display_name', 40, false)` inside `clean_display_name` (keep the 2 to 40 length and map its exception to `null`). Also a one-off `update` for existing profiles.
Note: on the hosted database (locale `en_US.UTF-8`, not the embedded `C`) `\s` also matches NBSP, so `NBSP NBSP` is rejected there and accepted here; the invisible-only cases above are accepted in both.

**Q6-2 — the invisible list is not complete.**
Reproduction: `qa-community.test.ts`, "DEFECT Q6-2" (three tests): names made only of U+061C (Arabic letter mark), U+E0100 (variation selector supplement) or U+1D173/U+1D174 (musical format controls) are accepted. A probe over every Unicode format, space, default-ignorable and control code point found these further accepted non-combining ones: U+0600-0605, U+06DD, U+070F, U+0890-0891, U+08E2, U+2065, U+FFF0-FFFB, U+110BD, U+110CD, U+13430-1343F, U+1BCA0-1BCA3, U+E0080-E00FF and U+E01F0-E0FFF. Some of these draw a sign (U+0600 series), the others draw nothing.
Expected: `validation_failed:name`. Actual: a community with a name that is blank for everybody. Same list is used for announcement titles.
Suggested fix: replace the hand-made class by a test of "has no letter, number, punctuation, symbol or mark" (`[^[:alnum:][:punct:]]` is locale dependent; use an explicit allow-list check on the cleaned text, or add the ranges above).

**Q6-3 — a token of a deleted user.**
Reproduction: `qa-community.test.ts`, "DEFECT Q6-3". A JWT whose `sub` has no `auth.users` row (possible on a hosted project until the token expires) calls `preview_creator_code` or `create_community_with_code`. Expected: `{ok:false, error:'not_authenticated'}`. Actual: the raw `23503` ("insert or update on table "invitation_attempts" violates foreign key constraint "invitation_attempts_user_id_fkey""). Nothing is left behind (the last test of that group proves the rollback). The app maps it to the generic error, so the user sees nothing odd; the leak is the table and constraint names. `redeem_invitation` has the same behaviour since M1.
Suggested fix: in the three functions, `if not exists (select 1 from auth.users where id = v_uid) then return not_authenticated`.

**Q6-4 — zero-width joiners are destroyed in the message.**
Reproduction: `qa-invitationMessage.test.ts`, "DEFECT Q6-4" (three tests). `sanitizeCommunityName('Run <man ZWJ woman ZWJ girl> Club')` returns the three emoji separated by spaces; a Persian word with ZWNJ is split by a space; a ZWSP inside "Fitness" becomes a visible space. The range `U+200B..U+200F` includes ZWJ (U+200D) and ZWNJ (U+200C), which the server keeps on purpose (`clean_required_text`).
Suggested fix: remove only U+200B, U+200E, U+200F and the bidi ranges, keep U+200C and U+200D, and replace removed characters by nothing, not by a space.

**Q6-5 — "works until 20 Nov 2026".**
Reproduction: `qa-invitationMessage.test.ts`, "DEFECT Q6-5". The app creates codes that expire 24 hours, 7 or 30 days after creation, i.e. at that time of day. The line gives only the date (computed correctly in the community zone, 56 zone and instant pairs checked against Postgres in `qa-community-app.test.ts`), so a recipient who opens the message that afternoon is refused with "expired". Suggested fix: add the time ("until 20 Nov 2026, 11:00") or say "for 7 days".

**Q6-6 — wording for someone who already has the app.**
Reproduction: `qa-invitationMessage.test.ts`, "DEFECT Q6-6". The owner's scenario includes inviting a second community to an existing user; the message says tap "Join a community". Signed in there is no such button: Profile has "Join another community" (and the Home switcher "Join another community"). Suggested fix: one extra sentence, "Already use TrainHive? Profile, then Join another community."

**Q6-7 — the download link is validated but not normalized.**
Reproduction: `qa-invitationMessage.test.ts`, "DEFECT Q6-7". `parseAppDownloadUrl` checks with `new URL` and returns the input string: `http:example.com` and `https:/example.com` are shared as written, NEL, bidi and zero-width characters inside the link go into the message, and `https://user:secret@host/app` publishes its credentials. The value comes from a build variable, so only the owner can hit this. Suggested fix: return `url.href`, refuse `username`/`password`, and refuse any control, bidi or format character.
The accepted and rejected forms that are right today are pinned (javascript, data, file, blob, intent, market, whitespace, empty, 5 KB link).

**Q6-8 — the client zone rule is not the server's.**
Reproduction: `qa-communities.test.ts`, "DEFECT Q6-8". `isCommunityTimeZone('europe/bucharest')` is true (the `Intl` constructor ignores case); the server answers `validation_failed:timezone`. Unreachable through the picker (it lists canonical names). Suggested fix: add `/^[A-Z]/` to the client pattern and compare against the runtime's canonical spelling.

**Q6-9 — a notification of another community may never navigate (by reading).**
`useNotificationLinks.ts:93-99`: the tap handler calls `queue.setReady(false)`, `setSwitchingTo(target)`, `select(target)`, then offers the tap. Readiness is restored only by the effect at `:63-66`, which depends on `ready`. When the target's detail query is already cached (the user was in that community earlier in the session, within the 5-minute cache), the new render has `community.id === switchingTo` at once, so `ready` stays `true` from the old render to the new one, the effect does not run, and the tap stays queued: it is delivered by the next unrelated `false -> true` change, possibly minutes later and on top of whatever the user is doing. Second case, `:53`: if the target disappears from the list before it becomes active (removed in the meantime), `community.id` never equals `switchingTo`, `ready` stays `false` for the rest of the session and no later notification navigates.
Evidence: `qa-communitySwitchLinks.test.ts` shows the queue half (a tap held after `setReady(false)` waits for an explicit `setReady(true)` and later taps replace it); the hook itself cannot be rendered in the Node test environment. Suggested fix: derive readiness without the manual `setReady(false)` (it is already false while `switchingTo !== community.id`), call `queue.setReady(ready)` from the same effect after `setSwitchingTo`, and clear `switchingTo` when the target is no longer in `communities`.

**Q6-10 — organizer controls by the wrong community.**
`trainings/[id].tsx:148, 203, 288` read `isOrganizer` of the ACTIVE community. A training of another community can be on screen: a notification tap whose community lookup failed or carried no notification id, a training screen still in the stack when a notification switched communities, a hand-built link. Organizer of A and member of B opening B's training sees "Record attendance" and Edit / Cancel (the server answers `forbidden`); organizer of B and member of A opening B's training sees none. Source check: `qa-communitySwitchLinks.test.ts`, "DEFECT Q6-10". Fix: `session.community_id === community?.id && isOrganizer` (or a membership lookup by the session's community).

### Observations (no defect filed)

- **O1 Guess budget.** The limiter is per account: five wrong codes per 15 minutes, and a fresh anonymous account starts with a clean count (`qa-community.test.ts`: six accounts, 30 guesses, all answered; the sixth guess of each is refused, and a limited account cannot confirm even the real code). There is no per-device or per-network limit in the database. Code space: 30 symbols, 8 characters, 6.6e11 codes (39 bits). Even a million guesses a day (about 200,000 accounts) hits one live code with probability about 1.5e-6 per day; the realistic limit is Supabase's anonymous sign-in rate limit and CAPTCHA (hosted settings, not verified). Failed-attempt rows are only pruned per user after a day, so a rotating attacker grows `invitation_attempts` without bound; a scheduled delete of rows older than a day would fix it.
- **O2 Replay semantics.** A repeated request id returns the first result and ignores every other argument, including invalid ones; a replay never changes the name, the display name or consumes a use; another user's request id is never a replay and the first user's result is never returned (pinned in `qa-community.test.ts`). A replay after the creator lost the membership names that community anyway (the app then falls back to another community through the list).
- **O3 Five-community limit.** Counted from creator redemptions: leaving, removal and demotion do not free a slot; only the platform owner deleting a community does (the redemption cascades). Concurrent attempts stop exactly at 5 (developer test) and a refused attempt costs the code nothing.
- **O4 Display name is global** (decision D1): creating or joining a second community renames the user for the members of the first (`qa-community.test.ts`, last describe).
- **O5 Look-alike names.** Community names are not unique: anyone with a creator code can name a community "Beta Pack" like an existing one. Separate communities, so harmless to B's data; confusing in an invitation message (name only).
- **O6 Settings sends both fields.** `update_community` takes name and zone together and has no version check, so an organizer who only renames, from a form opened before another organizer changed the zone, writes the old zone back. Same family as Q2-11.
- **O7 Home title.** `CommunitySwitcher.tsx:19` shows "Home" while the detail query of a community that was not cached loads (the name is known from the list); organizer-only sections also flicker to the member view for that moment.
- **O8 Profile "Your communities"** lists no community, only the two entries to add one; with several communities the switcher exists only on Home. Consider listing them there.
- **O9 Silent switch after removal.** Removed from the active community (realtime or refetch), the app moves to the next community without telling the user.
- **O10 Announcements of the other communities.** The announcement channel follows the active community only; push notifications for the others still arrive (user-wide channel), and the catch-up refetch on every (re)subscription covers the gap on switching.
- **O11 Accessibility.** After "Copy message" the app both sets a polite live region and calls `announceForAccessibility` (`InvitationCodeActions.tsx`), which TalkBack on Android may read twice. The switcher rows carry "current community" in the label rather than a selected state; the sheet uses `accessibilityViewIsModal` (iOS only), which is harmless because an Android `Modal` is its own window.
- **O12 Hosted locale.** The embedded database uses locale `C`; regex classes (`\s`) and `btrim` behave differently under `en_US.UTF-8`. Every whitespace and invisible-character rule was tested here only; see Q6-1's note.
- **O13 Credentials in the SQL editor path.** The admin functions work as `postgres` (tested as the superuser of the embedded database, `created_by` null). On the hosted project the role is not a superuser; its grants were not exercised (cannot verify).

### Decisions needing the owner's confirmation

| # | Decision shipped | Question |
|---|---|---|
| D1 | One display name per person for every community. | Keep (simple), or allow a name per community later? Until then Q6-1 matters more, because one spoofed name is shown everywhere. |
| D2 | Community names are not unique. | Accept look-alike names (O5), or require unique names per creator? |
| D3 | Every member sees "Create a community" (Profile, switcher) and learns that creator codes exist. | Keep visible for everyone, or show it only after a code has been entered somewhere? |
| D4 | The message promises "works until <date>". | Show the time (Q6-5)? |
| D5 | Guess budget is per account (O1). | Add a per-day cap per code, or shorten the default 14 days? Risk is negligible at 39 bits; this is a policy choice. |

### Evidence map

| Requirement | Evidence |
|---|---|
| Nobody creates a community without a platform-issued creator code | `creator-codes.test.ts`; `qa-community.test.ts` (table writes denied to user, anon and service_role; admin functions closed; minting attempts by a user, organizer and anon; privilege matrix incl. PUBLIC) |
| An invitation code never creates a community or an organizer; a creator code never joins | `qa-community.test.ts` "a creator code never joins an existing community ...", organizer invitation used as creator code in two spellings |
| Organizers edit name and zone, only for their own community | `qa-community.test.ts` update_community matrix (member of B, removed from C, organizer of another community, outsider, anon, unknown id, demotion); `qa-community-concurrency.test.ts` (rename storm with trainings, joins, removals, statistics; open rename does not block joins; removal wins) |
| Several communities, switching | `creator-codes-multi-community.test.ts`; `qa-community-app.test.ts` (list vs table read, parser, switcher view model, RSVP map cannot mix); `qa-communities.test.ts` (resolution, stored ids, gate matrix); cache keys: developer `activeCommunity.test.ts` |
| Request id semantics, limiter, limit | `qa-community.test.ts` (replay matrix, rotating accounts, success does not reset, window, limit bypasses); `qa-community-concurrency.test.ts` (parallel retries with different arguments, 10 accounts on a 2-use code, guess storm) |
| Validation | `qa-community.test.ts` (23 invisible characters alone, repeated and mixed; ZWJ, RTL, accents, 80 and 40 code point edges, zone matrix of 37 names, 1 MB inputs); `qa-community-app.test.ts` (every real server answer mapped to a friendly place; client vs server on invisible names; picker zones against the server's list and pattern) |
| Invitation message | `qa-invitationMessage.test.ts` (2000 random names keep four lines, 9 wording combinations x 2 link states, 11 zone / DST cases, extreme dates, link forms); `qa-community-app.test.ts` (dates computed by Postgres for 56 instant / zone pairs; message from a real row) |
| Hostile notification payload | `qa-communitySwitchLinks.test.ts` (about 40 classic attacks, 3000 random payloads, prototype tricks; switching only to communities of the user is in `qa-communities.test.ts`) |

### What was run (C-Q1)

Windows, embedded Postgres, 2026-11-16, one suite at a time:

- `npm test` -> `Test Files  99 passed (99)`, `Tests  1923 passed | 17 expected fail (1940)` (314 s). The 17 expected failures are the Q6 defects above (9 + 1 + 6 + 1); earlier milestones have none left.
- `npm run typecheck` -> exit 0, no output.
- `npm run lint` -> exit 0.
- `npx expo export --platform web` -> `Exported: dist`, exit 0 (the metro cache was not corrupt).
- `npx expo-doctor` -> `20/20 checks passed. No issues detected!`
- Not run: Android bundle, a device, hosted Supabase, Deno. Each new suite was also run alone first (qa-community 27 s, concurrency 10 s, app 13 s).

### Test inventory (C-Q1)

| File | Tests | Covers |
|---|---|---|
| `supabase/tests/qa-community.test.ts` | 37 (9 expected fail) | authorization matrix, privileges, replay semantics, limiter, generator, limit, validation fuzz, global display name, ghost token |
| `supabase/tests/qa-community-concurrency.test.ts` | 8 | rename storm, lock behaviour, parallel retries and races |
| `supabase/tests/qa-community-app.test.ts` | 8 | app logic against real answers: errors, zones, message dates, list, RSVP map |
| `src/features/communities/domain/qa-communities.test.ts` | 25 (1 expected fail) | request id tracker, form rules, zones, search, switcher, resolution, gate matrix |
| `src/features/invitations/domain/qa-invitationMessage.test.ts` | 26 (6 expected fail) | message shape fuzz, wording, dates, name sanitizing, link validation |
| `src/features/notifications/domain/qa-communitySwitchLinks.test.ts` | 8 (1 expected fail) | hostile payloads, queue mechanism, organizer-rights source check |

### Not verifiable here

1. Anything on a device: Expo Go on Android, the Modal sheets (switcher, zone picker) and their focus and back-button behaviour, TalkBack reading of the switcher rows and the copy confirmation, largest font, dark theme, `Share.share`, `expo-clipboard` on Android 13+ (which shows its own toast).
2. The React hooks and screens (the Node environment cannot render React Native): the gate, `useNotificationLinks` (Q6-9), the double-submit guard, the keyboard handling of the create form.
3. Hermes: `Intl.supportedValuesOf`, `Intl.DateTimeFormat` with `hourCycle`, the `URL` polyfill, and its zone list (the tests use Node's ICU); whether Hermes lists `Asia/Kolkata` or `Asia/Calcutta`.
4. The hosted database: the `en_US.UTF-8` locale (Q6-1 note, O12), the older tzdata (the app's list may name zones the hosted Postgres does not know yet), grants of the `postgres` role, PostgREST's rendering of the new functions, the real size of Supabase's anonymous sign-in rate limit.
5. EAS builds: that `EXPO_PUBLIC_APP_DOWNLOAD_URL` is set in the build profile (it is in `.env.example` only; not mentioned in the setup guide).
6. Push: the real payload of a notification of another community.

### Manual test script additions (continue the numbering of the Milestone 4 script)

Setup: the hosted project (migrations through `20261119000100` pushed). Two phones or one phone and the Expo Go account switcher: **Olga** (will create a community), **Bogdan** (a second user). A third user **Cora** has only an invitation code. Open the Supabase SQL editor as the project owner.

84. SQL editor: `select public.admin_create_creator_code('for Olga', 14, 1);`. Expect one row with an 8-character `code`, `expires_at` 14 days ahead, `max_uses` 1. Run it again with `-1` as the days: expect the error `validation_failed:expires_in_days`. Check that a user cannot do it: the app has no such button; `select * from public.community_creator_codes;` works only here.
85. **Olga**, fresh install (or cleared data): Welcome screen. Expect "Join a community" and the smaller "Create a community" with the line about creator codes.
86. Olga: Create a community, type the code in lower case with a dash in the middle and a space, tap Check code. Expect "This creator code is valid." and Continue. Try a wrong code first: the field shows "That creator code is not valid"; after five wrong codes in a row the banner says to wait 15 minutes (the next valid code is refused too).
87. Olga: Continue. Expect the name field, the time zone card (your zone preselected with the local time shown), and "What should your pack call you?". Leave the name empty and tap Create: the field message appears. Type a name of 90 characters: the message about 80 characters. Open the time zone card, search "buch", pick Bucharest; the card shows "Right now it is HH:MM (UTC+02:00 or +03:00) there" and the time matches a clock in Bucharest. Search "zzzz": the empty state.
88. Olga: Create community. Expect the button busy, then Home with the new community name as the title (plain text, no chevron), empty trainings, and Profile with Community settings and Invitations. In the SQL editor: the code now shows `use_count` 1; one communities row, one organizer membership.
89. Olga: airplane mode, fill the form again with another code (issue a new one), tap Create. Expect the banner with "Tap Create community again to retry: it will not create a duplicate". Turn the network on, tap Create again without touching the fields: one community only (check the table), Home opens. Repeat, but edit the name before the retry: a second community is made (this is by design, a new submission).
90. Olga: Profile, Community settings: change the name to one with an emoji and the zone to another one; Save. Expect "Saved."; Home title and Profile show the new values. In the SQL editor change nothing; check the trainings created earlier keep their own zone. Statistics (as organizer) now bucket by the new zone.
91. Bogdan: install, Welcome, Create a community, use a creator code that was already used: "This creator code has already been used." with "Use another code". Revoke a fresh code in the SQL editor (`select public.admin_revoke_creator_code('<code>');`), then use it: "no longer active". A member of Olga's community (Cora) tries "Create a community" without any code: there is nothing to type, so she cannot continue; typing an invitation code of Olga's community in the creator field gives "not valid".
92. Olga: Invitations, create a code (7 days, 3 uses). Expect Copy message, Share and Copy code only. Tap Copy message and paste into a notes app: four lines, her community name, `ABCD-EFGH`, the expiry date and "works for up to 3 people", and the download link when `EXPO_PUBLIC_APP_DOWNLOAD_URL` was set in the build (otherwise "Ask me where to get the app"). Tap Share: the system share sheet opens with the same text; cancel it: no error banner. Note Q6-5 and Q6-6 while reading it.
93. Bogdan (new install): Join a community, enter the code, pick a name, join. Then Olga makes a **second** community the same way (new creator code) and invites Bogdan to it: Bogdan, Profile, Join another community, enters the code: the screen offers "Join as <his name>" (the name is shared across communities) and Use a different name. Join.
94. Bogdan: Home. Expect the community name with a chevron. Tap it: a sheet "Your communities" lists both with role and the local time of each zone, the current one checked. Pick the other: Home, Trainings, Activity, Statistics and Profile all show the other community's data at once, and nothing of the first. Kill the app and reopen: the last choice is remembered. Sign in on a second device is not possible (anonymous accounts), so the "two accounts on one device" case is covered by the unit tests only.
95. Olga creates a training in each community; Bogdan answers going in one and not going in the other. Switch back and forth: each list shows only its own trainings and his own answers (no answer carried over). Olga removes Bogdan from the second community in the SQL editor (`update public.memberships set status='removed' ...`): on his phone, after pull to refresh or a minute, the switcher disappears and he is in the first community without a message (O9).
96. Notification across communities: community 1 active on Bogdan's phone; Olga posts an announcement in community 2 (he is a member again). Tap the notification: the app switches to community 2 and opens the announcement. Do it twice in a row after having visited community 2 earlier in the same session (Q6-9: the second tap may do nothing). Then force-close the app and tap a notification of the other community from the lock screen.
97. Display names (Q6-1): in the create form or the join screen enter a name made of two zero-width spaces (paste U+200B twice) or one containing a right-to-left override. Expected after the fix: refused or cleaned. Today: accepted and shown in participant lists.
98. Expo Go on Android: steps 85 to 96 produce no red screen; the zone picker opens and closes with the back button; the switcher sheet closes with the back button and with a tap outside; TalkBack reads each switcher row as "name, role, zone and time, current community".
99. Cleanup: `delete from public.communities where name in (...)` for the test communities, and `update public.community_creator_codes set revoked_at = now() where revoked_at is null;` for unused codes.

---

## Resolution status of C-Q1 defects (lead, 2026-11-16)

Fixed and verified by tests (full suite: 103 files, 2003 tests, all passing; typecheck and lint clean): Q6-1, Q6-2, Q6-3 (backend, `20261120000100_c_qa_fixes.sql`); Q6-4, Q6-5, Q6-6, Q6-7, Q6-8, Q6-9, Q6-10 (mobile). Also fixed: the attendance screen's organizer flag (same flaw class as Q6-10), the community-settings lost-update problem (`update_community` takes `p_expected_updated_at`; the app sends it and handles `stale_data`), the push payload now carries `communityId`, failed-attempt rows are purged daily.

Owner decisions applied: D1 one global display name (kept; app tells users), D2 community names need not be unique, D3 "Create a community" stays visible (creator codes gate it), D4 the invitation message shows the expiry time, D5 daily cleanup of failed attempts, no per-code cap.

Still unverified (needs a hosted Supabase project, an Android device, Expo/Firebase): everything listed under each section's "cannot be verified" list, notably Realtime, pg_cron/pg_net scheduling, push delivery, rendering of the new screens, and Hermes behaviour of `Intl.supportedValuesOf`.

---

## GDPR (G1 + G2) (Q7)

Scope: `20261123000100_consents.sql`, `20261124000100_member_roles.sql`, `20261124000200_data_rights.sql`; `src/features/legal/**`, `src/features/dataRights/**`, `src/features/members/**`, sign-out (`src/features/profile/domain/signOut.ts`); the texts in `content/privacy.ts` and `content/terms.ts`. Reviewed against `docs/GDPR_PLAN.md` and the contract, not the developers' summaries. This is a technical review, not legal advice.

### Verdict

**The mechanisms hold; the texts and a few edges do not yet match them. Ten defects are open (4 medium, 6 low), none critical.** What was attacked and held: the ledger is append-only against every API role and the table owner (only owner/superuser `TRUNCATE` and `session_replication_role = replica` bypass it, confirmed); a client cannot forge consent for another user or a stale version; bumping either legal document re-gates joins while optional consents stay; the join gate sits on both join RPCs and consumes nothing; deletion leaves no reference to the user in `public`, `private` or `auth`; the last-organizer rule survives concurrency; a generated sweep of every function `authenticated` can execute (not a hand-written list) returns nothing, writes nothing and raises no raw constraint error for a deleted account's still-valid token, and shows no community data to a removed member (the sweep is shown non-blind by running it as an active organizer). The weak points: (1) push consent is not enforced where pushes are sent, (2) the notice promises things the system does not do (re-invitation, token deletion, groups of 5+, "Former member", features not built), (3) the blocking "updated terms" screen leaves no export/delete path, (4) small retention gaps. Defects are `it.fails` tests so `main` stays green; each turns red when fixed (remove `.fails`).

### Defects

| Id | Sev | Where | Summary | Owner |
|---|---|---|---|---|
| Q7-1 | medium | `20261116000100_m3_qa_fixes.sql` (`claim_notification_jobs`, CTE `with_tokens`, about l.378-386) | Dispatcher hands out tokens without checking push consent. | backend |
| Q7-2 | low | `20261123000100_consents.sql:358-361` (`withdraw_consent`) | Withdrawing push consent is a no-op (tokens stay) when no grant event exists. | backend |
| Q7-3 | low | `20261124000200_data_rights.sql:308-314, 350-352` | `private.data_export_log` is pruned only by the same user's next export; the README promises "at most a day". | backend |
| Q7-4 | low | `20261115000400_notifications_rpcs.sql:1229` and the purge functions | Invalidated push tokens are never deleted; notice: deleted "when the token stops working". | backend (or text) |
| Q7-5 | medium | `20261114000200_invitations_and_onboarding.sql:190`; `terms.ts` "Ending your use" | Terms: a removed member "needs an organizer to invite them again"; every code is refused (`invalid_code`) and no reinstate function exists. | backend / lead |
| Q7-6 | low | `20261124000200_data_rights.sql` `erase_user` step 4 | The organizer's free-text `reason` stays on the anonymized audit row and may contain the person's name. | backend |
| Q7-7 | medium | `privacy.ts` ("what we collect", "who can see") | Notice describes birth year, gender, emergency contact, T-shirt size, workout logs, replies and a "groups of 5 or more" rule; none exists in schema or code (Privacy settings shows switches for them). | lead / mobile |
| Q7-8 | low | `deliverExport.ts:19-26`; `signOut.ts`, `useDeleteAccount.ts` | The downloaded JSON stays in the cache after sign out and after account deletion. | mobile |
| Q7-9 | low | `privacy.ts` rights list | "announcements you wrote ... show 'Former member' as the author": no announcement screen shows an author. | lead / mobile |
| Q7-10 | medium | `TermsUpdateScreen.tsx:75-82` | The blocking screen for existing members offers only "accept"; to export or delete you must first accept the new terms. | mobile / lead |

**Q7-1.** Repro: `qa-gdpr-consent.test.ts` "DEFECT Q7-1". A member with a token registered before G1 (no consent event) receives an announcement; `claim_notification_jobs` returns the token. Expected: `tokens: []` unless `push_notifications` is current. Actual: pushes continue for everybody who registered before G1 (the contract already lists this as an open question), so "Push messages need your consent" is untrue for them, and a withdrawal racing a claim still sends. Fix: add `private.has_consent(user_id, 'push_notifications')` to the `blocked_reason` ladder, and make the app ask existing members for push consent again.

**Q7-2.** Repro: "DEFECT Q7-2". `withdraw_consent('push_notifications')` returns `changed:false` and keeps the token while the Privacy switch shows off. Fix: for that purpose always delete the caller's tokens.

**Q7-3.** Repro: "DEFECT Q7-3": a 5-day-old row survives `purge_old_notification_data()`. Fix: delete rows older than a day there.

**Q7-4.** Repro: "DEFECT Q7-4": a token invalidated 60 days ago survives the purge. Fix: purge long-invalidated tokens, or reword the notice.

**Q7-5.** Repro: "DEFECT Q7-5": the organizer removes a member, creates a fresh code, the member redeems it: refused. Fix: let an organizer-created invitation reactivate a removed membership, or change the Terms to "cannot rejoin".

**Q7-6.** Repro: "DEFECT Q7-6": reason "Zed Zebra had the flu" survives deletion on a row with `user_id null`. The plan promised audit entries "without name or id". Fix: null `reason` when anonymizing (or document that reasons stay).

**Q7-7.** Repro: `qa-gdprCopy.test.ts` "DEFECT Q7-7". The notice (whose comment says "Only features that exist are described as available") already announces P3/P5 data, and the "5 or more" threshold is implemented nowhere. Expected: the text names only what exists, or P3/P5 ship the threshold with the data. Consent given today covers a purpose with no processing behind it.

**Q7-8.** Repro: "DEFECT Q7-8" (source check). `removeOldExports` runs only before the next export; after sign out or deletion the file with the member's whole history stays in the app cache on a shared device. Fix: call the same cleanup from `runLocalCleanup`.

**Q7-9.** Repro: "DEFECT Q7-9". Fix: show the author (with "Former member" for null) or drop the sentence.

**Q7-10.** Repro: "DEFECT Q7-10" (source check). Fix: put "Download my data" and "Delete my account" on the update screen (both RPCs work without current terms) so rights do not depend on accepting.

### Observations (no defect filed)

- **O1** Rolling a legal version back makes old acceptances valid again (test). Fine for undoing a mistaken bump; never reuse a version string for different texts.
- **O2** `my_consents` for a deleted account's token returns a default document (needs acceptance, all false) instead of an error; no data. The app would show the terms gate for a ghost session until the token expires.
- **O3** The rate limit counts withdrawals too: 30 toggles in an hour block a re-grant (including re-accepting terms after a bump) for the rest of the hour.
- **O4** Authored announcements and organized events stay with their text and no author; the plan said "choose: delete". The notice is honest about it, but the body can hold personal data (test pins it); an erasure request may still require removal.
- **O5** Tiny community: the anonymous `present` row plus `former_members` in the attendance sheet identify the leaver to an organizer who knows who attended (test pins it). The notice says so.
- **O6** Sign-out unregisters the push token best-effort; if that fails the token stays on the server for an account nobody can reach (see Q7-4).
- **O7** Realtime: every published table keeps the default replica identity, so old values in delete/update payloads carry only the key (test).
- **O8** `ConsentGate` fails open offline; the server still refuses joins and push registration. Reasonable.
- **O9** Backups, Supabase logs (IP addresses, `auth.audit_log_entries`) and the processors' copies are outside the app; the notice says data is kept "until you delete" without mentioning backup lag.
- **O10** The web build bakes the controller details into the public bundle (intended). Scan with the values from the gitignored `.env.local`: 0 tracked files contain them; only the gitignored `dist` does.

### Claims in the texts versus the system

P = privacy.ts, T = terms.ts. yes = implemented and tested; partly; no.

| # | Claim | Impl. | Evidence | Action |
|---|---|---|---|---|
| 1 | Anonymous account, membership, role stored; contract basis (P) | yes | schema, RLS suites | none |
| 2 | Display name shared with the community (P) | yes | members screens | none |
| 3 | RSVPs, attendance, change history kept; objection "at any time" (P) | partly | audit log yes; objection only by e-mail | owner: e-mail process |
| 4 | "Posts and replies in announcements and event discussions" (P) | partly | announcements yes; no replies or discussions | Q7-7 |
| 5 | Push token, settings, in-app notifications; push needs consent (P) | partly | register gate yes; dispatcher does not check | Q7-1 |
| 6 | Birth year, gender (optional, consent) (P) | no | no schema or code | Q7-7 |
| 7 | Emergency contact, T-shirt size (optional) (P) | no | no schema or code | Q7-7 |
| 8 | Workout logs (optional) (P) | no | no schema or code | Q7-7 |
| 9 | No location, contacts, ad IDs, payments, children's data (P) | yes | no such code; age box is self-declared | none |
| 10 | Members see display name and "going" on event pages (P) | yes | RLS and rsvp suites | none |
| 11 | Organizers change roles and remove; members leave; removed lose access; history stays (P) | yes | `member-roles.test.ts`, `qa-gdpr-consent` removed-member tests, sweep | none |
| 12 | Organizers see membership, RSVPs, attendance (P) | yes | RLS suites | none |
| 13 | Emergency contact visible only with consent (P) | no | not built | Q7-7 |
| 14 | Birth year and gender only as groups of 5+ (P) | no | no threshold anywhere | Q7-7 |
| 15 | Workout logs private; only group totals (P) | no | not built | Q7-7 |
| 16 | We do not sell or share for advertising (P) | yes | no such code | none |
| 17 | Processors: Supabase, Expo, FCM, web host (P) | partly | list matches code; DPAs not in repo | owner |
| 18 | Notification texts never hold workout or emergency data (P) | partly | true today; no enforcement | test when P3/P5 land |
| 19 | Transfers outside the EEA rely on SCC/DPF (P) | n/a | contractual | owner / lawyer |
| 20 | Notifications deleted 90 d after read, 180 d unread (P) | partly | purge uses `created_at` (earlier than "after read", safe side); needs pg_cron hosted | reword; verify cron |
| 21 | Failed attempts deleted after 24 h (P) | yes | `purge_old_invitation_attempts`; tests | verify cron |
| 22 | Push tokens deleted on switch-off, when the token stops working, at deletion (P) | partly | switch-off (with a grant) and deletion yes; invalid tokens kept | Q7-2, Q7-4 |
| 23 | Account data kept until deletion; attendance stays anonymous (P) | yes | `account-deletion.test.ts` | none |
| 24 | Consent records kept while the account exists (P) | yes | ledger tests | none |
| 25 | Each optional consent has a switch; off is immediate (P) | partly | push yes; other three gate nothing yet | Q7-7 |
| 26 | Correct your name: Profile, Change name (P) | yes | `profile.tsx:97` | none |
| 27 | Download up to 10 per hour, "everything we hold" (P) | partly | limit yes; id-keyed scan finds no gap; free text on other people's rows not covered | none |
| 28 | Deletion list; attendance anonymous; "Former member" author (P) | partly | deletion yes; no author shown | Q7-9 |
| 29 | Leave a community: Profile, Leave this community (P) | yes | `LeaveCommunitySection` | none |
| 30 | We answer within a month (P) | n/a | process | owner |
| 31 | RLS on every data table (P) | yes | schema test | none |
| 32 | All changes through checked functions; no admin keys in the app (P) | yes | `no-unguarded-writes.test.ts`; no service key in `src` | none |
| 33 | Encrypted in transit (P) | yes (hosted) | HTTPS to Supabase | verify hosted |
| 34 | Attendance audit log; code-guess limiter (P) | yes | existing suites | none |
| 35 | Session in secure storage where available (P) | yes | `authStorage.ts` | none |
| 36 | Breach: authority and people notified (P) | no runbook | none | owner: `BREACH_RUNBOOK.md` (G3) |
| 37 | Under 16 not allowed; accounts deleted if found (P) | partly | self-declared box; no process | owner |
| 38 | Account created on the device "the first time you join" (P) | partly | created at the first code submit, also a wrong code | wording |
| 39 | No analytics, advertising or tracking tools (P) | yes | no SDK in `package.json` (test) | re-check per dependency |
| 40 | Web: local storage only, no tracking cookies (P) | yes | `authStorage.ts` | none |
| 41 | New versions shown and confirmed before joining (P, T) | yes | gate tests | none |
| 42 | Must be 16 (T) | partly | self-declared | see 37 |
| 43 | Ticking the start-screen box accepts the Terms (T) | yes | `BeforeYouStartScreen` | none |
| 44 | Organizers must not export member data; "correct or remove a record when asked" (T) | partly | no organizer export; no function removes an attendance record | owner: decide |
| 45 | "Organizers may remove posts that break these rules" (T) | partly | organizers can cancel scheduled announcements only | add delete or reword |
| 46 | Removed member needs a new invitation (T) | no | a new code is refused too | Q7-5 |
| 47 | Delete account: Profile, Privacy, Delete my account (T) | yes | flow tests | none |
| 48 | Governing law Romania (T) | n/a | legal | lawyer |

### For the owner and the lawyer (not technical)

1. Processing agreements with Supabase (EU region), Expo and Google; the hosting provider of the web version; transfer mechanism for Expo and Google.
2. Record of processing (Art. 30) and a DPIA assessment (workout data, planned); controller identity set in `.env.local` and the build environment.
3. Retention schedule: inactive accounts (G3), notification delivery jobs (30 days, not in the notice), backups and Supabase logs (IP addresses, auth audit log) and how long they live.
4. Breach runbook (72 hours), contact process for e-mail requests, how to verify an anonymous account.
5. Decide: re-invitation of removed members, deletion versus retention of authored announcements, retention of free-text reasons, organizer record removal.
6. Age gate is self-declared; confirm Romania's age (16) and the wording; flip `LEGAL_REVIEWED` only after review.
7. Hosted Supabase checks listed in the contract (`delete from auth.users` by the security-definer function, cascade of Auth tables, pg_cron jobs).

### Evidence map

| Requirement | Evidence |
|---|---|
| Append-only ledger, all roles | `qa-gdpr-consent` "ledger: append-only", `consent-ledger.test.ts` |
| Documented gaps (replica, TRUNCATE) | `qa-gdpr-consent` GAP test |
| Versions, re-gating, no forgery | `qa-gdpr-consent` "versions and re-gating", `consent-gates.test.ts` |
| Push consent, pre-G1 tokens | Q7-1, Q7-2, `consent-gates.test.ts` |
| Deleted-account token on every function | `qa-gdpr-sweep` (generated from `pg_proc`), `account-deletion.test.ts` |
| Removed member sees nothing | `qa-gdpr-sweep`, `qa-gdpr-consent` "removed members" |
| Export: no tokens, codes, other people | `qa-gdpr-consent` last test, `data-export.test.ts` |
| Erasure completeness, anonymity, concurrency | `account-deletion*.test.ts` (existing), Q7-6, O4, O5 |
| Texts versus system | `qa-gdprCopy.test.ts`, the claims table |
| Cleanup after sign out / deletion | `qa-gdprCopy.test.ts` (Q7-8) |

### Cannot verify here

Hosted `auth.users` deletion by the function and cascade of Auth tables; pg_cron jobs for purges; Supabase Auth audit log contents; real push delivery and Expo handling of a token after withdrawal; anything on a device (checkbox/switch accessibility with TalkBack, dialogs, share sheet, cache file lifetime, back-button on the consent screen); Hermes behaviour; the web page generator's output in a browser (CSP, escaping were not exercised beyond the existing `renderHtml.test.ts`); whether the Realtime server sends anything for the anonymizing updates.

### Manual test script additions (continue the numbering of the C-Q1 script)

Setup: hosted project with the G1 and G2 migrations; two phones or one phone with account switching: **Ana** (organizer) and **Bob** (member), fake names only; a third account **Cora**.

100. Fresh install, Welcome. Tap Join a community. Expect "Before you start" with two unticked boxes, Terms and Privacy links; Continue disabled. Tick one box: still disabled. Tick both, Continue: the code screen.
101. Open the web link `/join#code=XXXX` in a fresh browser profile: expect the consent screen first (not the code screen), the address bar without the fragment, then the code prefilled after Continue.
102. Join with a valid code. SQL: `select purpose, granted, document_version from consent_records where user_id = '<id>' order by created_at;` expect `terms_privacy` (`terms:1|privacy:1`) and `age_16` before the membership row's time.
103. SQL: `select public.admin_set_legal_version('privacy','2');` Bob (existing member) opens the app: "We updated our terms" appears; try to export or delete from there (Q7-10: not possible today). Accept; the app opens. Ana tries Join another community before accepting: refused until accepted.
104. Profile, Privacy: push switch on (system permission prompt after the in-app prompt). Check `device_push_tokens` has a row. Switch off: confirmation dialog; confirm; row gone; the switch stays off after killing the app. Airplane mode, switch on: it snaps back with an error.
105. Push consent for an old token (Q7-1): insert a token row by SQL for Bob without consent, Ana posts an announcement: Bob's phone should not get a push (it does today).
106. Download my data: file opens in the share sheet; no push token values, no other member names. Press it 11 times within an hour: the 11th says rate limited. Sign out, then look at the app cache folder: the file should be gone (Q7-8: it stays).
107. Members screen as Ana: promote Bob (he becomes organizer), demote him, remove Cora; Cora's phone loses access to the community; Cora enters a fresh code from Ana: expect to be refused (Q7-5: text promises a re-invite works). Ana cannot demote or remove herself.
108. Delete my account with two accounts: Ana is the only organizer of a community with Bob in it: Delete shows the blocking community and does not delete. Ana promotes Bob; delete again: typed confirmation, success notice on Welcome. Check: Ana's id gone from `auth.users`; Bob sees the community, past attendance as "Former member"; Bob can still use the app; Ana's old session token cannot read anything.
109. Last member: Bob (alone in another community) deletes his account: the community is listed as "deleted with the account" before confirming and is gone afterwards.
110. Deleted account on the same phone: Welcome shows the deletion notice; Before you start appears again (the stored acknowledgement was cleared); a new join makes a new account.
111. Withdraw consent and delete while pushes are queued: post an announcement and immediately delete Bob; Bob's phone must not receive it after the deletion.
112. TalkBack: checkboxes read as checkbox with state; switches announce the purpose; dialogs trap focus and close with Back; typed-confirmation field is announced.

### What was run (Q7)

Windows, embedded Postgres, 2026-11-19, one suite at a time:

- `npm test` -> `Test Files  128 passed (128)`, `Tests  2432 passed | 10 expected fail (2442)` (409 s). The 10 expected failures are Q7-1 to Q7-10.
- `npm run typecheck` -> exit 0, no output.
- `npm run lint` -> exit 0.
- `npx expo export --platform web` (to a scratch directory) -> `Exported: ...`, exit 0.
- `npx expo-doctor` -> `19/20 checks passed`; the failed check is the dependency versions (`@expo/ui ~58.0.29` expected, 58.0.28 installed, 4 packages out of date). Not a GDPR matter; for the lead.
- Not run: Android bundle, a device, hosted Supabase, Deno.

### Test inventory (Q7)

| File | Tests | Covers |
|---|---|---|
| `supabase/tests/qa-gdpr-consent.test.ts` | 20 (6 expected fail) | ledger against all roles and owner, documented gaps, version re-gating, private helpers, deleted token, pre-G1 tokens, retention, removed members, free text after anonymization, RLS and Realtime identity, export contents |
| `supabase/tests/qa-gdpr-sweep.test.ts` | 3 | every `authenticated` function from `pg_proc`: deleted account, removed member, non-blind control |
| `src/features/legal/qa-gdprCopy.test.ts` | 9 (4 expected fail) | texts versus schema and source, analytics SDKs, sign-out cleanup, hygiene |

## Events and navigation (P1 + P2) review (Q8)

Scope: migration `20261126000100_events.sql`, the P1 app (kinds, form, status, RSVP, vocabulary, statistics) and the P2 app (tabs, bell, Home feed, `/activity` redirect, quick invite). Reviewed against `docs/EVENTS_PLAN.md` and the "Events (P1)" contract, not the developers' summaries. Code-level only: nothing was run on a device, a browser or a hosted project.

### Verdict

**P1 backend passes; P1 and P2 app pass with three low defects.** No critical, high or medium defect. The migration held under authorization, input, immutability, race, deadline-instant, erasure and lock probes (about 120 new database tests). The app's rules match the server except where listed. Three low defects are open as `it.fails` tests, plus four observations for the lead.

### Defects

| Id | Severity | Owner | Where | Summary |
|---|---|---|---|---|
| Q8-1 | low | backend | `20261126000100_events.sql:231-233, 333` vs `:411` | `event_notes` gets the announcement text hygiene; `title`, `description` and `meeting_instructions` do not. |
| Q8-2 | low | mobile | `src/features/trainings/domain/schema.ts:271-273` | The form does not freeze deadline, minimum and maximum for a training that is past its deadline but not yet decided. |
| Q8-3 | low | mobile | `src/features/trainings/components/OrganizerActions.tsx:78` | The cancel dialog of every kind has the button "Keep training". |

**Q8-1.** Test: `qa-events.test.ts`, "title, description and notes are cleaned the same way" (`it.fails`). Input `'ab\u0007c\r\nd‮e'`: notes become `abc\nde`; the description keeps the control and the right-to-left override. Expected one hygiene for every free-text field (bidi controls can reorder text in a title). Pre-existing for title and description; P1 made it visible by cleaning only the new field. Fix: route title, description and meeting instructions through the same cleaner.

**Q8-2.** Test: `qa-eventsApp.test.ts`, "a scheduled training past its deadline..." (`it.fails`); server side in `qa-events.test.ts`, "a training past its deadline but not yet decided is frozen". Server: `validation_failed:min_participants / max_participants / rsvp_deadline`. Form: `deadlineFrozen` and `limitsFrozen` need `status === 'confirmed'`, so for a `scheduled` training with a passed deadline (the minutes before the finalizer runs) the form offers fields the server then refuses. Fix: also freeze when `stored.status === 'scheduled'` and the stored deadline has passed (display only).

**Q8-3.** Race, sports and social events show "Keep training". Fix: "Keep event".

### Observations (no defect filed)

- **O1 Quick invite uses the device clock for the expiry** (`quickInvite.ts:14`, same preset as the Invitations screen). A phone 40 days behind sends an expiry in the past (`validation_failed:expires_at`); a phone ahead gives a longer-lived code. A test documents it. Fix if wanted: let `create_invitation` take a duration, or use a server-derived time.
- **O2 Opening the sheet creates a code at once.** Closing during creation, or reopening, leaves live 30-day single-use codes nobody saw (visible later on the Invitations screen). By design of "one tap"; consider revoking on close.
- **O3 Legal wording changed (trainings to events) without a version bump** (already noted in `PROGRESS.md`; owner decision).
- **O4 `export_my_data` lists organized events without kind or subtype.** Harmless.

### What held (probes that found nothing)

- Authorization of create, update, cancel and RSVP for member, outsider, other-community organizer, removed and demoted organizer, anon; no direct table or `event_subtypes` write for any API role; `community_id`, `status`, `going_count`, `organizer_id` in a payload are ignored.
- Kind immutable through every payload, the sync trigger and direct writes; table checks agree with the RPC (one known difference: a direct write rounds 10.555, the RPC refuses it).
- Numeric edges for distance, D+, obstacles, minimum (exponent forms, 1e3000, negatives, strings); notes hygiene, 1000-character limits, hostile text stored verbatim; the database seed equals the app's bundled subtype list, and the app's course helpers equal the database rules for every kind x subtype pair.
- RSVP: capacity, already-going never `session_full`, RSVP at the deadline instant after a lock wait (`clock_timestamp`), RSVP racing a cancel, mixed-kind finalizer and legacy-shaped rows, update freezes per kind, member removal on open and closed events across two communities, notification counts and texts per kind, reminders 24h/2h once each, statistics and history for each kind, top sessions with a null minimum.
- Erasure and export with race, social and sports events: no reference left, counts exact, attendance anonymized; organizer erasure keeps the event. `create_training` of every kind racing removal and deletion of the organizer: no deadlock, no foreign-key error.
- Status colours: all new tokens pass 4.5:1 (text) and 3:1 (borders) in light and dark, and differ from `confirmed` by glyph and fill style.
- Hosted risks by reading: backfill precedes `NOT NULL` and the composite foreign key; the lookup is seeded from `activity_types` first; the only top-level UPDATE has a WHERE (also asserted by test); `distance_km` reaches the app as a JSON number.
- Deep links: the allowlist holds against 19 hostile forms; `/activity` stays valid for the database constraint, the dispatcher payload `deepLink` and the redirect; sidebar active state for every route including `/notifications`, `/announcements/*`, `/members`, `/privacy`, `/invitations`.

### Evidence map

| Area | Evidence |
|---|---|
| Authorization, privileges, immutability, numeric and text edges, RSVP, finalizer, freezes, removal, notifications, reminders, statistics, erasure, lock probe, migration shape | `supabase/tests/qa-events.test.ts` (120 tests, 1 expected fail Q8-1) |
| Form versus server, RSVP offer, status per kind, vocabulary | `src/features/trainings/domain/qa-eventsApp.test.ts` (Q8-2, Q8-3 expected fails) |
| Deep links, routes, bell | `src/features/notifications/domain/qa-navigation.test.ts` |
| Home feed | `src/features/home/domain/qa-homeFeed.test.ts` |
| Quick invite | `src/features/invitations/domain/qa-quickInvite.test.ts` |
| Contrast | `src/ui/theme/qa-statusContrast.test.ts` |

### Cannot verify here

Anything on a device or in a browser: layout of the round button over the tab bar and on wide web, keyboard overlap, TalkBack reading of kind cards, chips, statuses and the bell, push taps (cold start and background) for each kind, Realtime updates of the badge, `db push` on a hosted database with data, the PostgREST numeric shape on the hosted project, DST behaviour of the form on a device, performance of 200 events on a phone.

### Manual test script additions

Setup: two accounts, **Ana** (organizer) and **Bob** (member), plus a second community where Bob is organizer; fake names only.

113. Ana: Events, New event. Four kind cards appear; pick Training, then a subtype. The minimum is required. Create. Bob gets "New training".
114. Ana creates a Race (Trail running) with distance `21,5`, D+ 450 and notes. No minimum field. Details show "21.5 km, D+ 450 m", the notes and status "Registration open". Bob gets "New race".
115. Ana creates an OCR race: the obstacles field appears. Edit it and switch the subtype to Asphalt running: obstacles disappear and are cleared.
116. Ana creates a Social event and a Sports event; a minimum is not offered.
117. Bob answers "Going" on the race and the social event. Set the maximum of the race to 1 in Edit; Cora (third account) cannot go: "full".
118. Edit the deadline of the social event to 2 minutes ahead. Wait: Bob's buttons disappear, status "Registration closed", the event is NOT cancelled and stays visible. A training with too few people is cancelled at its deadline as before.
119. Ana edits a race after its deadline: the deadline field is locked, the maximum is still editable, the kind cannot change.
120. Ana cancels a race: the dialog button says "Keep event" (Q8-3: shows "Keep training"); Bob gets "Race cancelled".
121. Events tab: filter All, Trainings, Races, Sports, Social; an empty filter shows "Show all".
122. Bell: shown top right on Home, Events, Statistics, Profile. Ana posts an announcement: Bob's badge shows 1; open the centre; Mark all read: the badge and the Home announcement dot disappear. With 10 or more unread: "9+".
123. Tap a push for an event and for an announcement from the background and from a killed app: the right screen opens. Open `/activity` in the web build: lands on Notifications.
124. Home as Bob: Next up (never a past event), Coming up, Latest announcements, "See all". As an organizer a "Needs attendance" list appears after an event.
125. Quick invite: Ana sees the round "Invite" button on Home and Events; Bob (member) does not. Switch Bob to the community where he is organizer: it appears; switch back: it disappears. Tap: a code appears with Copy and Share; "Create another" makes a second; close during creation and check Invitations for an unseen extra code (O2). Redeem with a third account: works once, a second use is refused.
126. Set the phone clock 40 days back and tap Invite: an error (O1). Restore the clock.
127. Ana cancels an event and types a reason ("Pitch is flooded."): Bob's notification ends with "Reason: Pitch is flooded.", and the event card and details show "Reason: Pitch is flooded.". Cancel another event with the field empty: no reason line. Paste 301 characters: the field shows an error and the button does nothing. A training below its minimum at its deadline shows "Reason: Not enough participants: N of M needed."

### What was run (Q8)

Windows, embedded Postgres, 2026-11-19, one suite at a time.

- `npm test` -> `Test Files  145 passed (145)`, `Tests  2907 passed | 3 expected fail (2910)` (477 s), exit 0. The 3 expected failures are Q8-1, Q8-2, Q8-3.
- `npm run typecheck` -> exit 0. `npm run lint` -> exit 0.
- `npx expo export --platform web` (scratch directory) -> `Exported`, exit 0.
- `npx expo-doctor` -> exit 1, one failed check: 4 packages out of date (`@expo/ui`, `expo`, `expo-router`, `expo-web-browser`), known drift, not fixed.
- Not run: a device, a browser session, hosted Supabase, Deno.

## P3 "About you" (app part) — manual test script

Setup: the hosted project with the P3 migration `20261130000100_about_you.sql` applied, the new APK/web build installed, and `select public.admin_set_legal_version('terms','2'), public.admin_set_legal_version('privacy','2');` run (the app bundles texts version 2). Accounts: **Ana** (organizer), **Bob**, **Cora** (members), **Dan** (a new person); fake names and numbers only (for example `+40 700 000 001`).

128. Dan joins a community with a code. After the join the "About you" page opens once, with a title, two cards ("For community statistics", "For safety and race kits") and a "Skip for now" button. Tap "Skip for now": the Home tab opens. Kill and reopen the app: the page does not come back. Sign out and join as a new account: it comes back once.
129. Dan: Profile, About you (the new entry above Community). Type `1800` in Birth year, tick the box, Save: the field error says the allowed years (between the server's min and max, not the phone clock). Set the phone clock one year ahead and back: the allowed range does not change. Enter `1990`, pick Woman, leave the box unticked, Save: the error "Tick the box to agree, or clear the birth year and gender." appears under the box. Tick it, Save: "Saved". SQL: `select purpose, granted from consent_records where user_id = '<dan>' order by created_at;` shows `profile_demographics`.
130. Dan fills only the second card: name `Eva Test`, phone `+40 700 000 002`, relationship `Sister`, size M, tick the box, Save. The first card is unchanged. Fill a name without a phone: "Add a phone number, or clear the name." Phone `12345`: "A phone number has 6 to 20 digits." Phone `07x2`: "Use digits, spaces and + ( ) . / - only."
131. Dan, airplane mode, Save: a red banner "No connection..."; the typed text is still there. Back online, Save works.
132. Ana (organizer): Profile, Members, tap Dan: the sheet shows "Emergency contact and T-shirt size": Eva Test (Sister), the number, size M and a "Call emergency contact" button (the phone app opens with the number, nothing is dialed). Tap Cora (who shared nothing): "Nothing shared". Ana taps her own row: no role actions, her own details if any. Bob (member) has no Members entry.
133. Ana: Members, "Emergency contacts and T-shirt sizes", Show the list: Dan is listed with contact, phone and size; Cora is not. Copy list, paste into a note: plain text, one block per person. Share opens the share sheet. Dan clears his consent in Profile, Privacy (switch off, confirm): reopen Ana's list and Dan's sheet: Dan is gone / "Nothing shared". Dan leaves the community: Ana no longer sees him.
134. Statistics as Ana, Community view: a "Community profile" card under the overview with Age and Gender rows. With fewer than 5 members who shared, cells read "Hidden (small group)" and the note explains that groups under 5 are hidden. With 5 or more in a band the number shows. The card is not in the Me view and not for Bob (Statistics has no Community view for members).
135. Profile, Privacy: the two new switches ("Birth year and gender", "Emergency contact and T-shirt size") show with their descriptions. Switch one off: the dialog says the details "will be deleted ... for good"; confirm: open About you, the fields are empty and the box is shown again. Switch it on, open About you: the box is gone ("You agreed to this") only after consent is current.
136. About you, "Clear my About-you data": a confirmation dialog; confirm: all fields empty, "Your About-you data was deleted." SQL: the `private.member_about_you` row is gone, the consent rows remain. Profile, Privacy, Download my data: the success text names "your About-you details" only when something is stored; the file has `extensions.about_you`.
137. The updated terms: as Bob (existing member) after the version bump the "We updated our terms" screen shows; the Privacy Notice (Profile, Privacy, Privacy Notice) now describes birth year and gender, emergency contact and T-shirt size, who sees them, the groups-of-5 rule and the retention line. Delete my account as Dan: his row is gone (SQL), and Ana's list no longer shows him.
138. TalkBack: the gender and T-shirt chips read as radio buttons with their state ("Selected. Tap again to clear"); the agreement checkboxes read as checkboxes; the hidden cells read "Woman: hidden, small group".

### What was run (P3 app part)

See the P3 entry in `docs/PROGRESS.md`: unit tests, typecheck and lint only. Not run: a device, a browser, the hosted backend.

## P3 QA - "About you" (independent code-level review, 2026-11-23)

Scope: migration `20261130000100_about_you.sql`, `src/features/aboutYou/**`, Members / Statistics changes, legal copy v2, consent and legal-version flow. Nothing was run on a device, in a browser or against the hosted project. New tests: `supabase/tests/about-you-qa.test.ts` (26 tests) and `src/features/aboutYou/domain/qa-aboutYou.test.ts` (15 tests). Tests named "DEFECT P3-QA-n" use `it.fails` (they pass while the defect exists and must lose `.fails` when it is fixed); "KNOWN LIMIT" tests document accepted behaviour.

Authorization (no hole found): every function is `security definer`, `authenticated` only; the table has no API privilege; organizer checks are read-time (`is_organizer` = active + organizer), so removed, departed and demoted organizers, other communities, plain members, anon and service_role are all refused (tests added for removed and departed organizers, cross-community ids, private helpers, no birth year / gender / names in any organizer response). Withdraw, save, clear, export and erasure take the consent lock or are single statements: races save vs withdraw, save vs clear, save vs delete_my_account, concurrent partial saves and withdraw vs export were tested and are clean. The replaced `erase_user`, `export_my_data` and `withdraw_consent` differ from their previous versions only by the About-you additions (diffed).

Defects (ranked):
- P3-QA-1 (medium, design): the groups-of-5 rule is defeated by an organizer who adds members. Organizers make invitation codes and anonymous accounts are free: four accounts "woman" + four "prefer_not_to_say" lift a hidden group of one woman to a shown 5, and 5 - 4 reveals it. Removing a member also shows which cell dropped (KNOWN LIMIT test; contract already admits differencing over time). Suggested fix: do not return live counts: round to multiples of 5 or return a daily snapshot, and require a minimum number of members with data (for example 20) before any cell is shown; tell the owner the claim "never one by one" holds only against a passive organizer.
- P3-QA-7 (medium, legal evidence): optional grants are stamped with the privacy version IN FORCE on the server (record_consent without a version). With the build bundling v2 and the server still at v1 (the documented deployment window), a consent given on the v2 text is stored as v1, and after the bump nobody is asked again (`has_consent` has no version check for these purposes). Fix: the app sends its bundled privacy version for optional purposes and the server refuses a mismatch (`validation_failed:document_version` -> `app_update_required`), or bump the server to 2 in the same step as the migration. Test: "KNOWN LIMIT: a grant is stamped with ...".
- P3-QA-2 (low/medium, app): `saveMyAboutYou` records the agreement(s) first; if the save then fails, the refetch flips `consents`, `aboutYouSignature` changes and `AboutYouForm` resets to the stored copy: typed input is lost (`aboutYouSignature`, `domain/aboutYou.ts`; reset effect `components/AboutYouForm.tsx`). Fix: leave `consents` out of the signature or do not reset while the form is dirty.
- P3-QA-3 (low): `api/aboutYou.ts` `unexpected()` keeps the whole answer in `AppError.original` and `lib/logger.ts` prints it with console.warn: a shape mismatch writes birth year, phones and names (the whole emergency list) to the device log. Fix: keep only the function name.
- P3-QA-4 (low): `components/MemberEmergencySection.tsx` (`aboutYou.call`) passes the `Linking.openURL` rejection to `reportError`; its message contains the `tel:` number.
- P3-QA-5 (low): `validatePhone` accepts "+" anywhere; the server only as the first character (form says valid, Save fails with a generic message).
- P3-QA-6 (low, UX): the welcome page is marked as seen only by Save or "Skip for now". Closing it with the system back gesture leaves it unmarked, so it returns at every app start. Suggest marking it seen when it is first shown. Also: sign-out of an anonymous account leaves the About-you row and the active membership behind for good (nobody can ever delete or correct it): offer "clear my About-you data" before sign-out or say so in the dialog.
- Very low: client `cleanText` strips bidi marks after collapsing spaces, so "Ion<RLO> Pop" is sent with two spaces (server fixes it); a birth year of (server year - 16) allows a person who is still 15 until their birthday; a copied list stays on the system clipboard; hiding the emergency list does not drop it from memory until the screen closes (cache limit 30 s after that).

Suppression (question 2): exhaustive check of 100 000 five-cell and 16 000 seven-cell distributions: shown cells are exact and at least 5; hidden cells are at least two and add up to at least 5, or everything is hidden. Concrete: cells 5,5,0 -> one 5 hidden with the zero (sum 5, two cells); 5,6 plus zeros -> the 5 is hidden with the zeros; 12,1,0,0,1 -> everything hidden. From ONE response no group below 5 is pinned to one cell (k >= 2, sum >= 5 means every split is possible). Residual: the hidden set shows that at least one cell of that set is small, and anything over time or with organizer-controlled membership leaks (P3-QA-1).

Legal wording vs code: accurate for what is stored, who sees it, the groups-of-5 rule, deletion on withdrawal and on clearing, retention, and "organizers lose sight when you leave". Overstated: "never shown to organizers one by one" is not true against an active organizer (P3-QA-1). Not mentioned: that organizers can copy / share the list (Terms tell them to keep it confidential); event posts exist since P4 but `FEATURES.eventPosts` is false so the notice is silent on them (open owner decision from P4). Version bump: server v1 + app v2 refuses new joins as `app_update_required` (by design); existing members keep working and see the updated-terms gate after `admin_set_legal_version('terms','2')` / `('privacy','2')`; the join and gate paths are covered by existing `consentState` tests.

Privacy of logs: only `lib/logger.ts` reports errors (no Sentry / crash reporter is installed); apart from P3-QA-3 and P3-QA-4 the About-you code logs only codes. `tel:` links keep digits and one leading "+" only (injection corpus tested). Query cache: members' details live 30 s after unmount and everything is cleared on sign-out and account deletion; no persisted query cache exists.

Not verified: hosted Supabase, device, browser, TalkBack, clipboard, `tel:` handling, Realtime.

### P3 QA - status after the fixes (2026-11-23)

- P3-QA-1: fixed in the backend (approximate totals: rounded to 5, minimum 20 members with data); the app now shows "about N", "Not enough answers yet (needs at least 20 members)" per dimension, and the explanatory note, privacy notice and settings text say "approximate group totals, rounded to the nearest 5, only once at least 20 members have answered, never individual birth years or genders" (the "one by one" claim is gone; the notice also admits that watching changes over time may reveal something). Open (known limit, tested on the backend): probing a rounding boundary by adding or removing sock-puppet accounts one at a time.
- P3-QA-2: fixed. `aboutYouSignature` no longer includes the agreements, so a failed save keeps what was typed (test lost `.fails`).
- P3-QA-3: fixed. `unexpected()` keeps only the function name (test lost `.fails`).
- P3-QA-4: fixed. A failed call attempt logs a fixed message, never the `tel:` URL (test lost `.fails`).
- P3-QA-5: fixed. `validatePhone` accepts `+` only as the first character (the server rule `^\+?[0-9 ()./-]+$`), with tests.
- P3-QA-6: fixed. The welcome page is marked as seen when it is first shown. The sign-out confirmation now says that the About-you details and the community membership stay on the server, that nobody can reach them after signing out, and that "Clear my About-you data" can remove the details first. Not changed: the delete-account flow (it already deletes everything).
- P3-QA-7: fixed in the app. `recordConsent` sends the bundled privacy version as `p_document_version` for the optional purposes (push, demographics, emergency contact, workout logs); `validation_failed:document_version` becomes `app_update_required` on every path. Unit tests in `src/features/legal/api/consents.test.ts` and `domain/consentState.test.ts`.
- Very low: client `cleanText` strips control and bidi characters before collapsing whitespace (fixed). Open: a copied emergency list stays on the system clipboard (cannot be controlled from the app); the birth-year bound (server year - 16) is as the server defines it.
- Not verified: device, browser, hosted backend (the migration is not applied there).
