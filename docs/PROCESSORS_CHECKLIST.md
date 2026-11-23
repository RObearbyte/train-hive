# TrainHive — Processors checklist (owner actions)

**Draft, 2026-11-23 (phase G3). Not legal advice.** GDPR Art. 28 requires a written contract (a data processing agreement, "DPA") with every company that processes members' data for you. The big providers offer standard DPAs you accept online; you cannot negotiate them, but you must accept them, keep a copy and check the points below. Menu names change: if a step below does not match what you see, search the provider's site for "DPA" or "data processing addendum". Never put passwords or keys in this file.

Tick each box in your own copy (outside the repository, with dates).

## 1. Supabase (database, authentication, server functions) — all app data

- [ ] **Account:** the Supabase organization that owns the TrainHive project (the one the owner signs in to). Enable 2FA for every member of the organization.
- [ ] **Region:** Project Settings → General shows the region. It should be in the EU (for example `eu-central-1`, Frankfurt). If it is not, the data is stored outside the EEA: either create a new project in an EU region and migrate before launch (easiest now, while there are no real members), or describe the transfer in the notice.
- [ ] **DPA:** Supabase offers a DPA for customers (look in the dashboard under the organization's legal documents, or on supabase.com under Legal / DPA). Request or accept it for the organization, download the signed copy and store it.
- [ ] **Sub-processors:** read Supabase's sub-processor list (linked from the DPA / legal pages; it includes the cloud provider hosting your region). Subscribe to change notices if offered.
- [ ] **Transfers:** check that the DPA includes the EU standard contractual clauses (SCCs) for any access from outside the EEA (support, monitoring).
- [ ] **Logs and backups:** note the log retention and backup retention of your plan in `docs/RECORD_OF_PROCESSING.md` section 7.
- [ ] **Auth audit log:** check whether the Auth audit log is written to `auth.audit_log_entries` in your project and decide its retention (record of processing, section 7).
- [ ] **Security:** confirm the service-role key and database password are only in your password manager; consider network restrictions for direct database connections.

## 2. Expo (push notification service, builds, EAS) — push tokens and notification texts

- [ ] **Account:** the Expo account / organization that owns the project (EAS). Enable 2FA.
- [ ] **DPA:** Expo (650 Industries, Inc., United States) provides a data processing addendum for customers (look for "DPA" on expo.dev, in the legal / privacy pages, or ask Expo support). Accept or sign it and keep a copy.
- [ ] **Transfers:** Expo is in the US. Check whether the DPA relies on SCCs or the EU-US Data Privacy Framework (the DPF list at dataprivacyframework.gov shows whether a company is certified). Your notice already says push data may be processed outside the EEA.
- [ ] **Sub-processors:** Expo's push service passes messages to Google FCM (Android) and Apple APNs (iOS, later). Note Expo's sub-processor list.
- [ ] **Minimize:** keep notification texts neutral (already enforced: no workout data, no emergency contacts). Consider "Enhanced push security" (access token required to send).
- [ ] **EAS environment variables:** contain the controller details shown in the app (`EXPO_PUBLIC_CONTROLLER_*`). Replace the test placeholders before real members (`docs/GO_LIVE.md` 35b).

## 3. Google Firebase Cloud Messaging — Android push delivery

- [ ] **Account:** the Google account that owns the Firebase project used for FCM. Enable 2FA; keep the number of project members small.
- [ ] **Data processing terms:** in the Firebase console, Project settings → Privacy / Data processing (or the Google Cloud console for the same project), review and accept the Firebase / Google Cloud data processing and security terms; enter the controller's contact details there (use `[PRIVACY EMAIL]`).
- [ ] **Transfers:** Google relies on SCCs and is certified under the EU-US Data Privacy Framework; keep a note of the date you checked.
- [ ] **Analytics off:** TrainHive does not use Google Analytics for Firebase. Make sure it is not enabled in the Firebase project (the notice says "no analytics").
- [ ] **Service-account key:** the key uploaded to Expo for FCM is a secret; know where it is and how to rotate it (`docs/BREACH_RUNBOOK.md`).

## 4. Web host (Netlify or Cloudflare Pages, see `docs/WEB_DEPLOY.md`)

- [ ] Accept the host's DPA (both offer one for customers) and note the region / transfer basis.
- [ ] Name the host in the privacy notice once chosen ("The hosting provider of the web version" is currently unnamed).
- [ ] 2FA on the host account.

## 5. Others to check

- [ ] **GitHub** (source code): holds no member data. Keep secrets out of the repository.
- [ ] **E-mail provider** used for `[PRIVACY EMAIL]`: it will receive members' requests. A dedicated address is recommended (`docs/GO_LIVE.md` 35a).
- [ ] **Google Play** (later): the Data safety form must match the record of processing.

## 6. What to keep

A folder (outside the repository) with: each signed / accepted DPA (PDF), the date accepted, the sub-processor lists as of that date, and a note of the transfer basis per provider. Review it once a year and when a provider notifies a change.
