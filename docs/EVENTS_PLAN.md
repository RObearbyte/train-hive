# TrainHive — Events, profile, feeds and workout logs (plan)

Requested by the owner on 2026-11-18. Decisions below are confirmed by the owner unless marked "default" (my ruling, changeable).

## Confirmed decisions

| Topic | Decision |
|---|---|
| Profile onboarding fields | Age (birth year) + gender; emergency contact + T-shirt size. All optional and skippable. (City, experience level, sports and weekly goal were not selected.) |
| Privacy | Private + group totals. Age/gender: only grouped statistics for organizers, groups of 5 or more members. Workout logs: private; organizers see only community totals. |
| Emergency contact + T-shirt size (default) | Visible to organizers of the member's community (safety, race kits), with a consent notice on the form. Members can clear them at any time. |
| Event feed | Organizers post; members reply. Organizers can delete any reply. |
| Minimum attendance | Trainings only. Races, sports events, social events have no minimum and no automatic decision. |
| Database naming (default) | Keep the table `training_sessions`; "Event" is a UI and API-vocabulary change plus new columns. Renaming the table would risk every migration, policy and test for no user benefit. |

## 1. Events (kinds and subtypes)

`event_kind`: `training` | `race` | `sports_event` | `social`.
`event_subtype` (extensible lookup `event_subtypes(kind, key, label)`):
- training: running, trail_running, strength, functional_fitness, ocr, other (the current activity types)
- race: trail_running, asphalt_running, ocr
- sports_event: crossfit_event, public_training, other
- social: social_gathering, other

Create flow: **Create an event** → pick a kind (4 large cards) → pick a subtype → details form (fields depend on kind).
Running-type events (running, trail_running, asphalt_running, OCR subtypes, any kind): extra fields `distance_km`, `elevation_gain_m` (D+, optional), `obstacle_count` (optional, OCR), `event_notes`.
Minimum participants: required for `training`, hidden/null for the other kinds. At the RSVP deadline the finalizer decides only `training` events with a minimum. Other kinds are created `confirmed` (registration open until the deadline or capacity); RSVP rules adapt (allowed while `scheduled` or `confirmed` before the deadline). Everything else (deadline, capacity, attendance, statistics) works for every kind.
Existing data migrates to `kind = training`, subtype = old `activity_type`.

## 2. Navigation

- Bottom tabs: Home, Events (renamed from Trainings), Statistics, Profile. (Activity tab removed.)
- **Bell icon top-right** on every main screen: opens the notification centre with an unread badge.
- **Home = feed**: upcoming events (nearest first, with the RSVP control and status), plus the latest announcements mixed in by time, "See all announcements" link. Events tab keeps the Upcoming / Past list with filters by kind.
- **Floating round button, bottom-right (organizers only):** opens a small sheet "Invite someone": creates a member code with defaults (30 days, 1 use) in one tap, shows the friendly message with Copy / Share; "More options" opens the full Invitations screen.

## 3. Profile onboarding ("About you")

One short page shown once after joining or creating a community (skippable, re-editable in Profile → About you): birth year, gender (woman / man / other / prefer not to say), emergency contact (name, phone, relationship), T-shirt size. Consent text explains who sees what. Stored in a separate private table; row-level security: self read/write; organizers of the member's communities can read only emergency contact and T-shirt size; age and gender are only reachable through aggregate functions with a minimum group size of 5.

## 4. Event feed

Table `event_posts` (event, community, author, parent for replies, body ≤ 1000, created, deleted). Organizers create top-level posts, members reply (one level). Organizers delete any post. Realtime updates; unread indicator per event; push to members going to the event for a new organizer post (rate-limited, 5 per organizer per event per hour); replies notify only the post's author. Every text goes through the shared text hygiene (controls, bidi, invisible).

## 5. Workout logs and statistics

After an event's end time (end + 15 minutes, idempotent, server-side job) members who said "going" get a push and an in-app notification: "How did it go? Log your workout." Deep link `/events/<id>/log` (added to the database allowlist and the app allowlist).
Log shape by kind:
- strength training: exercises with sets (reps, weight kg), notes;
- running (training or race subtype): distance, time, pace (computed), notes;
- race: finish time, distance, pace, notes.
Logs are private to the member. New personal statistics: total distance, time, average pace, sessions logged, strength volume (kg lifted). New community statistics (aggregate only, groups of 5+): total distance, total time, sessions logged, average pace.

## Phases (each = backend + app + QA review, one commit per piece)

| # | Phase | Notes |
|---|---|---|
| P1 | Events core: kinds/subtypes, race fields, optional minimum, create flow, UI rename Trainings → Events | Biggest migration. |
| P2 | Navigation: bell, Home feed, Activity tab removal, invite round button | App only plus small reads. |
| P3 | "About you" profile page, privacy rules, aggregate age/gender stats | New private table. |
| P4 | Event feed (posts, replies, delete, notifications) | |
| P5 | Post-event prompt, workout logs, statistics | Needs P1; adds a notification kind. |

Order: P1 → P2 → P4 → P3 → P5.

## Risks and notes

- Health-related data (workout logs, emergency contact, age/gender) raises privacy duties; the consent text and privacy policy must say what is stored and who sees it (see `docs/GO_LIVE.md`, phase 6).
- Hosted database: every phase adds migrations; push with `npx supabase@latest db push --remote` after each.
- Usage: this is roughly 15 agent runs. The weekly allowance resets on 2026-11-19 08:00 (Europe/Bucharest); work is resumable from this file and `docs/PROGRESS.md`.
