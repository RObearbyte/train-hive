# TrainHive

Sports community management app: Expo (React Native, SDK 58) + Supabase. See `AGENTS.md` for Expo rules.

- Start here: `docs/PROGRESS.md` (what is done / next), `docs/ARCHITECTURE.md`, `docs/API_CONTRACT.md`, `docs/TEAM.md`.
- Commands: `npm run typecheck`, `npm run lint`, `npm test` (Vitest; boots an embedded Postgres, no Docker), `npm start`.
- All mutations are Postgres RPCs; tables are select-only under RLS. Migrations in `supabase/migrations/` are the source of truth.
- Single developer: commit to `main` and push after each completed task; update `docs/PROGRESS.md` in the same commit.
- Node on this machine: `C:\Program Files\nodejs` (may be missing from PATH in a fresh shell).
