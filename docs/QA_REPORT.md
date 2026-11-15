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
