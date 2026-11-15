# TrainHive — Progress

Update this file with every commit. To resume: start at the first unchecked task.
Size: S ≈ small agent run, M ≈ medium, L ≈ large (split if it grows).

## Foundation
- [x] F1 Tooling: Node.js LTS installed, git identity set (lead)
- [x] F2 Expo SDK 58 scaffold, dependencies, Vitest + embedded Postgres verified (lead)
- [x] F3 Architecture, API contract, team roles, this checklist (lead)

## Milestone 1 — Functional Training MVP
- [x] M1-B1 (L, backend) Test harness + core schema, RLS, invitations, bootstrap + tests
- [x] M1-B2 (L, backend) Trainings, RSVP, deadline finalization, pg_cron + tests
- [x] M1-U1 (M, ux) Theme tokens, UI kit, `docs/DESIGN.md`
- [x] M1-D1 (M, mobile) Pure domain logic: status derivation, zod schemas, datetime, error mapping + unit tests
- [x] M1-A1 (M, mobile) Supabase client, secure session storage, providers, session gate, onboarding flow
- [x] M1-A2 (L, mobile) Trainings list / details / RSVP with optimistic update + Realtime, Home tab
- [x] M1-A3 (M, mobile) Create / edit / cancel training, invitations management, Profile tab
- [x] M1-Q1 (backend half; mobile half pending) (M, qa) Independent review, extra security / concurrency / timezone tests, validation run, `docs/QA_REPORT.md`
- [ ] M1-L1 (S, lead) Fix QA defects, README + `docs/SUPABASE_SETUP.md` step-by-step guide

## Milestone 2 — Attendance Management
- [ ] M2-B1 (M, backend) attendance_records, audit log, record / finalize / correct RPCs, `completed` transition + tests
- [ ] M2-A1 (M, mobile) Organizer attendance screen, walk-in attendee, history
- [ ] M2-Q1 (S, qa) Review + tests

## Milestone 3 — Communications and Notifications
- [ ] M3-B1 (L, backend) announcements, notifications, push tokens, outbox, scheduled publish, triggers + tests
- [ ] M3-B2 (M, backend) Edge Function: Expo push delivery with retry and invalid-token handling
- [ ] M3-A1 (L, mobile) Activity tab, unread state, push registration, deep links, preferences
- [ ] M3-Q1 (S, qa) Review + tests

## Milestone 4 — Statistics
- [ ] M4-B1 (M, backend) Statistics SQL functions with documented metric definitions + tests
- [ ] M4-A1 (M, mobile) Statistics tab, charts, time filters
- [ ] M4-Q1 (S, qa) Review + tests

## Wrap-up
- [ ] W1 (S, lead) Final README, deployment notes, known limitations

## Not verified yet (needs a hosted Supabase project — see docs/SUPABASE_SETUP.md)
- Realtime delivery, pg_cron scheduling, anonymous sign-in against a real project, push delivery, running on a device.

## Log
- 2026-11-14: Foundation complete. Backend choice: embedded Postgres for tests now, hosted Supabase project later (owner will follow the step-by-step guide). Target: Android first.
- 2026-11-14 (later): Usage limit hit mid-wave 2. M1-B2 (trainings/RSVP/finalization backend) and M1-A1 (app foundation + onboarding) are PARTIALLY written and committed as work in progress; neither was finished, reviewed, or validated. On resume: run `npm run typecheck`, `npm run lint`, `npm test` first, then complete M1-B2 and M1-A1 against the task descriptions in docs/API_CONTRACT.md and docs/TEAM.md before moving on. Lead rulings to apply in M1-B2: null in p_input clears a field; frozen fields compared by instant; future-checks only on changed timestamps; char_length after trim; validation field = column name.
