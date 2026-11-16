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
3. Optional, same file: `EXPO_PUBLIC_APP_DOWNLOAD_URL` is the link where people download the app (your Play Store listing or an APK download page, `http` or `https`). It is put into the invitation message organizers copy or share. Leave it empty until you have one: the message then says "Ask me where to get the app". For an EAS build, set the same variable in the build profile (`eas.json` `env`) or as an EAS environment variable, because `.env.local` is not uploaded with the build. `EXPO_PUBLIC_` values are baked into the app and visible to anyone who has it, so put only a public link here.

Never put the `service_role` / secret key in `.env.local` or anywhere in the app. `.env.local` is gitignored.

## 6. Issue a creator code

Nobody can create a community in the app without a **creator code**, and only you (the project owner) can make one. Whoever gets the code types it in the app, chooses the community's name and time zone, and becomes its organizer. Members who only have an invitation code can never create a community.

In **SQL Editor** run (the text in quotes is a note for yourself, e.g. who the code is for):

```sql
select public.admin_create_creator_code('for Alex', 14, 1);
```

- `'for Alex'` — your note (optional, up to 100 characters; use `null` for none).
- `14` — the code expires after this many days (1 to 365).
- `1` — how many communities can be created with it (1 to 50). Keep 1 unless you hand one code to several organizers.

The result looks like `{"code": "K7MZ3QXA", "expires_at": "...", "max_uses": 1}`. Send the `code` to the person. Each person can create at most 5 communities in total.

**See all codes** (newest first; `use_count` = communities created with it so far):

```sql
select code, note, use_count, max_uses, expires_at, revoked_at from public.community_creator_codes order by created_at desc;
```

**Revoke a code** (it stops working at once; communities already created with it are not affected; running it twice is harmless):

```sql
select public.admin_revoke_creator_code('K7MZ3QXA');
```

Don't delete rows from `community_creator_codes`; revoke instead.

**Alternative: create the community yourself** (the original bootstrap). This makes the community from the SQL editor and gives you a one-time organizer invitation code:

```sql
select public.admin_create_community('Făget Trail Pack', 'Europe/Bucharest');
```

The result contains `organizer_code`. It works once and expires after 7 days. Enter it in the app as an invitation code to become the organizer. The app has no public path to the organizer role other than these two.

## 7. Run the app on your Android phone

1. Install **Expo Go** from Google Play.
2. In the project folder:

```bash
npm start
```

3. Scan the QR code with Expo Go (phone and PC on the same Wi-Fi).
4. On the welcome screen enter the organizer code, then your display name. (Entering a creator code in the app needs the "create a community" screen, which is built after the backend task C1; until then use the alternative in step 6.)
5. In **Profile → Invitations** create a member code and share it with your athletes.

## 8. Check that the server-side pieces work

- **Deadline job**: in SQL Editor, `select jobname, schedule from cron.job;` should list the TrainHive job. Create a training with an RSVP deadline a few minutes away and watch it become Confirmed or Cancelled without touching the app.
- **Realtime**: open the app on two phones (or phone + `npm run web`), RSVP on one, and the count should change on the other within a second or two.

## Later milestones

- Push notifications (Milestone 3) need a development build, an Expo account and Firebase (FCM) credentials for Android. That gets its own section when Milestone 3 lands.

## Known limitations

- Anonymous accounts live on the device. If a member uninstalls the app, clears its data or loses the phone, that identity is gone; they rejoin with a new code and start a fresh history. The data model is ready for linking an email / Apple / Google identity later without losing memberships.
