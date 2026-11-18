# Prompt for resuming TrainHive work automatically

Use this as the prompt of a scheduled task (Claude app → Scheduled tasks, for example every 2 hours: cron `7 */2 * * *`), or paste it into a new session whenever usage is available. Each run starts with no memory, so it is self-contained. The app must be open for scheduled tasks to run.

Quick manual version (any new session): "Read CLAUDE.md and docs/PROGRESS.md and continue from where the log says."

---

You are continuing development of TrainHive (React Native / Expo SDK 58 + Supabase sports-community app) in the repository D:\GitStuff\train-hive (Windows; Node is at C:\Program Files\nodejs, add it to PATH if `node` is not found). The owner is the only developer and wants work to resume automatically whenever usage is available. Each run starts with no memory, so follow this exactly.

## 0. Should you run now?
1. Read `CLAUDE.md`, `AGENTS.md`, then `docs/PROGRESS.md` (the log at the bottom is the latest state), `docs/EVENTS_PLAN.md` and `docs/GDPR_PLAN.md`.
2. Run `git status --short` and `git log -5 --format="%h %cr %s"`. If there are uncommitted changes in the working tree that were modified within the last 30 minutes (check file modification times), or the last commit is less than 30 minutes old, ANOTHER SESSION IS PROBABLY ACTIVE: do nothing, reply with one line saying so, and stop. If there are older uncommitted changes, inspect them: they are partial work from an interrupted session; finish them if the intent is clear from the docs (run the checks first), otherwise leave them and say so.
3. If the previous run's work is not finished (a phase marked in progress in `docs/PROGRESS.md`), finish it before starting anything new.

## 1. What to build, in this order (do the next unfinished item; ONE phase per run)
G1 GDPR consents (backend then app: first-launch terms/privacy acknowledgement + age confirmation, consent ledger screens, Privacy settings, in-app legal documents and web pages, Sign out) → G2 (export my data, delete my account) → P1 Events core → P2 Navigation (bell, Home feed, invite round button) → P4 Event feed → P3 "About you" profile page → P5 Workout logs + post-event push + statistics → G3 retention/breach runbook/record of processing. The exact specifications, confirmed owner decisions and defaults are in `docs/EVENTS_PLAN.md` and `docs/GDPR_PLAN.md`; follow them. After a phase, have an independent QA review (qa-engineer agent) and fix its defects before moving on.

## 2. How to work (project rules)
- Read `.claude/agents/*.md` (backend-dev, mobile-dev, ux-designer, qa-engineer) and `docs/TEAM.md`; delegate with the Agent tool using those roles, giving each agent a fully self-contained brief (files, conventions, done criteria). Use `model` "opus" for security-critical backend work and "sonnet" for app work and QA.
- Conventions: all mutations are Postgres RPCs (security definer, `set search_path = ''`, grants revoked from public/anon/authenticated/service_role then granted to exactly one role); tables select-only under RLS; migrations in `supabase/migrations/` are the source of truth and are append-only (new files after the latest, never edit applied ones). **Every UPDATE and DELETE statement inside any database function MUST have a WHERE clause** (Supabase API requests run with pg-safeupdate; `supabase/tests/no-unguarded-writes.test.ts` enforces it). Keep the exact privilege-matrix tests (`supabase/tests/qa-privileges.test.ts`) passing and extend them; never weaken a test to make it pass.
- The machine is low on RAM and disk: run `npm test`, `npm run typecheck`, `npm run lint`, `npx expo export --platform web` strictly one at a time, never two test processes at once.
- Done criteria for any change: `npm test`, `npm run typecheck`, `npm run lint` pass (report real results in `docs/PROGRESS.md`). Then `git add` the specific files, commit with a clear message ending with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, and `git push origin main` (the owner works directly on main). Update `docs/PROGRESS.md` in the same commit with what was done, what is verified, what is not.
- Legal details for GDPR texts come from environment variables `EXPO_PUBLIC_CONTROLLER_NAME`, `EXPO_PUBLIC_CONTROLLER_ADDRESS`, `EXPO_PUBLIC_PRIVACY_EMAIL` (set in the gitignored `.env.local`); NEVER hard-code those personal details in source or docs; show `[TO BE FILLED]` when unset. Never read or print other secrets from `.env.local`.

## 3. Things you must NOT do (they need the owner)
Do not run `supabase db push`, `supabase functions deploy`, `supabase secrets set`, any `eas` command, `npm publish`, anything that changes the owner's Supabase project, Expo/Firebase accounts, Google Play, hosting, DNS or payments. Do not create accounts, send messages, or delete data. Do not force-push or rewrite git history. Do not modify `.env.local` or credentials. If a step needs one of these, add it to a list of "Owner actions needed" in `docs/PROGRESS.md` (for example: "apply new migrations with `npx supabase@latest db push --remote`") and continue with other work.

## 4. Finishing the run
End with `docs/PROGRESS.md` updated and everything committed and pushed (or explicitly noted as not finished). Your final message to the owner: 3-6 lines in plain language: what was completed and verified, what is unverified, and exactly what the owner needs to do (commands to run, decisions to make). If you hit a usage limit mid-way, commit nothing half-working: leave the notes in `docs/PROGRESS.md` of where you stopped so the next run resumes there. If everything in the plan is finished, say so and do nothing else.
