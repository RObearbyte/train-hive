# Account recovery by email: owner setup (Supabase dashboard)

Added 2026-11-24. Members can add an **optional email** to their anonymous account (Profile, **Secure your account**) and sign in again later, on any device, with a **6-digit code** that is emailed to them (Welcome, **I already have an account**). No passwords, no Google or other providers.

The app code is done and tested with unit tests. **It does nothing useful until you do the steps below in the Supabase dashboard**, and none of them has been tried against the real project yet (see "What is not verified").

How it works, so the settings make sense:

- Linking: the app calls `auth.updateUser({ email })` on the anonymous session. Supabase mails a **"Confirm email change"** message to the new address; the person types the code, the app calls `verifyOtp({ type: 'email_change' })`. The account keeps the same user id, so memberships, RSVPs, About-you data and workout logs stay exactly as they are.
- Signing in: the app calls `signInWithOtp({ email, shouldCreateUser: false })`. Supabase mails the **"Magic Link"** message; the person types the code, the app calls `verifyOtp({ type: 'email' })`. `shouldCreateUser: false` means an unknown address never creates a new account.
- Existing anonymous accounts: **nothing happens to them** until their owner adds an email. They keep working, they are still covered by the (disabled by default) inactivity clean-up, and nobody is forced to link.

## 1. Settings to check (about 10 minutes)

Dashboard path names change now and then; look for the word in bold.

| # | Where | What to set |
|---|---|---|
| 1 | **Authentication → Sign In / Providers → Email** | **Enable Email provider**: on. |
| 2 | same page | **Confirm email**: leave **on** (the default). The address is only attached to the account after the person proves they can read it. |
| 3 | same page | **Email OTP Length**: **6** (the app only accepts exactly six digits). **Email OTP Expiration**: the default (3600 seconds) is fine; shorter is safer. |
| 4 | same page, **Authentication → Sign In / Providers** | **Allow anonymous sign-ins**: stays **on** (this is how everyone joins). **Allow new users to sign up**: stays **on** (switching it off also blocks anonymous accounts). Do not enable Google, Apple or any other provider. |
| 5 | **Authentication → Emails → Templates** | Edit **Confirm email change** and **Magic Link** so they show the code (section 2). |
| 6 | **Authentication → Emails → SMTP Settings** | Set up **custom SMTP** (section 3). Required for production. |
| 7 | **Authentication → Rate Limits** | Review (section 4). |
| 8 | **Authentication → Attack Protection** | **CAPTCHA stays off** (the app sends no CAPTCHA token; with it on, signing in and linking fail). |

You do not need to set a Site URL or redirect URLs for this feature: the app never opens a link from the email.

## 2. Edit the two email templates

By default these emails contain only a link. The app needs the **code**. In **Authentication → Emails → Templates**, open each template, change the subject and body, and click **Save**:

**Confirm email change** (used when a member adds an email):

- Subject: `Your TrainHive code`
- Body:

```html
<h2>Your TrainHive code</h2>
<p>Enter this code in the app to add this email to your account:</p>
<p style="font-size:24px;letter-spacing:4px"><strong>{{ .Token }}</strong></p>
<p>It works once and expires soon. If you did not ask for it, ignore this email: nothing changes.</p>
```

**Magic Link** (used when a member signs in with an email):

- Subject: `Your TrainHive sign-in code`
- Body:

```html
<h2>Your TrainHive sign-in code</h2>
<p>Enter this code in the app to sign in:</p>
<p style="font-size:24px;letter-spacing:4px"><strong>{{ .Token }}</strong></p>
<p>It works once and expires soon. If you did not ask for it, ignore this email: nobody can sign in without the code.</p>
```

`{{ .Token }}` is the 6-digit code. Do not leave only `{{ .ConfirmationURL }}`: the link would open a web page, not the app. Keep the texts free of personal details. If you want to translate them, keep `{{ .Token }}`.

(Optional, harmless) also put the code into **Confirm signup** and **Reauthentication** the same way, so every email the project sends is consistent. The app does not use them.

## 3. Custom SMTP (required before real members)

Supabase's built-in email sender is for trying things out: it only delivers to members of your Supabase organization and allows only a **few emails per hour for the whole project**. With it, one member linking an email can block everyone else for the rest of the hour, and ordinary members would not receive anything at all.

1. Pick a transactional email provider (Resend, Brevo, Postmark, Amazon SES, Mailgun and similar all work with Supabase). Prefer one with an EU region. It becomes a **processor**: sign its data processing agreement and add it to `docs/PROCESSORS_CHECKLIST.md` (`docs/GO_LIVE.md` 40j).
2. Verify a sending domain with the provider (add the SPF and DKIM DNS records it shows you). A sender like `no-reply@your-domain` that is not verified ends in spam or is rejected.
3. In **Authentication → Emails → SMTP Settings** switch **Enable Custom SMTP** on and fill in host, port, username, password, sender email and sender name (`TrainHive`). Save.
4. Send yourself a test (section 5) and check the spam folder once.

The SMTP password is a secret: keep it in your password manager, never in the repository or `.env.local`.

## 4. Rate limits

In **Authentication → Rate Limits** (defaults at the time of writing; the dashboard is the truth):

- **Emails sent per hour**: with custom SMTP you can raise it from the small default. Size it for a busy evening (for example 100) so a club linking at the same time is not blocked. This also caps how many codes an attacker can make us send.
- **Token verifications** per 5 minutes per IP: leave the default. It limits code guessing together with the code expiry.
- Supabase also refuses a second email to the same address within about **60 seconds**; the app's "Send again" button waits 60 seconds to match.
- When a limit is hit the app says "Too many emails or attempts. Wait a few minutes and try again."

## 5. Test with two devices (about 15 minutes)

You need two devices (or one phone and the web version, or two browsers) and a mailbox you control. Use a throwaway community and test accounts, not your real club.

1. Device A: join a test community with an invitation code. Open **Profile → Secure your account**. Enter your mailbox address, tap **Send code**.
2. The email "Your TrainHive code" arrives (check spam). It shows a 6-digit code, not only a link. Enter it, tap **Confirm email**. The section now says **Account secured with a\*\*\*@g\*\*\*.com** (masked) and the sign-out text no longer warns about losing the account.
3. Device B (fresh install, or the web version): on the Welcome screen choose **I already have an account**, enter the same address, tap **Send me a code**. Enter the code, tap **Sign in**. You land in the test community with the same name, role and history; you are not asked to join again. If the terms were updated since, you see **We updated our terms** first, as everywhere else.
4. On device A, sign out (the dialog says you can sign in again with your email) and sign in again with a code: you come back to the same account.
5. Wrong paths: type a wrong code (friendly "not correct or has expired" on the field); wait out the 60 seconds and use **Send the code again** (the old code stops working); try linking an address that already belongs to another test account (the app says the email already belongs to an account and to use **I already have an account**); on the Welcome screen enter an address that has **no** account (the screen still says "If this email has an account we sent you a code" and no email arrives).
6. Delete the test account (**Profile → Privacy → Delete my account**). In the dashboard (**Authentication → Users**) the user and its email are gone. If the email is still listed, tell Claude: the privacy notice promises deletion with the account.

## 6. Troubleshooting

- **No email arrives.** (1) Check spam. (2) With the built-in sender: the address must belong to your Supabase organization, and only a few emails per hour are allowed; set up SMTP. (3) **Logs → Auth** in the dashboard shows the send attempt and its error. (4) SMTP: wrong port or password, or the sender domain is not verified: the provider's dashboard shows rejected messages. (5) The app says "We could not send the email right now": this is an SMTP or sender error from step 3-4.
- **"Too many emails or attempts".** Rate limit (section 4) or the 60-second per-address wait. Wait, then use **Send the code again**.
- **The email has a link but no code.** The template still lacks `{{ .Token }}` (section 2). Remember there are two templates: **Confirm email change** (linking) and **Magic Link** (signing in).
- **"That code is not correct or has expired".** The code was mistyped, older than the expiry, already used, or replaced by a newer one (only the latest works). Request a new one. Check **Email OTP Length** is 6.
- **Linking never accepts a code that looks right.** If the Confirm email change template contains `{{ .TokenNew }}` instead of `{{ .Token }}` (or the other way round), use the other one; this has not been tried on the real project (see below).
- **"This email already belongs to a TrainHive account".** The address is already linked to another account. Sign out of this account and use **I already have an account**, or use a different address.
- **Sign-in shows "Signing in with an email is not available right now".** The Email provider is off (section 1, step 1).
- **Linking seems to work but the account stays anonymous.** **Confirm email** is off or the code was never confirmed; the account is only secured after **Confirm email** succeeds.

## 7. What is not verified

The app was built from the installed `@supabase/supabase-js` 2.119 types and tested with unit tests only. Not yet run against the hosted project: that the "Confirm email change" email for an anonymous user carries `{{ .Token }}` (not `{{ .TokenNew }}`), that `verifyOtp({ type: 'email_change' })` accepts it and clears `is_anonymous`, that "Email already registered" is reported as `email_exists`, the exact built-in rate limits, and that deleting the account removes the email. The two-device test above verifies all of these; report any difference.

## 8. Limits to know

- There is **no "remove email"**: Supabase cannot detach the only identity of a user. Deleting the account removes the email (`docs/CLAIMS_AUDIT.md` E4/E5).
- The **data download** does not include the email yet (it is held by Supabase Auth, outside the export function).
- Whoever can read the member's mailbox can sign in as them. The terms tell members to add only an address of their own.
- A member who loses both the phone and access to the mailbox cannot recover the account (same as before linking).
