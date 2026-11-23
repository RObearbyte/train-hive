# TrainHive — Personal data breach runbook

**Draft, 2026-11-23 (phase G3). Not legal advice.** Have it reviewed with the other GDPR documents. Placeholders: `[CONTROLLER NAME]`, `[POSTAL ADDRESS]`, `[PRIVACY EMAIL]`, `[PHONE]`. Keep your filled-in copy (with real contacts) outside the repository, for example in your password manager's secure notes, and print one page of it.

A **personal data breach** is any security incident that leads to personal data being destroyed, lost, changed, disclosed or accessed without permission (GDPR Art. 4(12)). It includes accidents: a key pasted into a public chat, a wrong SQL statement that deletes members' data, a lost laptop with the database password.

## 0. The clock

| When | What |
|---|---|
| T0 | You become **aware** that a breach has (reasonably certainly) happened. Write the time down. |
| First hour | Contain (section 2). Start the evidence log (section 6). |
| Within 24 h | First risk assessment (section 3). Decide whether to notify. |
| **Within 72 h of T0** | Notify ANSPDCP unless the breach is **unlikely to result in a risk** to people (Art. 33). If you do not know everything yet, notify what you know and complete it later ("notification in phases"). If late, give the reasons for the delay. |
| Without undue delay | Tell the affected members if the risk is **high** (Art. 34). |
| Always | Record the breach in the breach register (section 6), even when you do not notify. |

## 1. Detect

Signals to take seriously:
- Supabase: unexpected rows, mass deletes or updates, unknown functions or policies, new database users, spikes in API requests or errors (Dashboard → Logs: API, Postgres, Auth), e-mails from Supabase about security or billing.
- The service-role key, database password, Expo access token, Firebase service-account file or `.env.local` content seen anywhere outside your password manager (chat, screenshot, public repository, issue, pastebin).
- A member reports seeing someone else's data, or organizers seeing what they should not (for example an individual workout log, birth year or emergency contact of a member who left).
- Push notifications with strange content (Expo access token or FCM key misused).
- Lost or stolen device that is signed in to the Supabase, Expo, Google or GitHub dashboard.
- A dependency or Supabase / Expo security advisory that affects you.

## 2. Contain (first hour)

Do what applies; note each step with the time in the evidence log.

**Supabase (database, auth, functions)**
1. Rotate the API keys: Dashboard → Project Settings → API (JWT / API keys). Rotating the JWT secret or the legacy keys signs every member out; with the newer publishable / secret keys you can revoke the leaked secret key alone. If the **anon / publishable** key changes, the app and the web build need the new value (`EXPO_PUBLIC_SUPABASE_ANON_KEY` in EAS environment variables, the web build environment and `.env.local`) and a rebuild.
2. Reset the **database password**: Project Settings → Database. Update it in your password manager only.
3. Revoke sessions if accounts were taken over: Authentication → Users → select the user → sign out / delete; for everyone, rotating the JWT secret ends every session.
4. Check for persistence: SQL editor —
   - `select rolname from pg_roles where rolname not like 'pg_%' order by 1;` (unknown roles?)
   - `select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private') order by 1, 2;` compare with `supabase/tests/qa-privileges.test.ts` (`PUBLIC_FUNCTIONS`).
   - `select schemaname, tablename, policyname, cmd, roles from pg_policies where schemaname = 'public';` (every policy must be SELECT for `authenticated`).
   - `select jobname, schedule, command from cron.job;` (only the `trainhive_*` jobs).
5. If data was changed or deleted: **stop writing first** (pause the project or switch the app off), then consider restoring a backup (Database → Backups; point-in-time recovery if enabled). Restoring brings back data that members deleted in the meantime: write down which accounts deleted themselves after the restore point and erase them again (`select private.erase_user('<id>');`).
6. Pause the scheduled jobs if they could spread the damage: `select cron.unschedule('<jobname>');` (re-create later from the migrations).

**Expo (push)**
7. Revoke the Expo access token (expo.dev → Account settings → Access tokens) and create a new one; update the EAS secret / environment variable used by the dispatcher Edge Function (see `docs/PUSH_SETUP.md`).
8. If "Enhanced push security" is enabled, rotate it; if it is not, consider enabling it.

**Google Firebase (FCM)**
9. Firebase console → Project settings → Service accounts: delete the leaked key, create a new one, upload it to Expo (EAS credentials) for Android push.

**Code and accounts**
10. GitHub: if a secret was committed, rotate it first (removing it from history is not enough), then clean the history if needed.
11. Change passwords and enable 2FA on Supabase, Expo, Google, GitHub and the web host. Remove people who no longer need access.
12. Web version: redeploy from a clean build if the hosted files could have been changed.

## 3. Assess the risk

Answer in the evidence log:
- **What data?** Use the register in `docs/RECORD_OF_PROCESSING.md` section 7. Higher risk: workout logs (health-related), emergency contacts (third parties' phone numbers), birth year and gender, attendance patterns (when someone is away from home), push tokens (spam to devices).
- **How many people?** Count with SQL (counts only), e.g. `select count(*) from private.workout_logs;`.
- **Who got it, and can it be undone?** Known trusted recipient who deleted it (lower risk) vs. public or unknown attacker (higher).
- **Identifiability:** accounts are anonymous, but display names, community names and emergency contacts can identify people.
- **Consequences:** discrimination, embarrassment, safety (someone knowing when a person trains and where), phishing of emergency contacts.

| Outcome | Then |
|---|---|
| Unlikely to result in a risk (e.g. encrypted backup lost, key leaked and rotated with proof it was not used) | No notification; record it in the register with the reasoning. |
| Risk | Notify ANSPDCP within 72 hours. |
| High risk (e.g. workout logs or emergency contacts exposed to unknown people) | Notify ANSPDCP **and** the affected members. |

## 4. Notify the supervisory authority (ANSPDCP)

- Use the breach notification form published on www.dataprotection.ro (check the current form and channel there; at the time of writing the authority accepts the notification form by e-mail or post).
- Content (Art. 33(3)): nature of the breach, categories and approximate numbers of people and records, contact point (`[PRIVACY EMAIL]`), likely consequences, measures taken and proposed.

**Template (fill in):**

> Controller: [CONTROLLER NAME], [POSTAL ADDRESS], contact [PRIVACY EMAIL], [PHONE].
> Service: TrainHive, a mobile and web app for sports communities.
> Date and time the breach happened (or estimate): [ ]. Date and time we became aware: [ ].
> What happened: [short factual description].
> Data concerned: [categories, e.g. display names, attendance records, workout logs]. Approximate number of people: [ ]. Approximate number of records: [ ].
> Likely consequences: [ ].
> Measures taken: [containment steps with times]. Measures planned: [ ].
> Members informed: [yes, on date, how / no, because ...].
> This is an initial notification; we will complete it by [date] (if applicable).

## 5. Tell the members (when the risk is high)

In plain language, without undue delay: in-app announcement to each affected community (organizers can post it, or you insert it as an announcement) and, if push is available, a push notification that points to the app (no details in the push text).

**Template:**

> Subject: Security incident affecting your TrainHive data
> On [date] we found that [what happened, one sentence]. This may have exposed [data concerned] of members of [community / all communities].
> What we did: [rotated keys, closed the gap, ...].
> What you can do: [e.g. be careful with messages that claim to come from your club; tell your emergency contact; you can delete your workout logs or your account in Profile → Privacy].
> Questions: [PRIVACY EMAIL]. You can also complain to ANSPDCP (www.dataprotection.ro).

Art. 34(3): no individual message is needed if the data was unintelligible (encrypted), if later measures removed the high risk, or if it would take disproportionate effort (then a public communication instead).

## 6. Evidence log and breach register

Keep a dated document (outside the repository) for each incident:

| Time (UTC) | Who | What was observed / done | Evidence (screenshot, log export, query result) |
|---|---|---|---|

Export the relevant Supabase logs early (Dashboard → Logs; they are kept only for a limited time on your plan). Do not copy personal data into the log: counts and ids of rows are enough.

The **breach register** (Art. 33(5)) lists every breach, including the ones not notified: date, facts, effects, measures, decision and reasoning on notification.

## 7. Contacts checklist (fill in your copy)

| Who | Contact | Checked on |
|---|---|---|
| Controller / decision maker | [CONTROLLER NAME], [PHONE] | |
| Privacy contact | [PRIVACY EMAIL] | |
| Lawyer / data-protection adviser | [ ] | |
| ANSPDCP | www.dataprotection.ro (notification form and current contact details) | |
| Supabase support / security | Dashboard → Support; security reports as described on supabase.com/security | |
| Expo support | expo.dev (support / security contact) | |
| Google Firebase support | Firebase console → Support | |
| Web host support | [Netlify / Cloudflare] | |
| Organizers of each community (to relay messages) | in the app | |

## 8. Afterwards

- Root cause, fix, and a test that would have caught it (`supabase/tests/`).
- Update `docs/RECORD_OF_PROCESSING.md` and this runbook.
- Practice once a year with a made-up scenario (for example "the service-role key was pasted into a chat"): walk through sections 2 to 5 and time it.
