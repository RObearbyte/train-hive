# Connecting TrainHive to a hosted Supabase project — step by step

Until this is done, the backend is verified only against a local test database (`npm test`). Realtime, the every-minute deadline job, anonymous sign-in and push are **not** verified end to end.

Time needed: about 15 minutes. Free tier is enough.

Dashboard labels change now and then; if a menu is named slightly differently, look for the closest match.

## 1. Create the project

1. Go to https://supabase.com and sign in (GitHub sign-in is fine).
2. **New project**. Name: `trainhive`. Region: the one closest to your members (for Romania: Frankfurt / `eu-central-1`).
3. Set a **database password** and store it in your password manager. You need it in step 4.
4. Wait until the project finishes provisioning.

## 2. Enable anonymous sign-ins

1. **Authentication → Sign In / Providers** (may be under **Authentication → Settings**).
2. Turn on **Allow anonymous sign-ins**. Save.
3. **Keep CAPTCHA protection OFF** (Authentication → Attack Protection). The app does not send CAPTCHA tokens yet, so with it on, joining fails with "captcha protection: request disallowed (no captcha_token found)". Instead, review Authentication → Rate Limits (anonymous sign-ins per hour) to limit abuse. CAPTCHA support is a future task.

## 3. Enable the scheduler extension

1. **Database → Extensions**.
2. Search for `pg_cron` and enable it.

Do this **before** applying migrations: the migration that schedules the every-minute deadline check only does so when `pg_cron` is available.

## 4. Apply the database migrations

Option A — Supabase CLI (recommended, repeatable). In a terminal in the project folder:

```bash
npx supabase@latest login
```

```bash
npx supabase@latest link --project-ref YOUR_PROJECT_REF
```

```bash
npx supabase@latest db push --remote
```

`YOUR_PROJECT_REF` is the random id in your project URL (`https://YOUR_PROJECT_REF.supabase.co`). `link` asks for the database password from step 1. Use `--remote` (older CLI versions call it `--linked`): without it the CLI targets a local Docker stack and fails with `ECONNREFUSED 127.0.0.1:54322`. `db push` applies every file in `supabase/migrations/` in order and remembers which ones were applied, so you can run it again after pulling new migrations.

Option B — no CLI: open **SQL Editor**, and for each file in `supabase/migrations/` **in filename order**, paste its full contents and press **Run**. Every file must finish without an error before you run the next.

## 5. Give the app its keys

1. **Project Settings → API** (or **API Keys**). Copy the **Project URL** and the **anon / publishable** key.
2. In the project folder, copy `.env.example` to `.env.local` and fill in both values.

Never put the `service_role` / secret key in `.env.local` or anywhere in the app. `.env.local` is gitignored.

## 6. Create your community and your organizer code

In **SQL Editor** run (change the name and timezone):

```sql
select public.admin_create_community('Făget Trail Pack', 'Europe/Bucharest');
```

The result contains `organizer_code`. It works once and expires after 7 days. This is the only way to become an organizer; the app has no public path to that role.

## 7. Run the app on your Android phone

1. Install **Expo Go** from Google Play.
2. In the project folder:

```bash
npm start
```

3. Scan the QR code with Expo Go (phone and PC on the same Wi-Fi).
4. On the welcome screen enter the organizer code, then your display name.
5. In **Profile → Invitations** create a member code and share it with your athletes.

## 8. Check that the server-side pieces work

- **Deadline job**: in SQL Editor, `select jobname, schedule from cron.job;` should list the TrainHive job. Create a training with an RSVP deadline a few minutes away and watch it become Confirmed or Cancelled without touching the app.
- **Realtime**: open the app on two phones (or phone + `npm run web`), RSVP on one, and the count should change on the other within a second or two.

## Later milestones

- Push notifications (Milestone 3) need a development build, an Expo account and Firebase (FCM) credentials for Android. That gets its own section when Milestone 3 lands.

## Known limitations

- Anonymous accounts live on the device. If a member uninstalls the app, clears its data or loses the phone, that identity is gone; they rejoin with a new code and start a fresh history. The data model is ready for linking an email / Apple / Google identity later without losing memberships.
