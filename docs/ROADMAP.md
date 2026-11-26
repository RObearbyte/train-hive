# TrainHive — post-launch roadmap

Ideas the owner wants to work on **after the launch**. Not started; each needs its own plan, backend + app + QA review.

## Hall of fame and community achievements (owner request, 2026-11-26)

A community-level place that celebrates members: for example the fastest 5 km / 10 km / half / marathon in the community, the heaviest confirmed lifts, longest distance, most events attended, streaks, milestones ("100 km logged this month as a community").

Builds on personal records (migration `20261205000100_personal_records.sql`, docs/API_CONTRACT.md "Personal records") and the workout statistics.

Constraints to design for (do not skip):
- **Opt-in only.** Personal records and workout logs are private today; organizers see only rounded community totals once at least 20 members contributed. Showing a named member on a hall of fame is a new purpose: it needs its own consent (a new consent purpose, unticked by default, withdrawable at any time, withdrawal removes the member from every board).
- Community-wide achievements without names (totals, milestones) must follow the existing publication rules (contributor floor, rounding, no differencing by window).
- Privacy notice, terms, record of processing, DPIA draft and claims audit need updating before release; legal version bump.
- Abuse: implausible entries (the pace plausibility check already exists for logs) and self-reported lifts: consider organizer verification or a "verified at event" flag for official boards.
