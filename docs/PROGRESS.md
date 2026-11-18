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
- [x] M1-B3 (backend) QA defects Q1-1..Q1-6 fixed, strict deadline < start
- [x] M1-L1 (lead) README + SUPABASE_SETUP guide

## Milestone 2 — Attendance Management
- [x] M2-B1 (M, backend) attendance_records, audit log, record / finalize / correct RPCs, `completed` transition + tests
- [x] M2-A1 (M, mobile) Organizer attendance screen, walk-in attendee, history
- [x] M2-Q1 (+ fixes M2-B2, M2-F1) (S, qa) Review + tests

## Milestone 3 — Communications and Notifications
- [x] M3-B1 (L, backend) announcements, notifications, push tokens, outbox, scheduled publish, triggers + tests
- [x] M3-B2 (M, backend) Edge Function: Expo push delivery with retry and invalid-token handling
- [x] M3-A1 (L, mobile) Activity tab, unread state, push registration, deep links, preferences
- [x] M3-Q1 (+ fixes M3-B3, M3-F1) (S, qa) Review + tests

## Milestone 4 — Statistics
- [x] M4-B1 (M, backend) Statistics SQL functions with documented metric definitions + tests
- [x] M4-A1 (M, mobile) Statistics tab, charts, time filters
- [x] M4-Q1 (fixes done) (S, qa) Review + tests

## Wrap-up
- [ ] W1 (S, lead) Final README, deployment notes, known limitations

## Web version (W1) — built 2026-11-16 (stub-verified only; QA review pending)
Make the web build a first-class way to use TrainHive: responsive desktop layout (sidebar at >= 900px), `/join#code=...` join links (code in the URL fragment, removed from the address bar after reading), invitation message uses `EXPO_PUBLIC_WEB_APP_URL`, web details (clipboard/share, date inputs, no push UI), SPA hosting files + `docs/WEB_DEPLOY.md` (Netlify/Cloudflare drag-and-drop), a browser smoke test against a stub, then a QA review. After W1: APK build (`eas.json`) if still wanted.

## Not verified yet (needs a hosted Supabase project — see docs/SUPABASE_SETUP.md)
- Realtime delivery, pg_cron scheduling, anonymous sign-in against a real project, push delivery, running on a device.

## Log
- 2026-11-14: Foundation complete. Backend choice: embedded Postgres for tests now, hosted Supabase project later (owner will follow the step-by-step guide). Target: Android first.
- 2026-11-14 (later): Usage limit hit mid-wave 2. M1-B2 (trainings/RSVP/finalization backend) and M1-A1 (app foundation + onboarding) are PARTIALLY written and committed as work in progress; neither was finished, reviewed, or validated. On resume: run `npm run typecheck`, `npm run lint`, `npm test` first, then complete M1-B2 and M1-A1 against the task descriptions in docs/API_CONTRACT.md and docs/TEAM.md before moving on. Lead rulings to apply in M1-B2: null in p_input clears a field; frozen fields compared by instant; future-checks only on changed timestamps; char_length after trim; validation field = column name.
- 2026-11-15: Fable usage limit reached (resets 2026-11-19 08:00 Europe/Bucharest). Remaining work moves to Opus/Sonnet agents (spawn new agents with `model` set; resuming old agents would retry Fable). Pending: M1-Q1 part 2 (mobile QA review, appends Part 2 to docs/QA_REPORT.md), then Milestones 2-4.
- 2026-11-15: Milestone 1 build + QA complete (backend QA Q1-1..6 fixed; mobile QA Q2-1..9 fixed; Q2-11 edit-conflict deferred, needs a version check in update_training). Milestone 1 still needs the owner's run against hosted Supabase + Android (script in docs/QA_REPORT.md Part 2). M2-B1 done; next: M2-A1 (attendance screens), M2-Q1.
- 2026-11-16: All four milestones built, QA'd and fixed. Added after the owner's request: creator codes (only the platform owner can issue them; a holder creates their own community), community settings (organizer edits name/timezone), community switcher, friendly invite message (Copy/Share). C1 (backend) and C2 (app) committed; C-Q1 (QA of the community flows) pending. Hosted Supabase needs `npx supabase@latest db push --remote` for migrations through 20261119000100. Owner has not yet run the app against the hosted project; first sign-in blocked by Supabase CAPTCHA being on (must be off). Next: APK build (eas.json), push setup, Android test script in docs/QA_REPORT.md.
- 2026-11-16: W1 web version built and committed (responsive sidebar layout >= 900px, `/join#code=…` links, `EXPO_PUBLIC_WEB_APP_URL` in invitation messages, `public/_redirects` + manifest, `docs/WEB_DEPLOY.md`). Verified only in the built-in browser against a stub backend. Pending: a web-focused QA review (session storage, codes in links, hover/focus on shared buttons, `public/_headers`, real 192/512 icons), then the go-live checklist in `docs/GO_LIVE.md`. Usage note: weekly Fable allowance used up until 2026-11-19 08:00 (Europe/Bucharest); other models at ~90% — keep remaining work small.
- 2026-11-18: Owner requested a product expansion: Events (kinds/subtypes, race fields), "About you" profile page, event feed, bell + Home feed + invite round button, post-event workout logs + statistics. Full plan and confirmed decisions in `docs/EVENTS_PLAN.md` (phases P1 events core → P2 navigation → P4 event feed → P3 profile → P5 workout logs). Not started. Push notification test with the preview APK is in progress by the owner (server side verified: dispatch job returns 200).
- 2026-11-18: Owner asked for GDPR compliance with consent forms. Plan and defaults (controller = the owner via one config file, minimum age 16, delete personal data but keep anonymous attendance counts) in `docs/GDPR_PLAN.md`. Phases G1 (consent ledger, legal screens, age gate) and G2 (export my data, delete my account) must come BEFORE the Events plan's P3 (About you) and P5 (workout logs). New order: G1 → G2 → P1 → P2 → P4 → P3 → P5 → G3. Not started. Needs the owner: controller legal name, address, contact email; confirm the age and deletion defaults; a lawyer's review before real members join.
