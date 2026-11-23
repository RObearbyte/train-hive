# TrainHive — Record of processing activities (GDPR Art. 30)

**Draft, 2026-11-23 (phase G3).** Written from the code and the migrations in `supabase/migrations/` as they are on this date. It is not legal advice. Have it reviewed together with the privacy notice before real members use the app, and keep it up to date with every change that adds or changes personal data (the test `supabase/tests/retention.test.ts` fails when a database table is missing from section 7).

Placeholders: `[CONTROLLER NAME]`, `[POSTAL ADDRESS]`, `[PRIVACY EMAIL]`, `[DATE]`. Fill them in your own copy; never commit your personal details to the repository. The app reads the same details from `EXPO_PUBLIC_CONTROLLER_NAME`, `EXPO_PUBLIC_CONTROLLER_ADDRESS`, `EXPO_PUBLIC_PRIVACY_EMAIL`.

## 1. Controller

| Item | Value |
|---|---|
| Controller | `[CONTROLLER NAME]`, `[POSTAL ADDRESS]` |
| Contact for data protection | `[PRIVACY EMAIL]` |
| Representative in the EU / DPO | Not required as far as known (controller established in the EU; no large-scale special-category processing as core activity). Confirm with the lawyer. |
| Joint controllers | None. Organizers of a community are users of the service (terms bind them), not controllers of the platform. |
| Supervisory authority | ANSPDCP (Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal), www.dataprotection.ro |

## 2. Processing activities

| # | Activity | Purpose | Data subjects | Data categories | Lawful basis | Source |
|---|---|---|---|---|---|---|
| A1 | Accounts and membership | Run the service, authorization | Members, organizers | Anonymous account id, display name, community membership, role, status, join date | Art. 6(1)(b) contract | The member |
| A2 | Events, RSVPs, attendance | Plan events, record who took part, club statistics | Members, organizers | RSVP answers, attendance records, attendance change history (with optional organizer note), events organized | 6(1)(b); 6(1)(f) legitimate interest of the community for attendance history (objection possible) | Member (RSVP), organizer (attendance) |
| A3 | Announcements and event discussions | Community communication | Members, organizers | Announcement text, event posts and replies (text, author, time), read markers | 6(1)(b) | Author |
| A4 | Notifications and push | Reminders and updates | Members | In-app notifications, push token, platform, device label, notification settings, delivery status | Push: 6(1)(a) consent (and OS permission); in-app: 6(1)(b) | App, server |
| A5 | About you: birth year and gender | Approximate group totals for organizers | Members who opt in | Birth year, gender | 6(1)(a) explicit consent | Member |
| A6 | About you: emergency contact and T-shirt size | Safety at events, race kits | Members who opt in; the emergency contact (third party) | Contact name, phone, relationship; T-shirt size | 6(1)(a) consent of the member; for the third party 6(1)(f) (safety), the member is asked to inform them | Member |
| A7 | Workout logs | Personal history and totals; rounded community totals | Members who opt in | Exercises, sets, weights, distance, time, pace, notes, event snapshot | Treated as Art. 9 data: 9(2)(a) explicit consent (and 6(1)(a)) | Member |
| A8 | Consent ledger and legal versions | Proof of consent and acknowledgement (Art. 7(1)) | All users | Purpose, granted/withdrawn, document version, time | 6(1)(c) legal obligation (accountability), 6(1)(f) | App |
| A9 | Data subject rights | Export, deletion, inactivity clean-up | All users | Export request times, inactivity notice, last app open | 6(1)(c) | Server |
| A10 | Security and abuse prevention | Rate limits, audit | All users | Code attempts (24 h), export requests (1 h), attendance audit | 6(1)(f) | Server |
| A11 | Hosting, delivery, logs (processors) | Run and secure the infrastructure | All users | IP address, user agent, request logs, auth logs | 6(1)(f) | Device |

Not processed: precise location, contacts, advertising identifiers, analytics, payments, data of children under 16 (age gate at first launch; accounts of under-16s are deleted when known, see section 9).

## 3. Recipients

| Recipient | What they receive | Role |
|---|---|---|
| Organizers of the member's community | Membership, RSVPs, attendance, emergency contact and T-shirt size (only with consent, only while the member is active), approximate group totals (birth year / gender: 20+ answers, rounded to 5; workouts: 20+ contributors, rounded) | Users bound by the terms |
| Members of the same community | Display name, "going" answers on event pages, posts and replies with author name | Users |
| Supabase (database, authentication, server functions, storage of all app data) | Everything in section 7 | Processor |
| Expo (push notification service) | Push token, notification title and body (event titles, up to 200 characters of a post) | Processor |
| Google Firebase Cloud Messaging | Push token, notification title and body (Android delivery) | Processor (sub-processor of the delivery chain) |
| Web hosting provider (Netlify or Cloudflare Pages, per `docs/WEB_DEPLOY.md`) | IP address and request logs of visitors of the web version; no app data | Processor |
| Supervisory authority, courts | Only when the law requires it | — |

No sale, no advertising, no transfers to other third parties. Organizers have no export of member data.

## 4. Transfers outside the EEA

| Processor | Where | Safeguard (to confirm in the DPA, see `docs/PROCESSORS_CHECKLIST.md`) |
|---|---|---|
| Supabase | The region chosen for the project (should be an EU region, e.g. Frankfurt). Supabase Inc. and some sub-processors are in the US (support, monitoring). | Supabase DPA with standard contractual clauses |
| Expo (650 Industries, US) | US | Expo DPA / SCCs, or EU-US Data Privacy Framework if certified |
| Google (FCM) | Global | Google's data processing terms with SCCs; Google is certified under the EU-US Data Privacy Framework |
| Web host | Global CDN | Provider DPA / SCCs |

Members can avoid the push transfer entirely by not enabling push.

## 5. Technical and organizational security measures (Art. 32)

- Row-level security on every table the app can read (`public` schema); select-only policies; no table can be written directly by the app.
- Every change goes through `security definer` database functions with `search_path` pinned, explicit grants to exactly one role, server-side authorization from `auth.uid()`, row locks for counts and capacity.
- Sensitive data (About you, workout logs, export log, retention data) lives in the `private` schema, which no API role can reach; only functions acting for the data owner read it. Organizers never see an individual workout log or an individual birth year / gender.
- Small-group protection: demographic and workout totals published only above 20 contributors, rounded, with complementary suppression (known limits in `docs/STATS_DEFINITIONS.md`).
- Transport encryption (HTTPS / TLS) to Supabase, Expo and the web host; encryption at rest by Supabase.
- No service-role key or database password in the app or in the repository; `.env.local` is gitignored.
- Rate limits (invitation code guessing, exports, organizer posts), text hygiene on free text, audit log for attendance changes.
- Session kept in the device's secure storage where available.
- Data minimization: anonymous accounts, no e-mail, no analytics SDK; notification texts never contain workout data or emergency contact details.
- Tested: integration tests on a real Postgres prove the authorization matrix, consent gates, export completeness and erasure (`supabase/tests/`).
- Owner measures (to do): 2FA on Supabase, Expo, Google, GitHub and the web host accounts; strong unique passwords in a password manager; least people with dashboard access; breach procedure `docs/BREACH_RUNBOOK.md`.

## 6. Data subject rights: how they are handled

| Right | How |
|---|---|
| Information | Privacy notice in the app and on the public web page |
| Access, portability | Profile → Privacy → Download my data (`export_my_data`, JSON) |
| Rectification | Display name, About you, workout logs editable in the app; attendance: ask the organizer |
| Erasure | Profile → Privacy → Delete my account (`delete_my_account` → `private.erase_user`) |
| Withdraw consent | Profile → Privacy, one switch per purpose; withdrawal deletes the covered data |
| Objection / restriction | E-mail to `[PRIVACY EMAIL]`; see section 9 |
| Complaint | ANSPDCP |

## 7. Retention register (table by table)

Every table in the `public` and `private` schemas. "Erasure" means `private.erase_user` (Delete my account and, when enabled, the inactivity clean-up). Times of daily jobs can be exceeded by up to one day (the jobs run once a day).

| Table | Personal data | Retention | Job / path |
|---|---|---|---|
| `auth.users` (Supabase Auth) | Account id, anonymous flag, created / last sign-in | Until erasure; inactive anonymous accounts: 24 months + 30-day notice **when the owner enables it** | `delete_my_account`; `run_account_retention` (daily 03:41 UTC, disabled by default) |
| `public.profiles` | Display name | Until erasure | erasure (deleted) |
| `public.memberships` | Membership, role, status | Until erasure (a removed or departed member's row stays as history) | erasure (deleted) |
| `public.communities` | Community name (not personal) | While it has members; deleted with its last active member's erasure | erasure (cascade) |
| `public.invitation_codes` | Creator id | Codes stay; creator removed on erasure | erasure (`created_by` null) |
| `public.invitation_redemptions` | Who redeemed which code | Until erasure | erasure (deleted) |
| `public.invitation_attempts` | Code attempts per user | 24 hours | `purge_old_notification_data` (daily 03:17 UTC) via `private.purge_old_invitation_attempts` |
| `public.community_creator_codes` | Creator id | Codes stay; creator removed on erasure | erasure (`created_by` null) |
| `public.community_creator_redemptions` | Who created a community with a code | Until erasure | erasure (deleted) |
| `public.training_sessions` | Organizer / canceller / finalizer ids, event details | Kept as community history; deleted with the community | erasure (author ids null) |
| `public.training_rsvps` | RSVP answers | Until erasure | erasure (deleted) |
| `public.attendance_records` | Attendance of a member, recorder | Kept as community history; anonymized on erasure | erasure (`user_id`, `recorded_by` null) — **owner decision: cap at N years?** |
| `public.attendance_audit_log` | Attendance changes, organizer note | Kept as community history; anonymized and note removed on erasure | erasure (ids and `reason` null) — same owner decision |
| `public.announcements` | Author id, text | Kept while the community exists; author removed on erasure | erasure (`author_id` null) |
| `public.announcement_reads` | Read markers | Until erasure | erasure (deleted) |
| `public.event_posts` | Author id, post / reply text | Kept while the event exists; a deleted post loses its text at once; on erasure replies are deleted, top-level posts lose the author | `delete_event_post` (soft delete), erasure |
| `public.event_feed_reads` | Read markers | Until erasure | erasure (deleted) |
| `public.notifications` | In-app notifications | Read: 90 days; unread: 180 days; erasure | `purge_old_notification_data` (daily), erasure |
| `public.notification_delivery_jobs` | Push delivery status per notification | Finished: 30 days; stale: expiry + 3 days; with their notification | `purge_old_notification_data` (daily) |
| `public.device_push_tokens` | Push token, platform, device label | Invalid: 30 days after invalidation; not re-registered: 270 days; at once on push-consent withdrawal, sign-out (best effort) and erasure | `purge_old_notification_data` via `private.purge_stale_push_tokens`, `withdraw_consent`, erasure |
| `public.notification_preferences` | Push settings | Until erasure | erasure (deleted) |
| `public.consent_records` | Consent ledger | For the life of the account (proof of consent); append-only | erasure (cascade from `auth.users`) |
| `public.legal_documents` | None (versions of the texts) | Permanent | — |
| `public.activity_types` | None (lookup) | Permanent | — |
| `public.event_subtypes` | None (lookup) | Permanent | — |
| `private.member_about_you` | Birth year, gender, emergency contact, T-shirt size | Until cleared, consent withdrawn, or erasure | `clear_my_about_you`, `withdraw_consent`, erasure |
| `private.workout_logs` | Workout logs (special category) | Until deleted, consent withdrawn, or erasure | `delete_my_workout_log`, `withdraw_consent('workout_logs')`, erasure |
| `private.workout_prompt_runs` | None (event id and time) | With the event | cascade |
| `private.data_export_log` | Export request times | 1 hour (about a day with the daily job) | `purge_old_notification_data` via `private.purge_old_data_export_log`, the next export, erasure |
| `private.account_activity` | Last app open (hourly resolution), inactivity notice | Until erasure | erasure (cascade from `auth.users`); notice ended by any activity |
| `private.retention_settings` | None (the kill switch) | Permanent | — |
| `private.retention_runs` | None (counts only) | 2 years | `run_account_retention` |
| `private.dispatch_ping` | None (single timestamp) | Permanent | — |

Outside the app tables (processor-managed, not covered by the jobs above):

| Where | Personal data | Retention | Owner action |
|---|---|---|---|
| Supabase Auth internal tables (`auth.sessions`, `auth.refresh_tokens`, `auth.identities`, MFA) | Session ids, IP address, user agent | Deleted with the auth user (cascade) | Verify after the first hosted deletion (see `docs/API_CONTRACT.md`, hosted note) |
| Supabase `auth.audit_log_entries` | User id, IP, action | Not linked by a foreign key: **not removed by erasure** | Check in the dashboard whether the Auth audit log is written to the database; if so, decide a retention and purge it (SQL editor) or disable it (Auth settings) |
| Supabase platform logs (API, Postgres, Auth, Edge Functions) | IP, user agent, request paths, user ids in JWTs | Per plan (check: short on Free, longer on paid plans) | Note the number in the notice ("technical data") |
| Supabase backups | Everything | Per plan (daily backups, point-in-time recovery if enabled) | An erased account disappears from backups when they expire; say so if asked |
| Expo push service | Push token, notification text, receipts | Expo's own retention (short-lived receipts) | Read Expo's DPA |
| Google FCM | Token, message | Google's own retention | Read Google's terms |
| Web host | Visitor IP, request logs | Host's own retention | Read the host's DPA |

## 8. Inactive accounts (G3)

- Rule (only when enabled): an anonymous account with no activity for 24 months gets a notice; any activity within 30 days ends it; otherwise the account is erased exactly like Delete my account. Activity signals and their limits: `docs/API_CONTRACT.md`, "Retention (G3)".
- Disabled by default. The owner enables it deliberately with `select public.admin_set_retention_enabled(true);` (SQL editor or service role) after (1) the app version that calls `record_app_open` and shows the banner has been in use, (2) the privacy notice says so (see `docs/CLAIMS_AUDIT.md`), (3) a look at `select public.retention_preview();`.
- The last organizer of a community that still has active members is never erased automatically (counted as blocked); handle these by hand.

## 9. Procedures

**Request by e-mail (access, erasure, objection, restriction).** Accounts are anonymous: act only when the person proves control of the account, for example by doing the action in the app themselves (export, delete), or by showing a code you ask them to create in the app. Answer within one month (extendable by two months for complex requests, with a reason). Keep a short log: date received, what was asked, how identity was checked, what was done, date answered (no copies of the data).

**Operator erasure of one account** (under-16 account, verified request the member cannot do in the app): find the user id with the member's help (it is in their export file, `account.user_id`), then in the Supabase SQL editor: `select private.erase_user('<user id>');`. It refuses with `last_organizer` while the account is the last organizer of a community with other members (promote someone first). Note it in the log.

**Objection to attendance history.** The member asks the organizer to correct or remove records, or deletes the account (attendance then stays only anonymously).

**Review.** Update this record when a feature adds data, when a processor changes, and at least once a year.
