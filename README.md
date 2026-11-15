# TrainHive

**One Pack. Stronger together.**

A mobile app for sports communities (running clubs, trail and OCR groups, functional fitness teams): organizers schedule trainings with a minimum attendance, members RSVP in one tap, and the server confirms or cancels each session at its RSVP deadline.

Stack: Expo SDK 58 (React Native, TypeScript strict, Expo Router, TanStack Query, React Hook Form, Zod) and Supabase (Postgres, Row Level Security, anonymous auth, Realtime, pg_cron).

## Status

See [docs/PROGRESS.md](docs/PROGRESS.md) for the live checklist.

| Milestone | State |
|---|---|
| 1 — Training MVP (onboarding, trainings, RSVP, minimum attendance, organizer tools) | Built and tested locally; not yet run against a hosted Supabase project or on a device |
| 2 — Attendance | Not started |
| 3 — Announcements and notifications | Not started |
| 4 — Statistics | Not started |

## Quick start

Requirements: Node.js LTS. No Docker needed.

```bash
npm install
```

```bash
npm test
```

`npm test` boots a real PostgreSQL from npm (`embedded-postgres`), applies a small Supabase shim plus every migration, and runs the database and unit tests.

To run the app you need a Supabase project. Follow [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) step by step (about 15 minutes), then:

```bash
npm start
```

Scan the QR code with Expo Go on Android. Without `.env.local` the app shows a "Backend not configured" screen.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Expo dev server |
| `npm run web` | Run in a browser |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (Expo config). If it reports a stale parse error, delete `.expo/cache/eslint` |
| `npm test` | Vitest: database integration tests and unit tests |
| `npx expo-doctor` | Expo dependency and config checks |

## Environment variables

Copy `.env.example` to `.env.local`:

- `EXPO_PUBLIC_SUPABASE_URL` — project URL
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — anon / publishable key

The `service_role` key must never be placed in the app or its env files.

## How it is built

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, decisions, folder structure, status model
- [docs/API_CONTRACT.md](docs/API_CONTRACT.md) — tables, RPCs, error codes
- [docs/DESIGN.md](docs/DESIGN.md) — theme tokens, components, screen guidance
- [docs/QA_REPORT.md](docs/QA_REPORT.md) — independent review, defects, what is and is not verified
- [docs/TEAM.md](docs/TEAM.md) — roles and working practices used to build it

The essentials:

- Every change to data goes through a Postgres function; tables are read-only to clients under Row Level Security.
- A session is `scheduled`, `confirmed`, `cancelled` or `completed`. "Awaiting minimum" and "Minimum reached" are derived from the live count while `scheduled`, and are provisional.
- At the RSVP deadline a database job (pg_cron, every minute) decides Confirmed or Cancelled — insufficient participation. The decision does not depend on any phone being online and cannot be changed by late RSVPs.
- Organizers come only from an organizer invitation, which only `admin_create_community()` (service role / SQL editor) can create.

## Database migrations

`supabase/migrations/` is the source of truth. Apply with `npx supabase@latest db push --remote` (the flag matters: without it the CLI targets a local Docker stack) or by pasting files in order into the SQL editor; details in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).

## Deployment notes

- Android builds: EAS Build (`npx eas-cli@latest build -p android`). Expo Go is enough for Milestone 1.
- Enable Supabase's anonymous sign-in rate limit and CAPTCHA before inviting real users; the in-app invitation rate limit is per account.
- After the first deploy, confirm the deadline job exists: `select jobname, schedule from cron.job;`

## Known limitations

- Accounts are anonymous and live on the device. Uninstalling, clearing app data or losing the phone loses the account; the member rejoins with a new code. The schema allows linking email / Apple / Google later without losing history.
- One community per user in the UI (the database supports several).
- Not yet verified end to end: Realtime delivery, the scheduled deadline job on hosted Supabase, and behaviour on a physical device.
- App icon and splash are still the Expo placeholders.
