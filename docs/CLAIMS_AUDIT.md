# TrainHive — Claims audit of the privacy notice and the terms

**2026-11-23, phase G3.** Every factual claim in `src/features/legal/content/privacy.ts` and `terms.ts`, rendered with the shipped flags (`src/features/legal/constants.ts`: `demographics`, `emergencyContact`, `workoutLogs` true; `eventPosts` **false when this audit was run, true since 2026-11-23: see section 2b**), checked against what the code and the migrations (through `20261202000100_retention.sql`) really do. Legal texts are version 2 (`PRIVACY_VERSION`, `TERMS_VERSION`), `LEGAL_REVIEWED = false`.

Status: **OK** = the code does what the text says (evidence named); **GAP** = the text is wrong, incomplete or will become wrong; **OWNER** = true only once the owner does something outside the code. Evidence is "file / function" (migrations in `supabase/migrations/`, tests in `supabase/tests/`).

## 1. Privacy notice

| # | Claim (shortened) | Evidence | Status |
|---|---|---|---|
| P1 | Controller name, address, privacy contact shown | `src/features/legal/config.ts` from `EXPO_PUBLIC_CONTROLLER_*`; EAS `preview` holds placeholders | OWNER (replace placeholders, `docs/GO_LIVE.md` 35b) |
| P2 | Organizers are users, bound by the terms to use data only for the community | terms "Organizers" | OK |
| P3 | Anonymous account, membership, role (contract) | `memberships`, `auth.users` anonymous sign-in (`src/features/community/api/session.ts`) | OK |
| P4 | Display name so members recognize each other; nickname allowed | `profiles.display_name`, `update_display_name` | OK |
| P5 | RSVP, attendance, change history; legitimate interest; right to object | `training_rsvps`, `attendance_records`, `attendance_audit_log` | OK (objection is a manual e-mail process, `docs/RECORD_OF_PROCESSING.md` section 9) |
| P6 | "Announcements organizers publish" is the only communication content described | **Event discussions ship**: `20261129000100_event_feed.sql` (`event_posts`, replies by members, push kinds `event_post` / `event_reply`), app `src/features/eventFeed/`, `DiscussionEntry` rendered **unconditionally** on the event details (`src/app/(app)/trainings/[id].tsx`), route `events/[id]/feed`, Realtime hook in `src/app/(app)/_layout.tsx` | **GAP (high)** — see section 3 |
| P7 | Push needs consent and OS permission; in-app notifications are the service | `claim_notification_jobs` checks `push_notifications` consent at send time (`20261125000100_gdpr_qa_fixes.sql`), `register_push_token` consent gate | OK |
| P8 | Birth year and gender optional, explicit consent, approximate totals, kept until withdrawn / cleared / deleted | `20261130000100_about_you.sql` (`save_my_about_you` consent gate, `withdraw_consent` deletes, `get_community_demographics` 20 floor + rounding to 5 + suppression), `about-you.test.ts`, `about-you-qa.test.ts` | OK |
| P9 | Emergency contact and T-shirt size optional, consent, organizers lose sight when the member leaves | `get_member_emergency_info` / `list_community_emergency_info` check active membership at read time; `about-you.test.ts` (leave / remove / demote) | OK |
| P10 | Workout logs optional, explicit consent, special category, kept until deleted / withdrawn / account deleted | `20261201000100_workout_logs.sql` (`save_workout_log` consent gate, `withdraw_consent('workout_logs')` deletes all, `erase_user`), `workout-logs.test.ts` | OK |
| P11 | Technical data held by providers (IP, logs), legitimate interest | Supabase / Expo / Google / web host logs | OK, but retention not stated — **GAP (low)**: add "kept by the providers for a short time according to their settings" once the plan's numbers are known (`docs/RECORD_OF_PROCESSING.md` section 7) |
| P12 | No location, contacts, advertising ids, payments, children's data | No such permissions or SDKs in `package.json`; age gate | OK |
| P13 | Members see display name and "going" on event pages | `training_rsvps` select policy, Participants list | OK |
| P14 | Organizers can change roles, remove members; removal final; history stays | `set_member_role`, `remove_member`, `redeem_invitation` refuses removed members (`invalid_code`) | OK |
| P15 | Organizers see membership, RSVPs, attendance | RLS policies, attendance RPCs | OK |
| P16 | Emergency contact visible to organizers of your communities only | as P9 | OK |
| P17 | Demographics: never individually, rounded to 5, only after 20 answers, small groups hidden, differencing caveat | as P8; caveat matches the documented known limit | OK |
| P18 | Workout logs private; totals only with 20 contributors, rounded; only active, consenting members count | `get_community_workout_stats` (20 floor, nested windows, rounding), `qa-workout-logs.test.ts`; logs exist only with consent (withdrawal deletes) | OK |
| P19 | No sale, no advertising | No such code | OK |
| P20 | Processors: Supabase (all data), Expo and Google FCM (token + notification text), web host | Architecture; dispatcher Edge Function `supabase/functions/dispatch-notifications` | OK; web host unnamed — **GAP (low)**: name Netlify or Cloudflare Pages once chosen; DPAs **OWNER** (`docs/PROCESSORS_CHECKLIST.md`) |
| P21 | Notification texts never contain workout data or emergency contacts | Workout prompt: "How did it go?" / "Log your workout: <event title>" (`enqueue_workout_log_prompts`); no notification reads `member_about_you` | OK. Note: event-post pushes carry up to 200 characters of the post text (`20261129000100_event_feed.sql`, preview helper); the terms ask authors to keep health details out of posts |
| P22 | Transfers outside the EEA: Expo and Google; avoidable by keeping push off | Push only with consent | OK for push. **OWNER**: confirm the Supabase project region is in the EU; if not, this section is incomplete |
| P23 | In-app notifications deleted after 90 days (read) / 180 days (unread) | `purge_old_notification_data` (daily 03:17 UTC) | OK (up to one day later, daily job) |
| P24 | Failed code attempts deleted after 24 hours | `private.purge_old_invitation_attempts` deletes rows older than 24 h, run once a day | **GAP (low)**: effective maximum is about 48 hours. Say "after about a day (at most two)" or run the purge more often |
| P25 | Push tokens deleted when push is turned off, on account deletion, and within 30 days when a device stops working | `withdraw_consent('push_notifications')` deletes all tokens; erasure; `private.purge_stale_push_tokens` (30 days after invalidation, 270 days unused) | OK for the Privacy switch. **GAP (low)**: the "Push notifications" toggle in notification settings (`set_notification_preferences(push_enabled=false)`) keeps the tokens (pushes are skipped); the 270-day purge of unused tokens is not mentioned (under-claim). Clarify "when you withdraw the push consent in Privacy" |
| P26 | Account data kept until you delete your account | True today: the inactivity clean-up is **disabled by default** (`private.retention_settings`) | OK now. **GAP (conditional)**: before the owner runs `admin_set_retention_enabled(true)`, the notice must describe it (text in section 3) |
| P27 | On deletion attendance counts and change history stay without name or id | `private.erase_user` (`user_id` / `recorded_by` / `changed_by` null, audit `reason` null), `account-deletion.test.ts` | OK |
| P28 | Consent records kept as proof for the life of the account | `consent_records` append-only guard; cascade on `auth.users` delete | OK |
| P29 | Rights list (access, rectification, erasure, restriction, objection, portability, withdrawal) | Export, edit screens, delete, Privacy switches; restriction / objection by e-mail | OK (manual parts documented in `docs/RECORD_OF_PROCESSING.md` section 9) |
| P30 | Each optional consent has its own switch; effective at once | `withdraw_consent` per purpose, Privacy settings screen | OK |
| P31 | Download my data, up to 10 times per hour | `export_my_data` rate limit 10/h (`data-export.test.ts`) | OK |
| P32 | Delete my account deletes "profile, memberships, RSVPs, notifications, push devices and consent records"; announcements stay unlinked; only-member community deleted; last organizer must hand over | `private.erase_user` (latest copy in `20261201000100_workout_logs.sql`), `my_deletion_blockers` | OK but incomplete: it also deletes About you, workout logs, read markers, redemptions, export log, account activity (under-claim, **GAP low**); event replies are deleted and event posts stay without author (**GAP**, part of P6) |
| P33 | Leaving keeps attendance history until account deletion | `leave_community` | OK |
| P34 | Restriction / objection by e-mail with proof of account control; answer within a month | Manual process | OWNER (procedure in `docs/RECORD_OF_PROCESSING.md` section 9) |
| P35 | Complaint to ANSPDCP | Text | OK |
| P36 | "Every data table is protected by row-level security" | All `public` tables have RLS with select-only policies (`qa-privileges.test.ts`, `rls.test.ts`). `private` tables (About you, workout logs, export log, retention) have no RLS but no API role can reach the schema at all | OK in effect; **GAP (wording, low)**: "every table the app can read is protected by row-level security; the most sensitive tables cannot be reached by the app at all" |
| P37 | All changes through server functions that check permissions | Every table select-only for `authenticated`; all writes via `security definer` RPCs (`qa-privileges.test.ts`) | OK |
| P38 | Encrypted in transit; no administrator keys in the app | HTTPS Supabase URL; only the anon key in `EXPO_PUBLIC_*` | OK |
| P39 | Attendance audit log; code guessing limited | `attendance_audit_log`; invitation attempt rate limit | OK |
| P40 | Session in secure storage where available | `expo-secure-store` dependency, session storage in `src/lib/` | OK (not re-verified on a device) |
| P41 | Breach: authority and people notified as the law requires | `docs/BREACH_RUNBOOK.md` (new) | OWNER (keep contacts filled in) |
| P42 | 16+; account of a younger person deleted when known | Age gate (`age_16` consent required to join); operator erasure procedure `select private.erase_user('<id>')` (`docs/RECORD_OF_PROCESSING.md` section 9) | OK (procedure now documented) |
| P43 | Anonymous accounts; created when you first enter an invitation code; lost with the device | `ensureSession()` signs in anonymously when a code is submitted (`src/features/onboarding/api/invitations.ts`) | OK |
| P44 | No analytics, advertising or tracking | No such SDKs in `package.json`; Firebase Analytics must stay off in the Firebase project | OK; OWNER check in Firebase (`docs/PROCESSORS_CHECKLIST.md` 3) |
| P45 | Web: session and settings in local storage, no tracking cookies | `@react-native-async-storage/async-storage` (localStorage on web) | OK (web host cookies not reviewed) |
| P46 | Changes to the notice: new version must be confirmed before joining another community | `legal_documents`, consent gates on join (`consent-gates.test.ts`) | OK |

## 2. Terms of use

| # | Claim | Evidence | Status |
|---|---|---|---|
| T1 | Service: plan events, answer invitations, record attendance and "share announcements" | Event discussions also ship (P6) | **GAP** (flag `eventPosts` switches it to "talk to each other") |
| T2 | 16+; join with a code; several communities; tick box accepts terms; anonymous account | Gates, `list_my_communities` | OK |
| T3 | Acceptable use (no guessing codes, no automated collection) | Rate limits | OK |
| T4 | Organizers' duties, emergency contact only for safety and race kits | Contractual; the app offers "Copy list / Share" of the emergency list (`src/features/members/`) | OK (contract); residual risk in `docs/DPIA_DRAFT.md` R10 |
| T5 | "You are responsible for the announcements you write"; organizers may cancel an unsent announcement | `cancel_announcement`; posts and replies exist too | **GAP** (part of P6: with the flag on the text says "posts and replies") |
| T6 | Availability; notifications may be late | Text | OK |
| T7 | Delete account in the app, leave a community; removal final | `delete_my_account`, `leave_community`, `remove_member` | OK |
| T8 | Changes need confirmation before joining another community | as P46 | OK |
| T9 | Romanian law | Text | OK (lawyer review) |

## 2b. Follow-up (2026-11-23, mobile task after G3)

- **Gap A fixed:** `FEATURES.eventPosts` is now `true`; the privacy notice and the terms describe event discussions (who writes, who sees, deletion, what stays when a member leaves, what account deletion does, the 200-character push preview on the lock screen). P6, T1 and T5 are now OK. The legal version stays **2** (version 2 was never published to the hosted server; it now covers About you, workout logs and event discussions). Tests: `qa-gdprCopy.test.ts` (Q7-7 now also ties the event text to the migrations: preview length 200, replies deleted and posts de-authored in `erase_user`) and `content/content.test.ts`.
- **Gap B, app side done:** `record_app_open()` is called when the signed-in area starts and on every return to the foreground (at most once an hour on the client; `src/features/retention/`), and a pending notice shows once as a dismissible banner on Home. The notice text below is still **not** published and the server clean-up stays **disabled**.
- **Gap C fixed (copy):** P24 (24 hours, up to about two days), P25 (what the notification switch does vs withdrawing consent, 270 days unused), P32 (full list of what deletion removes and what stays), P36 (RLS wording), P11 / P20 (hosting providers keep technical logs for a limited time, no vendor named). The export summary names the new `account_activity` part as "your app activity record".

## 2c. Account recovery by email (2026-11-24)

`FEATURES.accountLinking = true`; the notice (data inventory "Email address (optional)", who sees, processors, retention, rights, anonymous accounts, web) and the terms (using TrainHive) describe the optional email. The legal version stays 2 (never published). Each claim and its evidence:

| # | Claim | Evidence | Status |
|---|---|---|---|
| E1 | The email is optional; nothing changes without it | `SecureAccountSection` (only for anonymous sessions), welcome sign-in is a secondary action; anonymous sign-in unchanged (`community/api/session.ts`) | OK |
| E2 | Used only to sign in again and to send sign-in codes | `src/features/account/api/emailAuth.ts` calls only `updateUser({ email })`, `resend`, `verifyOtp`, `signInWithOtp`; no other use of the address in the app | OK |
| E3 | Held by the authentication provider, not copied into TrainHive data, never shown to members or organizers | Migrations never read `auth.users.email` (tripwire in `qa-gdprCopy.test.ts`, "Q7-7 ... accountLinking"); the export contains `account: { user_id, created_at, is_anonymous }` only | OK; **GAP (low): the data export does not include the email** (it is not in `export_my_data`; a backend change would add `auth.users.email` to `account`) |
| E4 | Kept until the account is deleted, and deleted with it | `private.erase_user` ends with `delete from auth.users`; the Edge Function fallback also calls `auth.admin.deleteUser` | OK; verify on the hosted project once with a linked throwaway account (`docs/ACCOUNT_RECOVERY_SETUP.md`, test 6) |
| E5 | No separate "remove email" | auth-js `unlinkIdentity` fails for a user's only identity (`single_identity_not_deletable`); no clean API | OK (stated in the notice) |
| E6 | Consent basis: adding the address | The form states it above the button (`SecureAccountSection`) | OK, lawyer to confirm the basis (consent vs contract) |
| E7 | Codes are sent by the processor | Supabase built-in sender or the owner's SMTP provider | **OWNER**: a custom SMTP provider is a further processor: name it in the notice and sign its DPA (`docs/PROCESSORS_CHECKLIST.md`) before production |
| E8 | The inactivity clean-up never erases a linked account | `retention.sql`: `where u.is_anonymous` (also asserted in the tripwire) | OK |

## 3. Gaps and exactly what to change

### Gap A (high): event discussions are live but not described

The event feed (organizer posts, member replies, push notifications with a post preview) is in the app with no feature-flag gate, while `FEATURES.eventPosts` is `false`, so the notice and the terms say nothing about posts and replies. **Decision recorded here:** the notice must describe event posts and replies **before** members use them. `FEATURES.eventPosts` was **not** changed by this task. Two ways, the owner (or the lead) picks one before the next build that reaches real members:

1. **Describe it (recommended, the feature is built and tested):**
   - `src/features/legal/constants.ts`: `eventPosts: true`.
   - `src/features/legal/content/privacy.ts` — the flag already switches "What we collect" (label "Announcements, posts and replies in event discussions"), the retention line ("posts") and the terms (T1, T5). Add, under `features.eventPosts`:
     - "Who can see your data": *"Members of a community see the posts and replies in its event discussions, with the author's display name. Organizers can delete any post or reply; you can delete your own replies."*
     - "How long we keep data": *"Event discussions: posts and replies stay as long as the event exists. A deleted post or reply keeps no text. New posts and replies are possible until 30 days after the event."*
     - "Delete your account" bullet: append *"Your replies in event discussions are deleted. Posts you wrote as an organizer stay visible without your name."*
     - "Companies that process data for us": append *"A push notification about a new post or reply contains the first 200 characters of its text."*
   - Bump `PRIVACY_VERSION` and `TERMS_VERSION` to `'3'` and `LEGAL_LAST_UPDATED`; after deploying the build run `select public.admin_set_legal_version('terms','3'), public.admin_set_legal_version('privacy','3');` (every member reconfirms once), and regenerate the web pages (`npm run legal:build`).
   - Tests to update with it: `src/features/legal/qa-gdprCopy.test.ts` (it asserts `eventPosts: false` and "no event discussions"; turn it into "mentioned exactly when the flag is on and `public.event_posts` exists in the migrations", like the other items) and `src/features/legal/content/content.test.ts` (`SHIPPED`).
2. **Hide it until the text is approved:** render `DiscussionEntry` (`src/app/(app)/trainings/[id].tsx`), the route `src/app/(app)/events/[id]/feed.tsx`, the Realtime hook and the notification deep links only when `FEATURES.eventPosts` is true. The backend can stay deployed: without a screen nobody posts, so no post data and no post notifications are created.

### Gap B (conditional, before enabling inactivity clean-up) — TO PUBLISH BEFORE ENABLING

**Status 2026-11-23:** app side done (see section 2b); the text below is not in the notice yet because the clean-up is disabled. Publishing it needs a legal version bump (3) and the steps in this section.

Add to "How long we keep data" (and enable only after this text is published): *"Accounts that are not used: if an account shows no activity for 24 months (no app opens, answers, attendance, posts or logs), we may schedule it for deletion. If you open the app within 30 days, the deletion is cancelled and you see a message. Otherwise the account is deleted exactly as with Delete my account."* The app must call `record_app_open()` on start and on return to the foreground and show `notice` once (mobile task; contract in `docs/API_CONTRACT.md` "Retention (G3)").

### Gap C (low): wording

- P24: "after 24 hours" → "after about a day (at most two days)".
- P25: "when you turn push notifications off" → "when you withdraw the push consent (Profile, then Privacy)"; optionally add "and when a device has not used the app for 9 months".
- P32: list the optional data deleted with the account ("About you details, workout logs").
- P36: rephrase the RLS sentence as suggested.
- P11 / P20: name the web host; state provider log retention once known.

### Owner items (not code)

Controller details (P1), DPAs and Supabase region (P20, P22), Firebase Analytics off (P44), e-mail request procedure (P34), breach contacts (P41), lawyer review (`LEGAL_REVIEWED`).

### Gap D (RESOLVED 2026-11-24): anonymous comments and nicknames

Migration `20261204000100_anonymous_comments.sql` lets members write their own comments and post comments and replies anonymously, shown with a per-event nickname. **Resolved in the app change that ships the feature:** `privacy.ts` (inventory row "Announcements, posts, comments and replies in event discussions", who-sees bullet, push paragraph, retention bullet, account-deletion list) and `terms.ts` ("What you post": no harassment, anonymity does not protect from removal, the author is still stored) now state every fact below. Tripwire: `qa-gdprCopy.test.ts` "Q7-7: the anonymous-comment text matches the migration" (private tables and revokes, nickname key per event, `anonymous_not_allowed`, 10 per hour, erase statements, "operator can technically see", no "fully anonymous"); `content.test.ts` event text. Legal version stays 2 (never published to the hosted server). Facts the notice and terms match:
- Anonymous means hidden **in the app**: other members and organizers see only the nickname. The author is still stored internally (`private.event_post_anonymous_authors`, `private.event_aliases`) for the author's own delete, export, erasure and the spam limit, and is visible to whoever has database access (the operator). Do not claim "fully anonymous" or "not even we can see it".
- Organizers cannot post anonymously and can delete any comment (moderation by content).
- Comments notify nobody; a reply notifies the author of the item replied to, quoting the replier's name or nickname and up to 200 characters.
- Account deletion deletes comments and replies (anonymous ones too), the nicknames and the replies of others under a deleted comment; organizer posts stay without the name. The notice says exactly this.
- The export lists your anonymous items, flagged, with your nickname per event.

## 4. How to keep this audit true

Re-run it whenever a migration adds personal data, a `FEATURES` flag changes, or the legal texts change. The register test (`supabase/tests/retention.test.ts`, "retention register") fails when a new table is not listed in `docs/RECORD_OF_PROCESSING.md`.
