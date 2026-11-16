# Putting TrainHive on the web

TrainHive also runs in a browser (phone or computer), so people can join a community, see trainings and answer "going" without installing anything. The web version is a static website: a folder of files you upload to a hosting service. This guide uses Windows and the free plans of Netlify or Cloudflare Pages.

## What you need first

- The hosted Supabase project from `docs/SUPABASE_SETUP.md` (URL and anon key).
- Node.js installed (the same one you use for the app).

## 1. Decide the address

You get a free address such as `https://trainhive.netlify.app` when you deploy. You need to know it **before** building, because invitation messages contain a link to it. Two ways:

- Pick the name first: on Netlify, create the site (step 3) and choose the name `trainhive-yourname`; the address is then `https://trainhive-yourname.netlify.app`.
- Or build twice: the first time without `EXPO_PUBLIC_WEB_APP_URL`, deploy, note the address, then build again with it and upload again.

## 2. Build

Open PowerShell in the project folder (`D:\GitStuff\train-hive`) and run, replacing the three values:

```powershell
$env:Path += ";C:\Program Files\nodejs"
$env:EXPO_PUBLIC_SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co"
$env:EXPO_PUBLIC_SUPABASE_ANON_KEY = "YOUR-ANON-KEY"
$env:EXPO_PUBLIC_WEB_APP_URL = "https://trainhive-yourname.netlify.app"
npx expo export --platform web
```

The result is the folder `dist`. Important:

- The three `EXPO_PUBLIC_...` values are **baked into the files at build time**. Changing them later means building and uploading again.
- Only the anon key goes in. Never the `service_role` key.
- If `.env.local` exists it is used for values you did not set in PowerShell; values set in PowerShell win.
- `EXPO_PUBLIC_WEB_APP_URL` has no trailing path or `?query`. A sub-path such as `https://example.com/trainhive` is accepted, but then the whole site must be served from that sub-path, which this guide does not cover. Use a domain or sub-domain of its own.

Check locally before uploading (optional): `npx expo serve`, then open http://localhost:8081.

## 3. Deploy

### Netlify (drag and drop)

1. Create a free account at https://app.netlify.com.
2. Go to **Sites**, then drag the **`dist`** folder onto "Drag and drop your site output folder here".
3. Wait for the green "Published". Open **Site configuration > Change site name** to choose the address.
4. The file `dist/_redirects` (copied from `public/_redirects`) makes every address open the app. It is already there.

### Cloudflare Pages

1. Create a free account at https://dash.cloudflare.com, then **Workers & Pages > Create > Pages > Upload assets**.
2. Name the project (this becomes `https://NAME.pages.dev`), upload the `dist` folder, and deploy.
3. `_redirects` works on Cloudflare Pages as well.

### Vercel (if you prefer it)

Vercel needs a rewrite instead of `_redirects`. Put a file `vercel.json` next to the `dist` folder content (or inside it before uploading with `vercel --prod dist`):

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

## 4. Custom domain (optional)

- Netlify: **Domain management > Add a domain**. Cloudflare Pages: your project > **Custom domains**.
- Follow the DNS instructions the service shows. HTTPS is automatic.
- After the domain works, set `EXPO_PUBLIC_WEB_APP_URL` to it, build again, upload again, so invitation links use the new address.

## 5. Tell Supabase the web address

In the Supabase dashboard: **Authentication > URL Configuration**.

- **Site URL**: your web address, for example `https://trainhive-yourname.netlify.app`.
- **Redirect URLs**: add the same address and `https://trainhive-yourname.netlify.app/**`.

TrainHive signs in anonymously today, so nothing breaks without this, but email or social sign-in added later needs it. Browser requests to Supabase work from any origin by default (CORS is open for the Supabase API), so nothing else is required. The anonymous sign-in must be on and CAPTCHA off, exactly as for the mobile app.

## 6. Optional security headers

Static hosts let you set headers. Not required, but recommended.

**Netlify**: create `public/_headers` in the project before building:

```
/*
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

`style-src 'unsafe-inline'` is needed because the app styles are applied by script. Cloudflare Pages uses the same `_headers` file format. If something stops working after adding the policy, open the browser console (F12): blocked requests are listed there. The page already contains `<meta name="referrer" content="no-referrer">`, so the invitation code in a join link is never sent on to other sites even without headers.

## 7. Try it on a phone

Open your web address in the phone browser (Chrome, Safari). Send yourself an invitation message (Profile > Invitations > Copy message) and open its first link: the code is filled in already, you only choose a name. "Add to Home Screen" gives an app-like icon (the icon is a placeholder for now).

## How join links work

An invitation link looks like `https://your-address/join#code=ABCD-EFGH`. The code is after `#` (the "fragment"). Browsers never send the fragment to the server or to other sites, so your hosting service never sees codes in its logs. The app reads the code, removes it from the address bar at once, and keeps it only in memory. Reloading the page does not bring it back (open the link again).

## What is different on the web

- **No push notifications.** Announcements and notifications still appear in the Activity tab, and the Profile screen says so.
- **The account lives in that browser.** There is no password. Clearing site data, using a private window, or switching browser or device means a new account: ask for a new invitation. Use the same browser each time.
- **Two tabs are fine.** The session is stored in `localStorage` under the key `trainhive-auth`; the Supabase client coordinates token refresh between tabs of the same browser with a browser lock, so tabs do not invalidate each other.
- Dates and times use the browser's own pickers.
- Live updates use a secure websocket to Supabase (`wss://`); the headers example above allows it. Not yet checked against a real project.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Blank page, console says "Unexpected token '<'" | The host serves `index.html` for script files: the site is not at the domain root, or `dist` was not uploaded whole (the `_expo` folder must be there). Upload the `dist` folder content, host at the root. |
| 404 "Page not found" when you refresh or open a link like `/join` | The redirect rule is missing. Netlify/Cloudflare: check `_redirects` is in the uploaded folder (rebuild; it comes from `public/`). Vercel: add `vercel.json`. |
| "Backend not configured" screen | The Supabase variables were not set when you built. Set them in PowerShell and build again; uploading is needed again. |
| Invitation message has no web link | `EXPO_PUBLIC_WEB_APP_URL` was empty or not a plain http(s) address (no spaces, no `?` or `#`) at build time. |
| "Can't reach TrainHive" | Browser offline, or wrong Supabase URL or key baked in. Check the console (F12) for the failing request. |
| Sign-in fails, console shows 4xx from `/auth/v1/signup` | Anonymous sign-ins are off in Supabase, or CAPTCHA is on (see `docs/SUPABASE_SETUP.md`). |
| Changes you made are not visible | The old version is cached. Hard-reload (Ctrl+F5), and make sure you uploaded the new `dist`. |
