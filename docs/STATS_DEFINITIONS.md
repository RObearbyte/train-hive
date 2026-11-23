# TrainHive — Statistics definitions (Milestone 4; workout statistics P5 at the end)

The single source of truth for every number shown in the Statistics tab. The SQL functions, the app copy and the tests must all follow this file. Change it first, then the code.

## Principles

1. **Only real data counts.** `unrecorded` is not `absent`. A missing attendance record is not an absence. Nothing is imputed.
2. **Cancelled sessions never count** in any attendance statistic. Only the cancellation metrics look at them.
3. **Eligibility is evaluated per member, per session.** A member is *eligible* for a session when all of these hold:
   - the session is **finalized**: `status = 'completed'` and `attendance_finalized_at is not null`;
   - the session was **not cancelled** (a completed session never is, but check anyway);
   - the member's membership **started before the session started** (`memberships.joined_at <= training_sessions.starts_at`);
   - the member was an **active member** of the community when the session ended. A member removed later still keeps their past records in history, but is not counted in current-period rates for sessions after removal. (Implementation: use `joined_at` and, if the schema has no `left_at`, treat currently-removed members as ineligible for *community* statistics but keep their personal history readable to organizers.)
4. **Time filter** applies to the session's **`starts_at`** (not to when attendance was recorded). Filters: 7 days, 30 days, 90 days, all time, measured back from the server's `now()`, using sessions with `starts_at` in `[now - N days, now]`. The server computes the window; the client never sends a timestamp.
5. **Corrections apply immediately.** All statistics are computed live from the current `attendance_records`; a correction after finalization changes the numbers. Nothing is cached in a way that can go stale, apart from the app's normal refetch.
6. **Changed training dates:** statistics use the session's *current* `starts_at`. A session moved between windows moves with it.
7. **Zero denominators** produce `null` (shown as "—" with a short explanation such as "No finalized trainings yet"), never `0%` and never an error.
8. **Rates are percentages with one decimal at most**, rounded half up, computed in SQL from integer counts; the app also shows the underlying counts ("7 of 9").
9. **Small samples:** when the denominator is below 3, the app shows the count but labels the percentage "based on N trainings" (or "based on N RSVPs" for the RSVP-based rates).

## Member statistics (for one member, visible to that member and to organizers)

Let `E` = the set of finalized, non-cancelled sessions in the window for which the member is eligible (rule 3).

| Metric | Definition |
|---|---|
| **Eligible trainings** | `|E|` |
| **Attended** | sessions in `E` where the member's attendance is `present` (walk-ins included) |
| **Absent** | sessions in `E` where the record is `absent` |
| **Not recorded** | sessions in `E` where there is no record or the record is `unrecorded`. Shown separately, never added to Absent, never counted as a miss |
| **Recorded sessions** | Attended + Absent (the sessions where the organizer actually decided) |
| **Attendance rate** | `Attended / |E| × 100`. Unrecorded sessions stay in the denominator, as the spec defines the rate over eligible trainings; the screen therefore shows "Not recorded: n" next to it so the number is interpretable. Null when `|E| = 0` |
| **Confirmed RSVPs** | sessions in `E` where the member's RSVP response is `going` (the RSVP as it stands; RSVPs lock at the deadline) |
| **Missed trainings** | sessions in `E` where the member was `going` and the record is `absent`. Only explicit absences; `unrecorded` is never a miss. (Sessions attended without an RSVP are not misses.) |
| **RSVP reliability** | `(going AND present) / (going AND record is present or absent) × 100`. The denominator is *going RSVPs with a recorded outcome*, so unrecorded outcomes do not penalize reliability. Null when the denominator is 0. (Differs deliberately from the spec's loose wording "finalized trainings with RSVP = Going" so that missing data is not counted against the member; note this in the UI help text.) |
| **Walk-ins** | sessions in `E` attended with `is_walk_in = true` |
| **Monthly participation** | per calendar month **in the community's timezone**, for the window: eligible, attended, rate. Months with 0 eligible trainings are listed with null rate, not omitted, inside the window |
| **Historical attendance** | the list of sessions in `E` (newest first): title, date, RSVP response, outcome (Present / Absent / Not recorded) |

## Community / organizer statistics (organizers only)

Let `S` = finalized, non-cancelled sessions in the window (no per-member eligibility).

| Metric | Definition |
|---|---|
| **Completed trainings** | `|S|` |
| **Total actual attendances** | count of `present` records over `S` |
| **Average attendees per training** | `Total actual attendances / |S|`, one decimal. Null when `|S| = 0`. Sessions in `S` whose attendance has no `present` or `absent` records at all (never marked) are **excluded from this average and listed as "incomplete"** so a skipped sheet does not drag the average to zero; the count of excluded sessions is returned |
| **Average RSVP participation** | average over `S` of `going_count_at_deadline` (use `training_sessions.going_count`, frozen at the deadline) — "how many said they'd come" per training; one decimal |
| **RSVP-to-attendance conversion** | `present among going RSVPs / going RSVPs with a recorded outcome × 100` across `S` (community-wide RSVP reliability); null on 0 |
| **Active members** | active memberships at `now()` (not windowed). Also report **members who attended at least once in the window** |
| **Sessions cancelled for insufficient participation** | sessions with `status = 'cancelled'` and `cancel_reason = 'insufficient_participation'` and `starts_at` in the window (this is the only metric that looks at cancelled sessions). Also report organizer-cancelled count separately |
| **Attendance trend** | per week (windows of 7/30 days) or per month (90 days / all time), in the community timezone: number of sessions in `S`, total present, average attendees. Buckets with no sessions are returned with null averages |
| **Most attended trainings** | top 5 sessions in `S` by present count (ties: newer first): title, date, present count, minimum |

## Edge cases that must have tests

- Zero sessions, zero eligible sessions, zero going RSVPs: all rates `null`, no division error.
- Session cancelled by the organizer or finalizer: excluded from everything except the cancellation counts.
- Session confirmed but not yet finalized: excluded (not `completed`).
- Member joined after a session started: that session is not in their `E`.
- Member removed: personal history still readable by organizers; excluded from current community active count.
- Attendance corrected after finalization (`present` ↔ `absent` ↔ `unrecorded`): statistics change accordingly.
- Unrecorded vs absent: never conflated, in counts or rates.
- Walk-in attendee: counts as attended, not as an RSVP success or a miss.
- Session start moved across a window boundary.
- Boundaries: a session exactly at the window edge; month buckets across a DST change and a year boundary in the community timezone.
- Visibility: a member cannot read another member's statistics or the organizer overview; organizers can read any member of their community; no cross-community access.

## Workout statistics (P5)

Computed live from the workout logs (`private.workout_logs`, migration `20261201000100_workout_logs.sql`). A log belongs to one member and one event; its type comes from the event: `running` (running, trail running, OCR activities), `race` (race events), `strength` (strength, functional fitness, CrossFit events). Logs are private: individual logs are only ever returned to their owner; organizers see only the rounded community totals below.

### Personal (`get_my_workout_stats`, the member's own logs only)

Let `L` = the member's logs, optionally only those of one community's events, optionally only those whose event start (as recorded in the log, refreshed on every save) lies in `[from, to]` (both inclusive, either bound optional). Logs of communities the member left still count (they are the member's own).

| Metric | Definition |
|---|---|
| **Sessions logged** | `|L|` (also split into running, race and strength sessions) |
| **Total distance** | sum of `distance_m` over `L` (logs without a distance add nothing) |
| **Total time** | sum of `duration_s` over `L` (strength logs have no duration) |
| **Average pace** | `round(1000 × Σ duration_s / Σ distance_m)` seconds per km over the logs that have **both** a distance and a duration (a distance-weighted average, not the mean of the per-log paces); `null` when there is none. `pace_sessions` = how many logs it uses |
| **Pace of one log** | `round(1000 × duration_s / distance_m)` seconds per km, computed by the database; `null` unless both are known |
| **Strength volume** | sum of `reps × weight_kg` over every set of every strength log in `L` (bodyweight sets count 0 kg) |
| **Strength sets** | number of sets in the strength logs of `L` |

Rounding: half away from zero (= half up for these positive values). Empty `L`: counts and sums 0, average pace `null`.

### Community (`get_community_workout_stats`, organizers only; members never see community totals)

Let `C` = the logs of the community's events whose (current) start lies in the window (`7d`, `30d`, `90d`, `all`, as the attendance statistics: `[now − N × 24 h, now]`), excluding cancelled events, written by members who are **active members now** and hold a current `workout_logs` consent. A member who leaves or is removed drops out at once (their own logs stay theirs).

**Publication rule (the same idea and floor as the About-you demographics: approximate group totals only; tightened after QA findings P5-QA-1/2/3):**
1. **Floor:** nothing is shown (`insufficient_data`, every metric `null`) unless at least **20 distinct members** contributed a log to `C`.
2. **Per metric:** each metric additionally needs **20 distinct contributors of its own**: total distance needs 20 members with a distance, total time 20 with a duration, average pace 20 with both; otherwise that metric is `null`.
3. **Nested windows:** the windows share their end (now) and are nested (`7d` ⊂ `30d` ⊂ `90d` ⊂ `all`), so subtracting two answers gives the totals of the logs in between. The windows are therefore evaluated from the smallest up to the requested one, and a window (for rules 1 and 2: each metric separately) is published only when the **band** between it and the **next smaller window in which it was published** (the logs of events starting in `[from(W), from(P))`) has **0 or at least 20** contributing members (to that metric). A member who also logged in the smaller window is counted in the band when they have a log in it, so their older log cannot be isolated either. Because every band between two consecutive published windows covers 0 or 20+ members, so does the union of bands between any two published windows. Examples: 20 members this week only → all four windows show the same answer; 20 members this week + 1 member 14 days ago → `7d` shown, `30d`, `90d`, `all` suppressed; 20 this week + 1 14 days ago + 20 others 60 days ago → `7d` and `90d` shown (the `90d − 7d` band has 21 members), `30d` suppressed. A suppressed window reads `insufficient_data: true`; the fact that it is suppressed says only that 1–19 members logged in a band, never what.
4. **Rounding:** members contributing and sessions logged to the nearest **5**, total distance to the nearest **10 km**, total time to the nearest **30 minutes**, average pace (computed as for personal stats, from the exact sums) to the nearest **10 seconds per km** (half away from zero).

There is no per-member breakdown, no per-event breakdown and no strength volume at community level.

**Known limits (honest statement):** the rules above make any *single* set of answers (all windows read at the same moment) non-identifying. They do not stop *patient differencing over time*: an organizer who reads the same window before and after one member's log appears, after a member leaves or after they remove a member, learns that member's contribution to within the rounding (10 km, 30 minutes; members and sessions to 5). The same holds for an organizer who controls 19 accounts that log known values (invitation codes and accounts are free): the published total minus the known values gives the one real member's total to within the rounding. Windows sliding forward in time (an old log leaving a window) are a slow form of the same differencing. Snapshotted or noised totals would be needed to close this; not done (owner decision pending).

**Plausibility of the inputs (P5-QA-7):** a log with both a distance and a time must have a pace between **1:00 and 30:00 min/km** (inclusive, exact), so one implausible log (1000 km in one second) cannot dominate the totals or the average pace. A distance-only or time-only log is limited only by the field ranges (1 m .. 1000 km, 1 s .. 7 days).

### Edge cases covered by `supabase/tests/workout-logs.test.ts`

Pace rounding (x.5 up, distance-only and duration-only logs), strength volume with fractional weights and bodyweight sets, community and window filters, the 19/20 contributor boundary, a metric with fewer than 20 contributors, a member leaving, an event moved out of the window, a cancelled event, empty statistics, the nested-window band rule (no band, a 1-member band, an older log of a member in the smaller window, a 20-member band where one metric has only 19), the plausibility range. `supabase/tests/qa-workout-logs.test.ts` adds the QA scenarios: 4 puppets + 1 member, 19 puppets + 1 member (known limit, 10 km), 5 + 1 and 20 + 1 members across windows, a suppressed middle window, removal of a member (at and below the rounding), the 19/20/22/23 rounding edges with half-way values.
