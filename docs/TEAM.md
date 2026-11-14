# TrainHive — Team, roles and practices

The "team" is one lead session plus delegated agents. Role prompts live in `.claude/agents/`.

## Roles

| Role | Owns | Responsibilities |
|---|---|---|
| **Tech lead / architect** (main session) | `docs/`, root config, git | Architecture and contract, task breakdown, integration, final review, every commit and push, `docs/PROGRESS.md`. |
| **Backend developer** (`backend-dev`) | `supabase/` , `src/lib/database.types.ts` | Migrations, RLS, RPCs, scheduled jobs, Edge Functions, database integration tests for what they build. |
| **Mobile developer** (`mobile-dev`) | `src/app/`, `src/features/`, `src/lib/` | Screens, data access, hooks, domain logic with unit tests, error / loading / empty states. |
| **UX designer** (`ux-designer`) | `src/ui/`, `docs/DESIGN.md`, `assets/` | Design tokens (light + dark), reusable components, accessibility, screen-level UX review. |
| **QA engineer** (`qa-engineer`) | `supabase/tests/`, `src/**/*.test.ts`, `docs/QA_REPORT.md` | Independent review against the spec, missing security / concurrency / edge-case tests, runs the full validation, reports defects with evidence. |

## Practices

1. **Contract first.** `docs/API_CONTRACT.md` is agreed before backend and mobile work start. A change to it is made in the doc first.
2. **Stay in your lane.** Each role writes only inside the paths it owns, so parallel work never collides. Need something outside your lane? Say so in your report.
3. **Only the lead uses git.** Agents never commit, push, or switch branches. The lead commits after each task and pushes to `main`.
4. **Definition of done** for any task: `npm run typecheck`, `npm run lint` and `npm test` pass; new business rules have tests; no mocked backend responses; nothing claimed that was not run.
5. **Server is the authority.** Authorization, deadlines, counts and status are enforced in Postgres. The client never uses its own clock for a rule.
6. **Honest reports.** A task report states what was built, what was run and its result, what was not verified, and any deviation from the contract.
7. **Expo APIs move fast.** Check the versioned Expo docs (see `AGENTS.md`) before using an Expo API; install with `npx expo install`.
8. **QA is independent.** QA reviews after the developers, reads the spec rather than the developer's summary, and files defects instead of silently rewriting features. Small test-only fixes are fine.
9. **Resumable at any time.** `docs/PROGRESS.md` is updated with every commit: what is done, what is in progress, what is next.

## Task sizing and models

Tasks are sized to fit comfortably in one agent run (one vertical slice, one owner, clear done criteria). The strongest model takes security-critical and architectural work (schema, RLS, RPCs, review). Cheaper models take well-specified work (UI kit, documentation). If the strongest model is unavailable, the same task is re-run on the next model down.

## Resuming work in a new session

Tell Claude: "Read `docs/PROGRESS.md` and continue from the first unchecked task." Everything needed is in `docs/` and the git history.
