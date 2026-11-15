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
