# TrainHive — GDPR compliance plan

Requested by the owner on 2026-11-18. **This document and the features it describes are technical measures and draft texts. They are not legal advice and do not by themselves make TrainHive compliant.** Before real members use the app, have the policy texts, the controller set-up and the record of processing reviewed by a lawyer or your data-protection contact (in Romania the supervisory authority is ANSPDCP).

## Defaults I applied (the owner did not answer; each is one setting or one text to change)

| Topic | Default | Where to change |
|---|---|---|
| Data controller | The operator of TrainHive (the owner, named in one config file with legal name, address, contact email). Organizers are users of the service, not separate controllers. | `src/features/legal/config.ts` (to be created in G1) |
| Minimum age | 16 (the digital-consent age I believe applies in Romania; confirm locally). Under-16s are not allowed; no parental-consent flow. | same config, enforced by an age confirmation at onboarding and by the optional birth year |
| On account deletion | Delete personal data; keep **anonymous** attendance counts so past club statistics stay correct. | `delete_my_account` design below |
| Retention | Notifications: read 90 days, unread 180 days (already implemented). Failed-attempt rows: 24 hours (already implemented). Push tokens: removed when invalid or on deletion. Workout logs and profile data: until the member deletes them or the account. Inactive accounts (no use for 24 months): flagged for deletion (G3). | G3 |

## 1. Data inventory and lawful basis

| Data | Purpose | Lawful basis (Art. 6; special categories Art. 9) | Visible to |
|---|---|---|---|
| Anonymous account id, community membership, role | Run the service, authorization | Contract (6(1)(b)) | Organizers of the member's community see membership; others see display name |
| Display name | Identify members to each other | Contract | Community members |
| RSVP, attendance records, audit log | Plan events, record who attended | Contract; legitimate interest of the community (6(1)(f)) for attendance history, with the right to object | Organizers; the member sees their own |
| Push tokens, notification preferences, in-app notifications | Deliver reminders and updates | Consent for push (6(1)(a), and the OS permission); in-app notifications are part of the service (contract) | The member; processors Expo and Google deliver pushes |
| Birth year, gender (onboarding page) | Statistics for the club | **Explicit consent** (6(1)(a)); optional and withdrawable | The member; organizers only as grouped statistics for groups of 5+ |
| Emergency contact (name, phone, relationship), T-shirt size | Safety at events, race kits | **Explicit consent**; third party's data: the member confirms the contact knows | The member; organizers of their community |
| Workout logs (exercises, weights, distance, time, pace, notes) | Personal progress and club totals | **Explicit consent** (this can reveal health information, so treat as Art. 9(2)(a)); optional; withdrawable | The member; organizers only as grouped totals |
| Event posts and replies | Event communication | Contract | Community members |
| Device and network metadata held by Supabase, Expo, Google (IP addresses, logs) | Hosting, delivery, security | Legitimate interest of the processors; covered by their DPAs | Processors |

Not collected: precise location tracking, contacts, advertising identifiers, analytics SDKs, payments, any data from children.

## 2. Consents (G1): what the app must ask and record

Consent is **granular, optional, not pre-ticked, withdrawable as easily as given, and recorded** (who, which purpose, which text version, when, withdrawn when).

| Consent | Asked when | Effect if declined |
|---|---|---|
| Terms of use + privacy notice acknowledgement, age confirmation (16+) | First launch, before any account data is stored (this is information plus a contract acceptance, not "consent" to processing) | Cannot use the app |
| `profile_demographics` (birth year, gender) | On the "About you" page | Fields are not stored; page skippable |
| `emergency_contact` | Same page, separate toggle | Not stored |
| `workout_logs` | First time the member opens the workout log (and from the push prompt) | Logs cannot be saved. The post-event prompt is sent regardless (owner decision 2026-11-23: a neutral reminder with no workout data); saving needs the consent, asked on the log screen |
| `push_notifications` | In-context prompt before the OS permission dialog (already designed this way); OS permission is a second gate | In-app notifications still work |
| Marketing / analytics | **Not offered** (none exists). If ever added, a new consent is required | n/a |

Rules enforced **in the database**, not only in the app: a function that stores a consent-dependent field checks for a current, not-withdrawn consent of the right version; withdrawing deletes (or irreversibly anonymizes) the data it covered, immediately, with a confirmation dialog.

## 3. Data subject rights (G2)

| Right | Implementation |
|---|---|
| Information (Art. 13) | Privacy notice screen (and public web page) linked from onboarding, Profile and every consent form; layered short text + full text; versioned |
| Access and portability (Art. 15, 20) | Profile → Privacy → **Download my data**: a JSON file generated by a server function (`export_my_data`) covering profile, memberships, RSVPs, attendance, workout logs, posts, notification preferences, consents, push-token count (not the tokens) |
| Rectification (Art. 16) | Edit display name, About you and workout logs in the app |
| Erasure (Art. 17) | Profile → Privacy → **Delete my account** (double confirmation, explains consequences): server function `delete_my_account` removes profile, memberships, RSVPs, push tokens, notifications, consents, workout logs, emergency contact, demographic data and the authentication user; attendance rows are converted to anonymous (user id removed, name not kept), authored posts are deleted or shown as "Former member" (choose: delete); organizers of a community cannot delete while being the **last** organizer (they must hand over or delete the community first) |
| Restriction / objection (Art. 18, 21) | Objection to attendance history: member can ask the organizer to delete a record or use delete-my-account; documented in the notice. Per-purpose toggles in Privacy settings |
| Withdraw consent (Art. 7(3)) | Privacy settings, one tap per purpose, effective immediately |
| Complaint (Art. 77) | Notice names ANSPDCP and the controller contact |
| Response time | One month; a manual process for requests sent by email (documented in G3) |

Account recovery caveat: accounts are anonymous, so the app cannot verify identity from outside the app. Requests must come from inside the signed-in app (export, delete). Email requests are answered only if the person can prove they control the account (for example by creating a code inside the app).

## 4. Controller duties and organizational measures (owner, with legal review) — G3

1. **Controller identity and contact** in the config file and the notice.
2. **Processors and contracts**: Supabase (database, auth, functions; sign its DPA, choose an EU region), Expo (push relay, builds) and Google Firebase Cloud Messaging (delivery). Push tokens and notification text pass through Expo and Google; Expo and Google may process data outside the EEA, so rely on their standard contractual clauses / data-privacy-framework status and say so in the notice. Keep notification texts free of sensitive details (no workout data, no emergency contact in pushes).
3. **Record of processing activities (Art. 30)** and a **DPIA assessment** (Art. 35): recommended because health-related workout data and children-adjacent audiences are involved; I will draft the record from section 1.
4. **Security measures** (documented in the notice): row-level security on every table, server-side authorization, encrypted transport, no service keys in the app, audit log for attendance changes, rate limits, text hygiene. Add: keep Supabase and Expo accounts on strong passwords + 2FA.
5. **Breach procedure**: a short written runbook (detect, contain, assess, notify ANSPDCP within 72 hours if there is a risk, notify affected members). I will draft `docs/BREACH_RUNBOOK.md`.
6. **Retention schedule** and automated purges (G3): extend the existing purge function for inactive accounts and orphaned data.
7. **Organizers' responsibilities**: terms tell organizers to use member data only to run their community and not to export or share it. The app does not offer a member export to organizers.
8. **Minors**: the age gate plus the terms. No special handling beyond refusing under-16s.

## 5. Phases

| Phase | Content | Depends on |
|---|---|---|
| **G1** | `consents` ledger (table + RPCs `record_consent`, `withdraw_consent`, `my_consents`), legal config, Terms and Privacy screens (in-app + static web pages), first-launch acknowledgement and age gate, consent toggles screen (Profile → Privacy) | none; do **before** P3 and P5 |
| **G2** | `export_my_data` and `delete_my_account` (Edge Function with service role for removing the auth user + SQL functions for data), last-organizer protection, anonymization of attendance, tests proving that nothing personal remains | G1 |
| **G3** | Retention jobs (inactive accounts), `docs/BREACH_RUNBOOK.md`, record of processing, DPIA draft, processors checklist, privacy notice review pass | G1, G2 |
| **Integration** | P3 (About you) and P5 (workout logs) must store data only with consent and appear in export/deletion; emergency contact visible to organizers only with consent | G1, G2 |

New order of all work: **G1 → G2 → P1 → P2 → P4 → P3 → P5 → G3**.

## 6. What I cannot do for you

- Decide who the controller is, sign contracts with Supabase / Expo / Google, or file anything with the authority.
- Confirm the Romanian age of digital consent and other national rules; verify with a lawyer.
- Guarantee that anonymous attendance counts are adequately anonymized for a small club: with very few members, counts can still point to individuals. The notice should say so and the retention choice is yours.

## Acceptance checks (G1 + G2)

- A member who declines every optional consent can still use events and RSVP.
- No consent-dependent field can be written without a current consent (database test).
- Withdrawing a consent removes the data it covered (test).
- `export_my_data` contains every personal record of the member and nothing of others (test).
- After `delete_my_account` a database scan finds no row referencing the user id except anonymized attendance and audit entries without name or id (test), and the auth user is gone.
- The last organizer cannot delete the account (test).
- Privacy notice and terms are reachable without an account (static web page) and from every consent screen.
