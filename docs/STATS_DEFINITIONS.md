# TrainHive — Statistics definitions (Milestone 4)

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
