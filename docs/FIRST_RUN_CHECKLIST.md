# TrainHive — first real test session (checklist)

Everything built since your last APK (consents, account export/deletion, Members screen, Events, bell and Home feed, quick invite) has only been checked by automated tests, a few stand-in browser runs and code reviews. This session is the first time it meets your real Supabase project and real phones. Expect to find problems; write them down and send them to me.

Order matters: **new app first, database migrations after** (section B has the exact order). The new database rules refuse joins from app versions that do not record consent.

## A. Prepare (about 15 minutes of work, plus the build wait)

1. **Legal settings for the Android build.** In the project folder, one command per variable (replace the values with your own; they are shown publicly in the app):
   ```bash
   npx eas-cli@latest env:create --name EXPO_PUBLIC_CONTROLLER_NAME --value "YOUR NAME" --environment preview --visibility plaintext
   ```
   ```bash
   npx eas-cli@latest env:create --name EXPO_PUBLIC_CONTROLLER_ADDRESS --value "YOUR ADDRESS" --environment preview --visibility plaintext
   ```
   ```bash
   npx eas-cli@latest env:create --name EXPO_PUBLIC_PRIVACY_EMAIL --value "YOUR PRIVACY EMAIL" --environment preview --visibility plaintext
   ```
   If a variable already exists, EAS says so; use `npx eas-cli@latest env:update` or delete and recreate it. Before this step, decide whether to use a dedicated privacy email and a non-home address (see `docs/GO_LIVE.md` item 35a).
2. **Build the APK** (about 15–20 minutes after the queue):
   ```bash
   npx eas-cli@latest build --platform android --profile preview
   ```
3. **Install it** on both phones from the link the build prints. Uninstalling the old app first is optional; keeping it keeps the test accounts.

## B. Order for the owner (updated 2026-11-23)

The new APK must be installed before the database is changed (the new rules refuse joins from older app versions). Exactly this order:

1. **Set the EAS legal variables** (section A step 1: name, address, privacy email, environment `preview`).
2. **Build the APK** (section A step 2) and **install it on both phones** (step 3).
3. **Then apply the migrations:**
   ```bash
   npx supabase@latest db push --remote
   ```
   Pending migrations, in order: `20261129000100` event feed, `20261130000100` about you, `20261201000100` workout logs, `20261202000100` retention, `20261203000100` invitation duration and deletion fallback support, `20261204000100` anonymous comments, `20261205000100` personal records (earlier ones may also be listed if not applied yet). Confirm. If it fails, paste the error to me and do not retry blindly. Check afterwards with `npx supabase@latest migration list --remote` (every row has a Remote value).
4. **Then publish the legal version** (the build bundles privacy and terms version 2; the server still holds 1). Run once in the Supabase SQL editor:
   ```sql
   select public.admin_set_legal_version('terms','2'), public.admin_set_legal_version('privacy','2');
   ```
   Until then new joins from this build are refused as "app update required"; afterwards every existing member sees "We updated our terms" once. Do not run it before the new build is on every phone you want to keep working. Version 2 now also describes event discussions, workout logs and About you.
5. **Retention stays disabled.** Do not run `admin_set_retention_enabled(true)`: the privacy notice does not describe the inactivity clean-up yet (`docs/CLAIMS_AUDIT.md`, gap B).

## C. Test script (two phones: A = organizer, B = member; optionally a browser as C)

The full numbered script is in `docs/QA_REPORT.md` (steps 1–126). The shortest meaningful path:

1. **Phone A, first launch:** the "Before you start" screen appears (two unticked boxes). Tick both. Create your community with a creator code (or join with the organizer code if it is still unused). The privacy notice opens from the screen and shows your name, address and email (not `[TO BE FILLED]`).
2. **Existing test accounts** (if you kept the old app data): you see "We updated our terms and privacy notice". Accept. You can also try Download my data there without accepting.
3. **Home:** the bell is at the top-right; the tabs are Home, Events, Statistics, Profile. As organizer you see the round **Invite** button bottom-right; as a member you don't.
4. **Invite:** tap Invite → a code appears with Copy message / Share / Copy code only. On phone B join with it (consent screen first).
5. **Events:** create one event of each kind (Training with a minimum, Race with distance and D+, Sports event, Social event). Check the cards show the kind and course facts. On B RSVP to each: the training shows the minimum progress; the race and social event show "Registration open" and never auto-cancel.
6. **Deadline:** create a training with a deadline 3–4 minutes away and a minimum of 2. With B going and A going it becomes Confirmed; try another with minimum 5 and it becomes Cancelled — without opening the app.
7. **Push:** with B's app closed, A publishes an announcement and creates an event: B gets notifications within a few seconds; tapping opens the right screen. In B's Profile → Privacy, switch push off and confirm no more pushes arrive; switch on again.
8. **Attendance:** make an event whose end has passed (edit the start into the past for a quick test), record attendance on A, finalize; B sees the outcome; Statistics shows the numbers.
9. **Members:** Profile → Members on A: promote B to organizer, demote, remove a test member. Leave community from B.
10. **Privacy:** on B: Download my data (a file is produced), then Delete my account (try it once while B is the last organizer of a community to see the block, then as a plain member). Check the account really disappears: B cannot sign in again with the old data, and the Supabase table `auth.users` no longer has the row.
11. **Web:** `npm run build:web` (with the legal variables set) and open the web app; join with a code via `/join#code=…`.

## D. What to send me

For every problem: the screen, what you tapped, the exact text of any error, and for server errors the `Detail:` line (development builds) or the Supabase log line. A screenshot is enough. If something looks right but feels wrong (confusing wording, hard to find, ugly), send that too: this is the best time for product feedback.

## E. If something goes badly wrong

- **Joins are refused after the migrations** (`consent_required`): the phone has the old app; install the new APK.
- **Pushes stop for old members:** they have not accepted the new push consent yet; open the app and enable notifications once.
- **`db push` partly applied:** do not re-run migrations by hand; paste the output and I'll tell you how to continue.
- **Deleting an account fails on the hosted project:** the plan has a fallback (an Edge Function with the admin API), documented in `docs/API_CONTRACT.md` ("GDPR G2"); tell me and I'll build it.

## F. Test script additions for the newest features

Run these after section C. A = organizer, B = member.

1. **Communications tab:** a badge shows unread announcements and event discussions; opening the tab and the items clears it.
2. **Push opt-in box:** shown on the first screen after B answers an RSVP; try "Not now" and then turning it on from Profile, Privacy.
3. **Cancellation reason:** A cancels an event with a reason; B sees the reason on the event and in the notification.
4. **Attendance Copy list:** on the attendance screen A uses Copy list and pastes it somewhere to check names and statuses.
5. **About you:** Profile, About you on B: save a birth year, gender, emergency contact and T-shirt size (consent switches in Profile, Privacy). On A open Members: the emergency contact and T-shirt size of B are visible to the organizer, the birth year and gender are not (only group totals once 20 members answered, so A will see "not enough yet"). Withdraw the consent on B: the data disappears for A.
6. **Event feed:** on an event, A writes a post; B (going) gets a push whose text starts with the first part of the post; B replies; A gets a reply notification. A deletes a post (no text remains), B deletes their own reply. Open the notification: it lands on the discussion.
7. **Workout log and My workouts:** after an event B took part in, B saves a workout log from the prompt or the event; Profile, My workouts lists it with stats; edit and delete one.
8. **Community workout totals:** they only appear with at least 20 contributors, so A will see "not enough yet" on the test community. That is correct.
9. **Download my data** on B: the summary names the new parts (About you, workout logs, app activity record).
10. **Retention:** nothing visible should happen (disabled). Opening the app only records the last open; no banner appears.

11. **Secure your account (one-time page):** a brand-new member (join with a code, or create a community) first sees a full page "Secure your account" with the email field and "Skip for now"; after Skip or Continue the "About you" page follows (never the other way round), then Home. Close and reopen the app: neither page comes back. Try the email flow once on a throwaway address (code, then "Account secured with ..." and Continue). Someone who signs in with an existing email ("I already have an account") sees no Secure page. Sign out and join again: both pages appear again (their notes are cleared). Needs the email setup in docs/ACCOUNT_RECOVERY_SETUP.md; without it the code step shows a friendly error and Skip still works.
