# TrainHive — Steps to go live

Tick items off as you go. "Owner" means you (the person with the accounts); "Claude" means work I can do in this repository. Nothing below has been done yet unless marked.

Status today: all four milestones are built and tested locally (2003 automated tests pass). The app has **never run against your hosted Supabase project or on a physical phone**, so Phase 1 comes first and everything else depends on it.

---

## Phase 1 — Make it work for you (about 1 day)

| # | Step | Owner |
|---|---|---|
| 1 | In Supabase: **Authentication → Attack Protection**, switch **CAPTCHA off** and click **Save** (the app sends no CAPTCHA token yet; with it on, joining fails). | Owner |
| 2 | In Supabase: **Authentication → Sign In / Providers**, confirm **Allow anonymous sign-ins** is on. | Owner |
| 3 | In Supabase: **Database → Extensions**, enable `pg_cron` and `pg_net` (the every-minute jobs need them). | Owner |
| 4 | In the project folder run `npx supabase@latest link --project-ref cxrdwcmhdsndkzmvilcg`, then `npx supabase@latest db push --remote` to apply every migration (it must reach `20261120000100`). Check with `npx supabase@latest migration list --remote` that no row has a blank Remote column. | Owner |
| 5 | In the SQL editor: `select jobname, schedule from cron.job;` should list the TrainHive jobs (deadline decisions, announcement publishing, reminders, purge). | Owner |
| 6 | Issue your first creator code (SQL editor): `select public.admin_create_creator_code('for me', 14, 1);` or use the first-organizer bootstrap `admin_create_community`. | Owner |
| 7 | `npm start`, open the app on your Android phone in Expo Go, create your community from the start screen with the code. | Owner |
| 8 | Work through the manual test script in `docs/QA_REPORT.md` (steps 1–99) with **two accounts** (two phones, or phone plus browser). Write down every failure and send it to me. | Owner, then Claude fixes |
| 9 | Confirm the deadline job on its own: create a training whose RSVP deadline is 3 minutes away, with the minimum met or not, close the app, and check that it becomes **Confirmed** or **Cancelled** by itself. | Owner |

**Exit criteria:** you and a second person can create a training, RSVP, see counts update live, watch the deadline decision happen without the app open, mark attendance, and read statistics.

---

## Phase 2 — Fix what the first real run finds (1–3 days)

| # | Step | Owner |
|---|---|---|
| 10 | Fix defects from the real run (expect some: nothing has been rendered on a phone or against the real backend until now). | Claude |
| 11 | Re-run the automated suite (`npm test`, `npm run typecheck`, `npm run lint`) after every fix. | Claude |
| 12 | Decide the open product questions (see "Decisions" below). | Owner |

---

## Phase 3 — Installable app for your real members

### 3a. Web version (fastest way for people to use it)
| # | Step | Owner |
|---|---|---|
| 13 | Build the web version task (responsive layout, `/join#code=…` links, hosting files, `docs/WEB_DEPLOY.md`). Status: planned, not started. | Claude |
| 14 | Create a free Netlify or Cloudflare Pages account, build with the three `EXPO_PUBLIC_…` variables, upload the build folder, set a custom domain if you want one. | Owner |
| 15 | In Supabase **Authentication → URL Configuration**, set the site URL to your web address. | Owner |
| 16 | Set `EXPO_PUBLIC_WEB_APP_URL` so invitation messages carry a clickable join link. | Owner |

### 3b. Android installable build (APK)
| # | Step | Owner |
|---|---|---|
| 17 | Create the build configuration (`eas.json`) and link the Expo project. | Claude |
| 18 | Create a free Expo account (expo.dev) and run `npx eas-cli@latest login`, `eas init`. | Owner |
| 19 | Replace the placeholder app icon, adaptive icon and splash screen with real artwork (hexagon/bear identity). | Owner + Claude |
| 20 | `npx eas-cli@latest build -p android --profile preview` (about 15–20 minutes), then send members the download link. | Owner |
| 21 | Put the APK link into `EXPO_PUBLIC_APP_DOWNLOAD_URL` for the invitation message. | Owner |

---

## Phase 4 — Push notifications (about half a day, mostly account setup)

Follow `docs/PUSH_SETUP.md` end to end. Summary:

| # | Step | Owner |
|---|---|---|
| 22 | Create a Firebase project; add the Android app (`com.robearbyte.trainhive`); download `google-services.json`. | Owner |
| 23 | Create an FCM v1 service-account key in Firebase and upload it with `eas credentials`. | Owner |
| 24 | Set `extra.eas.projectId` (from `eas init`) and build a **development or preview build** (Expo Go on Android does not support remote push). | Owner + Claude |
| 25 | Set function secrets (`DISPATCH_SECRET`, `EXPO_ACCESS_TOKEN` if you enable enhanced security) and deploy the function: `npx supabase@latest functions deploy dispatch-notifications --no-verify-jwt`. | Owner |
| 26 | Store `project_url` and `dispatch_secret` in Supabase Vault (exact SQL is in `docs/PUSH_SETUP.md`) so the every-minute job can call the function. | Owner |
| 27 | Test: create a training, check a phone receives the notification; tap it from the closed app and confirm it opens the right screen. Test denied permission too. | Owner |

---

## Phase 5 — Production hardening (before inviting people outside your own club)

| # | Step | Owner |
|---|---|---|
| 28 | **Supabase plan:** the free plan has no point-in-time backups and pauses inactive projects. For a real club, move to Pro, or schedule your own database dumps. | Owner |
| 29 | **Region:** confirm the project is in an EU region (Frankfurt). | Owner |
| 30 | **Abuse limits:** review Authentication → Rate Limits (anonymous sign-ins per hour per IP). CAPTCHA is not supported yet, so these are the protection. | Owner |
| 31 | **Separate staging project:** create a second free Supabase project for testing migrations before applying them to production. | Owner |
| 32 | **Monitoring:** check Supabase Logs for errors weekly; optionally add a crash reporter (Sentry) — the app already routes errors through one logger. | Owner + Claude |
| 33 | **Secrets:** confirm the `service_role` key and database password are only in your password manager; rotate if they were ever pasted anywhere. Never put them in `.env.local`. | Owner |
| 34 | **Migration discipline:** only ever change the database through new migration files and `db push`, never by hand in the dashboard. | Owner |
| 35 | **Support contact:** pick a support email for store listings and the privacy policy. | Owner |

---

## Phase 6 — Legal and privacy (required for any public store)

TrainHive stores a display name, attendance and participation records, push tokens, and an anonymous account id. You are the data controller; if you or your members are in the EU, GDPR applies.

| # | Step | Owner |
|---|---|---|
| 35a | **Re-check the legal details before launch** (controller name, postal address, privacy email: `EXPO_PUBLIC_CONTROLLER_NAME`, `EXPO_PUBLIC_CONTROLLER_ADDRESS`, `EXPO_PUBLIC_PRIVACY_EMAIL`). They appear publicly in the app and on the web policy pages; set them in the web build environment and as EAS variables for every Android build profile you ship. Consider a dedicated privacy email and a non-home address. | Owner |
| 35b | **Replace the test placeholders** in the EAS variables (`EXPO_PUBLIC_CONTROLLER_NAME`, `EXPO_PUBLIC_CONTROLLER_ADDRESS`, `EXPO_PUBLIC_PRIVACY_EMAIL`) with your real details for every environment real members will use (EAS production, the web build, `.env.local`), rebuild the app and the web app, and run `npm run legal:build`. During testing they hold placeholders ("TrainHive Test (placeholder)", `privacy@example.com`). | Owner |
| 36 | Write a **privacy policy** (what is stored, why, how long, who can see it, Supabase as processor, how to ask for deletion) and host it at a public URL. I can draft it. | Owner + Claude |
| 37 | Define the **data deletion process**: how a member asks, and the SQL/RPC you run to delete their account (an in-app "Delete my account" action is a sensible addition; I can build it). Google Play requires an account-deletion path for apps with accounts. | Owner + Claude |
| 38 | Short **terms of use** (organizers are responsible for their communities' content). | Owner |
| 39 | Decide **retention** (for example attendance history kept for N years; notification rows are already purged after 90–180 days). | Owner |
| 40 | If members can be under 16, check local rules on consent for minors. | Owner |

---

## Phase 7 — Google Play Store

| # | Step | Owner |
|---|---|---|
| 41 | Create a **Google Play Console** developer account (one-time 25 USD fee, identity verification can take days). | Owner |
| 42 | Prepare store assets: app name, short and full description, 512×512 icon, 1024×500 feature graphic, at least 2 phone screenshots, a contact email, the privacy-policy URL. | Owner + Claude |
| 43 | Fill the **Data safety** form and **content rating** questionnaire (honest answers from Phase 6). | Owner |
| 44 | Build a signed **production AAB**: `npx eas-cli@latest build -p android --profile production` (EAS manages the signing key; back up the credentials it shows you). | Owner |
| 45 | Run a **closed test**. Google currently requires new personal accounts to run a closed test with a minimum number of testers for a minimum number of days before production access; check the exact current numbers in Play Console. | Owner |
| 46 | Apply for production access, then publish. Reviews can take days. | Owner |
| 47 | Plan updates: increment `version` and `android.versionCode` for every release; use `eas update` for small JavaScript-only fixes. | Owner |

---

## Phase 8 — iPhone (optional, later)

| # | Step | Owner |
|---|---|---|
| 48 | Apple Developer Program (99 USD/year); an App Store listing; push through APNs (EAS handles most of it). The web version works on iPhone in the meantime. | Owner |

---

## Launch plan

1. **Pilot** with your own club (5–15 people) for 2–4 weeks on the web version or the APK. Run real trainings, attendance and announcements.
2. Collect feedback weekly; I fix and ship.
3. Only then open the Play Store release and invite other clubs by giving them creator codes.

---

## Decisions still open (need you)

- **Attendance rate:** "Not recorded" sessions count in the denominator (the spec's formula); the screen says so. Keep, or compute over recorded sessions only?
- **RSVP reliability:** counts only RSVPs "going" with a recorded outcome (kinder than the literal spec wording). Keep?
- **One display name across communities** (the app says so when you join a second one). Keep?
- **Account recovery:** accounts are anonymous and tied to one device or browser. Adding email or Google sign-in lets people recover their account and use phone and web together. Worth doing before a public launch; I recommend it.
- **CAPTCHA support** for the anonymous sign-in, once you have public traffic.

## Known limitations to tell your members

- Losing the phone or clearing app data loses the account (until linking exists).
- Web and phone are separate identities until linking exists.
- Web has no push notifications.
- Two organizers editing the same **training** at once can overwrite each other (communities are protected).
- Delivery receipts for push are not tracked.
- The organizer's per-member statistics list caps at 500 members.

## What cannot be verified without you

Real Realtime updates, the scheduled jobs on the hosted project, push delivery through Expo and Firebase, rendering and gestures on a physical phone, screen-reader behaviour, and the Play Store review. The QA report lists each of these.
