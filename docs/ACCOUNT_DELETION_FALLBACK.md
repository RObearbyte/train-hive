# Account deletion fallback: owner guide (Edge Function `delete-account`)

**Status: built and tested against the embedded test database only. Nothing has been deployed, and the function has never run on the hosted project, against the real Supabase Auth, or from the app.** The app does not call it.

## When to use it

Only if the normal in-app deletion fails on the hosted project. "Delete my account" in the app calls the database function `delete_my_account`, which erases the member's data and, as its last step, runs `delete from auth.users ...` inside the database. Whether the hosted project allows that statement has never been checked (`docs/API_CONTRACT.md`, `delete_my_account`, "Hosted note").

Check once, after the migrations are pushed:

1. In the app, create a throwaway account (join the test community), then use the app's **Delete my account** action.
2. In the Supabase dashboard, **SQL Editor**, run (with the throwaway account's id from **Authentication > Users** before deleting it):
   ```sql
   select count(*) from auth.users where id = '<id>';
   select count(*) from auth.identities where user_id = '<id>';
   ```
   Both must return 0.

If the deletion worked: **do nothing**, keep this function undeployed.

If the app showed an error and the account still exists (typically a "permission denied for table users" error in **Logs > Postgres**), the database is not allowed to delete Auth users. Then deploy this fallback, and tell the lead: the app must be changed to call the function instead of `delete_my_account` (a separate mobile task; this guide does not change the app).

## What it does

For one request, with the member's access token in the `Authorization` header:

1. Checks the token with Supabase Auth and takes the member's id **from the token only** (nothing in the request body is used).
2. Calls `my_deletion_blockers()` as the member: the last organizer of a community that still has members is refused, exactly like in the app.
3. Calls `admin_erase_user_data(id)` with the service role key: the same erasure as `delete_my_account` (same locks, same checks, same data deleted or anonymized), but it leaves the Auth user in place.
4. Deletes the Auth user with the Auth admin API (`auth.admin.deleteUser`). That also removes the member's consent records, sessions and sign-in identities.

If step 4 fails, the member's data is already gone and only the empty Auth user is left; calling the function again with the same token finishes the job.

## Deploy (Windows, PowerShell)

Prerequisites: the project is linked (`npx supabase@latest link`) and the migration `20261203000100_invitation_duration.sql` has been pushed (it creates `admin_erase_user_data`).

```powershell
npx supabase@latest functions deploy delete-account
```

- Do **not** add `--no-verify-jwt`: this function is called by signed-in members, so the platform's JWT check stays on (`supabase/config.toml`, `[functions.delete-account] verify_jwt = true`).
- **No secrets to set.** The function only uses `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, which Supabase provides to every Edge Function automatically. Never put the service role key in the app.

Check it is listed: dashboard **Edge Functions** > `delete-account`.

## Try it once (throwaway account only)

The app is not wired to it, so test with a throwaway account's access token. One way: sign in with the throwaway account in the web build, open the browser developer tools > **Application** > **Local Storage**, and copy `access_token` from the `sb-...-auth-token` entry. Then:

```powershell
$token = '<access token of the THROWAWAY account>'
Invoke-RestMethod -Method Post -Uri 'https://<project-ref>.supabase.co/functions/v1/delete-account' -Headers @{ Authorization = "Bearer $token" }
```

Expected: `ok: True` with the deletion summary; then the two SQL checks above return 0. A last organizer of a community with other members gets HTTP 409 `last_organizer` and nothing is deleted. Do not paste a real member's token anywhere.

## Answers

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `{ ok: true, user_id, communities_deleted, memberships_deleted, ... }` | Deleted. |
| 401 | `{ error: 'not_authenticated' }` | No, malformed or rejected token, or the account is already gone. |
| 405 | `{ error: 'method_not_allowed' }` | Only `POST` is accepted. |
| 409 | `{ error: 'last_organizer', details: { communities: [...] } }` | Promote another organizer first. Nothing was deleted. |
| 500 | `{ error: 'auth_delete_failed', data_erased: true, retry: true }` | Data erased, Auth user left: call again with the same token. |
| 500 | `{ error: 'deletion_failed' }` | Unexpected database error; nothing was deleted by the function. See **Edge Functions > delete-account > Logs** (error codes only, no tokens or ids). |
| 503 | `{ error: 'auth_unavailable' }` | Supabase Auth could not be reached; try again. |

## Not verified

- That the hosted project refuses (or allows) `delete from auth.users` inside `delete_my_account`.
- That `select ... for update` on `auth.users` (taken by the erasure's locks, also in this fallback) is allowed for the database owner on hosted. If it is not, the fallback fails as well and the lead must change the lock.
- The real `auth.getUser` / `auth.admin.deleteUser` calls (the tests use stand-ins for those two steps; everything in the database is the real code).
- Projects that have switched to the new API keys: if `SUPABASE_ANON_KEY` is not provided to Edge Functions any more, the function answers `server_misconfigured`; tell the lead.
