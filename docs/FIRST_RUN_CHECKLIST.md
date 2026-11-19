# TrainHive — first real test session (checklist)

Everything built since your last APK (consents, account export/deletion, Members screen, Events, bell and Home feed, quick invite) has only been checked by automated tests, a few stand-in browser runs and code reviews. This session is the first time it meets your real Supabase project and real phones. Expect to find problems; write them down and send them to me.

Order matters: **new app first, database migrations after.** (The new database rules refuse joins from app versions that don't record consent.)

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

## B. Apply the database migrations (after the new APK is installed)

4. In the project folder:
   ```bash
   npx supabase@latest db push --remote
   ```
   It lists the pending migrations (the newest ones are `20261123…` to `20261127…`: consents, member roles, data rights, GDPR fixes, events, text hygiene). Confirm. If it fails, paste the error to me and do not retry blindly.
5. Check: `npx supabase@latest migration list --remote` should show every row with a Remote value.

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
