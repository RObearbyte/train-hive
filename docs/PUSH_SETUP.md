# Push notifications: owner setup (Android first, Windows)

**Status: nothing in this guide has been verified against the real Expo service, Firebase, a Supabase project's pg_net/Vault, or a physical device.** The delivery code is tested against a fake Expo server and the real database functions only. Steps and menu names were taken from the current Expo and Supabase CLI documentation (checked 2026-11-15); if a screen looks different, trust the screen and tell the lead.

How it works: when something notifiable happens, the database queues a job and, as soon as the transaction commits, calls the Edge Function `dispatch-notifications` (migration `20261121000100_instant_dispatch.sql`, see "Instant delivery" below). A cron job also calls it every minute as the safety net. The function claims jobs, sends them to the Expo Push Service (`https://exp.host/--/api/v2/push/send`), and Expo hands them to Google's FCM, which wakes the phone.

One run keeps claiming batches of 100 jobs for up to about 40 seconds (or until the queue is empty), so a large announcement goes out in one run. Each batch is sent in requests of at most 100 messages, and the jobs of a request are marked done right after Expo answers it. If Expo rejects a whole request (for example because one token belongs to another Expo project), the dispatcher splits the request in halves until only the offending message fails; that token is marked invalid. A run makes at most 60 requests and starts none after 100 seconds; anything left is retried by the next run.

Prerequisite: the project setup in `docs/SUPABASE_SETUP.md` is done (in particular Supabase CAPTCHA protection stays OFF; the app sends no captcha token, and nothing here changes that).

You need: a Windows PC with Node.js, the Supabase project already linked (`npx supabase@latest link`), an Android phone with USB debugging or the ability to install an APK, and a Google account.

## 1. Expo account and EAS project

```powershell
npx eas-cli@latest login
npx eas-cli@latest init
```

`init` creates the EAS project and writes its id into `app.json` (`extra.eas.projectId`). The app needs that id to get a push token.

## 2. Firebase project, `google-services.json`, FCM v1 key

1. Open the [Firebase Console](https://console.firebase.google.com) and create a project (Analytics can stay off).
2. Add an Android app to it. The package name must equal `android.package` in `app.json`. Download `google-services.json`, put it in the project root and set `"android": { "googleServicesFile": "./google-services.json" }` in `app.json`. (This file may be committed.)
3. Firebase Console, **Settings** (gear) > **Service accounts** > **Generate new private key** > **Generate key**. Keep the downloaded JSON file private and never commit it (add it to `.gitignore`).
4. Upload that key to Expo with the EAS CLI:
   ```powershell
   npx eas-cli@latest credentials
   ```
   Choose **Android** > **production** (or the profile you build with) > **Google Service Account** > **Manage your Google Service Account Key for Push Notifications (FCM V1)** > **Set up a Google Service Account Key for Push Notifications (FCM V1)** > **Upload a new service account key**. Confirm the detected file with `Y`.

   Dashboard alternative: expo.dev > your project > **Project settings** > **Credentials** > Android application identifier > **Service credentials** > **FCM V1 service account key** > **Add a service account key**.

## 3. A development build (Expo Go cannot do this)

Remote push notifications are unavailable in Expo Go on Android since SDK 53, so push can only be tested in a development build:

```powershell
npx eas-cli@latest build --profile development --platform android
```

(`eas.json` needs a `development` profile with `"developmentClient": true`; `eas build:configure` creates it if missing.) When the build finishes, open the build page link on the phone and install the APK (allow installs from your browser when Android asks). Run `npx expo start`, open the installed app, sign in, and accept the notification permission prompt. The app registers its token through `register_push_token`.

Emulators: only Android emulators with Google Play services receive push; a physical phone is the reliable test.

## 4. Function secrets

Pick a long random string for the shared secret (PowerShell: `[Convert]::ToBase64String((1..32 | % { Get-Random -Max 256 }))`).

```powershell
npx supabase@latest secrets set DISPATCH_SECRET=<the-random-string>
```

Optional, only if you switched on "Enhanced Security for Push Notifications" in the Expo dashboard (create an access token under Expo account settings > Access tokens):

```powershell
npx supabase@latest secrets set EXPO_ACCESS_TOKEN=<expo-access-token>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions by the platform; do not set them.

## 5. Deploy

```powershell
npx supabase@latest functions deploy dispatch-notifications --no-verify-jwt
```

`--no-verify-jwt` is intentional (also set in `supabase/config.toml`): the caller is the database, not a signed-in user. The function protects itself: it rejects every request without the exact `x-dispatch-secret` header (constant-time compare) and never accepts a key from the request. Add `--use-api` if Docker is not installed.

## 6. Store the URL and secret in Vault, enable the schedule

Migration `20261115000600_schedule_dispatch.sql` schedules a cron job `trainhive_dispatch_notifications` (every minute) when `pg_cron` and `pg_net` exist. Enable both first: Supabase dashboard > **Database** > **Extensions** > enable `pg_cron` and `pg_net`, then apply the migration again if it warned (`npx supabase@latest db push --remote`... or re-run the migration's SQL in the SQL editor). In the SQL editor run, with your values:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<the-same-random-string-as-DISPATCH_SECRET>', 'dispatch_secret');
```

To change one later: `select vault.update_secret(id, '<new>') from vault.secrets where name = 'dispatch_secret';` (and `supabase secrets set` again for the function). Until both Vault entries exist the cron job runs but sends nothing.

Check it is scheduled and running:

```sql
select jobname, schedule, active from cron.job where jobname = 'trainhive_dispatch_notifications';
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select id, status_code, error_msg, created from net._http_response order by created desc limit 5;
```

### Instant delivery (trigger) and the cron safety net

Queuing a notification fires a statement-level trigger on `notification_delivery_jobs` that calls the same Edge Function through `net.http_post` (same URL, `x-dispatch-secret` header and 120 s timeout, both secrets read from Vault). pg_net sends the request after the transaction commits, so a rolled-back action sends nothing and the app never waits for it. One fan-out (an announcement to 200 members) causes one call; at most one immediate call is made every 2 seconds, and a failure never breaks the action that created the notification (the trigger only logs a warning with the SQLSTATE). Jobs scheduled for later, skipped or failed calls and anything inside the 2-second window are picked up by the cron job within a minute. Overlapping runs are safe.

Nothing new is needed from you: it uses the same pg_net extension and the same Vault entries. Without them the trigger does nothing. Apply the migration with `npx supabase@latest db push --remote`.

Check it: create an announcement in the app, then run

```sql
select id, status_code, error_msg, created from net._http_response order by created desc limit 10;
```

A new row should appear within a second or two of creating the announcement, not only on the full minute. A Postgres log warning `instant dispatch skipped (sqlstate ...)` means the immediate call failed and the cron job will deliver instead.

## 7. Test by hand

```powershell
curl.exe -i -X POST "https://<project-ref>.supabase.co/functions/v1/dispatch-notifications" -H "x-dispatch-secret: <secret>" -H "content-type: application/json" -d "{}"
```

Expected: `200` and JSON counts such as `{"claimed":1,"sent":1,"skipped":0,"failed":0,"dead":0,...,"batches":1,"bisections":0,"deferred":0}`. Without or with a wrong header: `401 {"error":"unauthorized"}`. To create something to deliver, create an announcement in the app as an organizer while a second account's phone has a registered token.

Queue state (SQL editor): `select status, count(*) from notification_delivery_jobs group by 1;` and `select last_error, count(*) from notification_delivery_jobs where status in ('failed','dead','skipped') group by 1;`

## 8. Logs

Supabase dashboard > **Edge Functions** > `dispatch-notifications` > **Logs** (or **Invocations**). Logs hold counts and error codes only (events `expo_chunk`, `tokens_rejected`, `job_dead`, `dispatch_done`, `complete_failed`, `invalidate_failed`); never tokens or message text.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| curl returns 401 | wrong/missing `x-dispatch-secret`, or `DISPATCH_SECRET` secret not set (an unset secret rejects everything) |
| cron runs but nothing is delivered, no function logs | Vault entries `project_url` / `dispatch_secret` missing or wrong; check `net._http_response` |
| Jobs end `skipped` with `no_tokens` | the user has no registered token: permission denied on the phone, app not a development build, or no `projectId` |
| `skipped` with `push_disabled` / `category_disabled` / `not_a_member` | the user's preferences or membership; expected |
| `skipped` with `no_valid_tokens`, tokens get `invalidated_at` | Expo answered `DeviceNotRegistered`: app uninstalled/reinstalled or FCM credentials wrong. The app registers a fresh token at next start |
| `dead` with `permanent:InvalidCredentials` / `MismatchSenderId` | FCM v1 key not uploaded to the Expo project, or `google-services.json` from another Firebase project than the key |
| `dead` with `permanent:MessageTooBig` | payload over 4 KiB (should not happen with these titles and bodies) |
| `failed` with `transient:HTTP_401` | `EXPO_ACCESS_TOKEN` missing/wrong while enhanced push security is on |
| `failed` with `transient:HTTP_429` / `MessageRateExceeded` | Expo's 600/s per project limit; retried automatically with `Retry-After` or backoff (30 s doubling, max 1 h, 5 attempts) |
| Jobs stuck in `sending` | a run died mid-way; they are reclaimed after 5 minutes (a duplicate push is possible, but only for the request that was in flight: earlier requests' jobs are already completed) |
| `failed` with `transient:Deferred` | the run hit its request cap (60) or its 100 s limit; retried by the next run |
| `dead` with `permanent:HTTP_400`, token `last_error` = `PUSH_TOO_MANY_EXPERIENCE_IDS` | that token belongs to another Expo project (for example a build with a different `projectId`); the token is invalidated, other users are not affected. Reinstall the right build |
| Creating an announcement fails with `announcement_rate_limited` | an organizer may create at most 10 announcements per community per hour |
| Nothing arrives on an emulator | the emulator needs Google Play services; use a real phone |

## 10. Known limits

- Delivery is at-least-once. Expo has no idempotency key. If a run dies after Expo accepted a request but before its jobs are marked (jobs are marked right after each request), the retry may push those up to 100 messages twice. The app can ignore a notification whose `data.notificationId` it has already shown. Every message `data` is `{ deepLink, notificationId, kind, communityId }` (`communityId` since C3, from `claim_notification_jobs.community_id`).
- Only **tickets** are checked (Expo accepted the message). **Receipts** (the later FCM outcome, about 15 minutes after sending, kept 24 h) are not read: ticket ids are not stored. A device that became unregistered is therefore noticed at its next send, not by receipt. A migration would be needed to change that (see the M3 note in `docs/API_CONTRACT.md`).
- Tokens: `register_push_token` cannot tell which Expo project a token belongs to; each account keeps at most 10 tokens (least recently seen dropped). How Expo answers a request that holds only another project's token is not verified; see the M3-B3 notes in `docs/API_CONTRACT.md`.
- The cron call waits up to 120 s for the function (migration `20261116000200_dispatch_timeout.sql`); runs may overlap, which is safe (a job is never claimed twice).
- `ttl` is derived from the job's expiry only if the claim returns `expires_at`; today it does not, so announcements use 24 h and trainings 1 h.

## 11. Only a real device can verify

- [ ] The app obtains an Expo push token and `register_push_token` stores it.
- [ ] A notification appears with the app in the background, and with the app killed.
- [ ] Tapping it opens the right screen from `data.deepLink` (`/trainings/<id>`, `/announcements/<id>`).
- [ ] A notification of another community carries `data.communityId` and the tap switches to that community first.
- [ ] The `default` Android channel exists, sound and importance are right.
- [ ] A phone whose app was uninstalled leads to `DeviceNotRegistered` and an invalidated token.
- [ ] Turning push or a category off in preferences stops delivery (job `skipped`).
- [ ] The cron job really fires every minute (pg_cron + pg_net + Vault on the hosted project).
- [ ] Delivery latency end to end is acceptable (cron granularity is up to 1 minute).
