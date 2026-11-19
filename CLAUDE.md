# TrainHive

Sports community management app: Expo (React Native, SDK 58) + Supabase. See `AGENTS.md` for Expo rules.

- Start here: `docs/PROGRESS.md` (what is done / next), `docs/ARCHITECTURE.md`, `docs/API_CONTRACT.md`, `docs/TEAM.md`.
- Commands: `npm run typecheck`, `npm run lint`, `npm test` (Vitest; boots an embedded Postgres, no Docker), `npm start`.
- All mutations are Postgres RPCs; tables are select-only under RLS. Migrations in `supabase/migrations/` are the source of truth.
- Single developer: commit to `main` and push after each completed task; update `docs/PROGRESS.md` in the same commit.
- Node on this machine: `C:\Program Files\nodejs` (may be missing from PATH in a fresh shell).

## Reminders for the assistant (owner's standing requests)

- **Before going to production** (when the owner talks about launching, publishing to the Play Store, inviting real members, or building a production/release build): remind them to re-check the legal details used in the privacy notice and terms — controller name, postal address and privacy contact email (`EXPO_PUBLIC_CONTROLLER_NAME`, `EXPO_PUBLIC_CONTROLLER_ADDRESS`, `EXPO_PUBLIC_PRIVACY_EMAIL`; stored in the gitignored `.env.local`, as EAS environment variables for Android builds, and in the web build environment). They are shown publicly in the app. Suggest a dedicated privacy email and a non-home address if they haven't changed them, and recommend a lawyer review of the legal texts. See `docs/GO_LIVE.md` phase 6.
- **Placeholders during testing (owner's decision, 2026-11-19):** the EAS `preview` environment variables `EXPO_PUBLIC_CONTROLLER_NAME`, `EXPO_PUBLIC_CONTROLLER_ADDRESS` and `EXPO_PUBLIC_PRIVACY_EMAIL` are set to PLACEHOLDER values ("TrainHive Test (placeholder)", "Placeholder Street 1, Placeholder City, Romania", `privacy@example.com`). Whenever the owner asks for the go-live steps (or talks about launching/publishing/inviting real members), remind them to replace the placeholders with their real legal details in EVERY environment that will be used for real members: EAS `production` (and `preview` if still distributed), the web build environment, and `.env.local` (which currently holds the real values for local runs), then rebuild the app and web app, and regenerate the legal pages with `npm run legal:build`. The placeholders must never ship to real members. Also remind them that `LEGAL_REVIEWED` stays false until a lawyer has reviewed the texts.
