# TrainHive — Data protection impact assessment (draft)

**Draft, 2026-11-23 (phase G3). Not legal advice.** A screening and a first assessment written from the code as it is today. The controller (`[CONTROLLER NAME]`) must review it, ideally with a lawyer, and sign the conclusion (section 7). Related: `docs/RECORD_OF_PROCESSING.md`, `docs/GDPR_PLAN.md`, `docs/STATS_DEFINITIONS.md`.

## 1. Screening: is a DPIA required? (Art. 35)

The EDPB guidelines (WP248 rev.01) say a DPIA is likely needed when two or more of nine criteria apply. ANSPDCP also publishes a list of processing operations that require one (Decision no. 174/2018); check it against this draft.

| Criterion | Applies? | Why |
|---|---|---|
| Evaluation or scoring | No | No profiling or scoring of individuals; organizers see attendance counts per member (a simple record, not an evaluation). |
| Automated decision with legal or similar effect | Limited | The inactive-account clean-up (disabled by default) deletes an account automatically after 24 months of inactivity and a 30-day notice. No legal effect beyond the service itself; can be avoided by opening the app. |
| Systematic monitoring | Partly | Attendance records over time (who trains when). Not covert, not of public spaces. |
| Sensitive data (Art. 9) or highly personal data | **Yes** | Workout logs can reveal health information (treated as special category); emergency contacts are third parties' phone numbers; birth year and gender. |
| Large scale | No (today) | Sports clubs of tens to hundreds of members. Re-assess if the service grows to many clubs. |
| Matching or combining datasets | No | No external data sources. |
| Vulnerable data subjects | Limited | Under-16s are excluded (age gate). Club members may be in a dependent relationship with organizers (coach / athlete). |
| Innovative technology | No | Standard mobile app and managed database. |
| Prevents exercising a right or using a service | No | Optional data is never required to use the service. |

**Screening result:** at least two criteria apply in part (sensitive data; monitoring-like attendance history; a dependent relationship). A full DPIA is **recommended**. The rest of this document is that DPIA in draft.

## 2. Description of the processing

See the record of processing, sections 2 to 4 and 7. In short: anonymous accounts on a phone or browser; community membership; events, RSVPs and attendance; announcements and event discussions; push notifications; optional "About you" (birth year, gender, emergency contact, T-shirt size); optional workout logs. Stored in Supabase (Postgres); push through Expo and Google FCM.

## 3. Necessity and proportionality

- **Purpose limitation:** each optional data item has one stated purpose (statistics; safety and race kits; personal progress).
- **Minimization:** no e-mail, no name required (nickname allowed), no location, no analytics. Birth year instead of date of birth. Organizers see only approximate totals for demographics and workouts.
- **Lawful basis:** contract for the core service; explicit consent for optional data, recorded per purpose and version, withdrawable in one tap (withdrawal deletes the data).
- **Retention:** register in the record of processing, section 7; automated purges; inactivity clean-up available.
- **Rights:** in-app export and deletion; e-mail procedure for the rest.
- **Processors:** DPAs to be signed (`docs/PROCESSORS_CHECKLIST.md`).

## 4. Risks to people

| # | Risk | Likelihood (before measures) | Severity |
|---|---|---|---|
| R1 | An organizer learns a member's health-related information from workout logs | Possible | Significant |
| R2 | Small-group statistics reveal one person's age, gender or training (differencing, sock-puppet accounts) | Possible | Limited to significant |
| R3 | Emergency contact details misused by an organizer (contact for other purposes) or exposed | Possible | Significant (third party) |
| R4 | Attendance patterns reveal when someone is away from home or their routine | Possible | Limited |
| R5 | A breach of the database (leaked key, misconfiguration) exposes all data | Unlikely | Significant |
| R6 | Push notification text visible on a locked screen or passed to processors outside the EEA | Likely | Limited |
| R7 | A member who leaves or is removed cannot easily get their attendance history removed | Possible | Limited |
| R8 | Inactive accounts keep data indefinitely; or, when enabled, an account is erased that the member still wanted | Possible | Limited |
| R9 | A child under 16 joins despite the age gate | Possible | Significant |
| R10 | Organizers export or share member data outside the app (screenshots, copy list) | Possible | Limited to significant |

## 5. Measures

| Risk | Measures in place | Evidence |
|---|---|---|
| R1 | Logs in the `private` schema, owner-only functions, organizers never read a log; community totals only with 20+ contributors, rounded, nested-window guard; consent per purpose; withdrawal deletes all logs; notification texts carry no workout data | `20261201000100_workout_logs.sql`, `workout-logs.test.ts`, `qa-workout-logs.test.ts` |
| R2 | 20-answer floor, complementary suppression of cells below 5, rounding to 5; current numbers only in the app | `20261130000100_about_you.sql`, `about-you-qa.test.ts`, `docs/STATS_DEFINITIONS.md` (known limit documented) |
| R3 | Separate consent; the member is told to inform the contact; visible only to organizers of the member's active communities, checked at read time; terms restrict organizers to safety and race kits; never in pushes | `about-you.test.ts`, terms |
| R4 | Attendance visible to organizers and the member only; anonymized on deletion; members can object | RLS policies, `account-deletion.test.ts` |
| R5 | RLS, definer functions with fixed search path, exactly-one-role grants (tested), no keys in the app, 2FA (owner), breach runbook | `qa-privileges.test.ts`, `docs/BREACH_RUNBOOK.md` |
| R6 | Push only with consent (checked at send time); neutral texts; members can keep push off and use in-app notifications | `gdpr-qa-fixes.test.ts`, notice "Transfers" |
| R7 | Delete my account anonymizes attendance; objection by e-mail; organizer can correct records | notice "Your rights" |
| R8 | Inactivity clean-up built, **disabled by default**, 30-day notice, any activity cancels, last organizer never erased automatically, preview with counts before enabling | `20261202000100_retention.sql`, `retention.test.ts` |
| R9 | Age confirmation at first launch; terms; operator erasure procedure | consent gates, record of processing section 9 |
| R10 | Terms forbid copying and sharing; no organizer export of member data; the emergency list "Copy / Share" exists for safety use and is a residual risk | terms, `src/features/members/` |

## 6. Residual risk

| Risk | Residual |
|---|---|
| R1 | Low (patient differencing with 19 controlled accounts is a documented, unlikely attack) |
| R2 | Low to medium in very small clubs over time (documented in the notice) |
| R3 | Medium: depends on organizers' behaviour; mitigated by the terms and by the member's choice to give it |
| R4, R6, R7, R8 | Low |
| R5 | Low, provided the owner measures (2FA, key hygiene, DPAs) are done |
| R9 | Low to medium (self-declared age) |
| R10 | Medium (copy / share of the emergency list, screenshots) |

## 7. Conclusion (draft, for the controller to confirm)

> Having assessed the processing described above, the controller concludes that, with the measures listed in section 5 and the owner actions in `docs/PROCESSORS_CHECKLIST.md` and `docs/GO_LIVE.md` phase 6 completed, the residual risk to members is **acceptable** and **no prior consultation** of ANSPDCP under Art. 36 is needed. The assessment will be reviewed when a new kind of personal data is added, when the service grows beyond a few clubs, when the inactivity clean-up is enabled, and at least once a year.
>
> Signed: [CONTROLLER NAME], [DATE]. Reviewed by: [lawyer / adviser], [DATE].

## 8. Open points before signing

- Confirm with a lawyer that workout logs should be treated as Art. 9 data (this draft does, which is the safer choice).
- Decide whether to keep the "Copy / Share" of the emergency list (R10) or limit it.
- Decide a cap on attendance history age (record of processing, section 7).
- Confirm the Supabase region is in the EU and the DPAs are signed.
