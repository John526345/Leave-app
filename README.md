# Somrak — Leave Tracker

A simple leave app for your team. Staff join through an invite link, request leave from their phone, their **department head approves it**, and HR gets a notification with a ready-made message to paste into your WhatsApp group.

Built for a small team (≈20 people, a few department heads, one HR manager). Everything is designed to work from a phone with as few taps as possible.

---

## How it works day to day

1. HR adds a staff member (name + email + who their department head is) → gets an invite link → sends it by email/WhatsApp/Telegram.
2. Staff open the link, set a password, and they're in.
3. Staff submit leave requests → the request goes to their **department head** to Approve or Reject.
4. When the department head decides, that's final. HR is **notified** in the Activity feed with a **📋 Copy for WhatsApp** button, and leave is deducted from the balance on approval.
5. If someone has **no department head** assigned, **HR approves** their request in one step.

**Leave types:** Annual, Sick, Compensate. Compensate days are earned when HR or the person's department head adds them (e.g. worked a Saturday). Weekends and **public holidays** are not counted as leave days. Half-days are supported.

---

## What's new in this version

- **Single-step approval** — the department head approves (or rejects); HR is simply notified. No second approval step.
- **Public holidays** — HR adds holidays (Settings → Public holidays); those dates are never deducted from anyone's leave.
- **HR reports (CSV)** — Settings → Reports → download a balances summary or all leave requests to open in Excel / Google Sheets.
- **Restore from backup** — Settings → Backup → restore a `.json` backup file (e.g. when moving hosts).
- **Runs on Netlify** — no server or database to manage; data is stored in Netlify Blobs and survives restarts and updates.

---

## Put it online with Netlify (recommended — no terminal, free tier works)

Netlify hosts the app for free and stores your data in **Netlify Blobs**, which is built in — there is no database or disk to set up. Deploy from GitHub so Netlify installs the app's one dependency and runs the build automatically.

### Steps

1. Create a GitHub repository and put **all the files from this folder at the top level** of it (so `package.json`, `netlify.toml`, `index.html` and the `netlify` folder are at the root — not inside another folder). The easiest reliable way: on GitHub, **Add file → Upload files**, then drag in every file **and** the `netlify` folder.
2. Create a free account at https://app.netlify.com.
3. In Netlify: **Add new site → Import an existing project** → connect GitHub → pick your repo.
4. Leave the build settings as detected — they come from `netlify.toml` (build command `mkdir -p public && cp index.html manifest.json icon.jpg public/`, publish directory `public`). Click **Deploy**.
5. When it finishes, open the address Netlify gives you (like `https://your-site.netlify.app`) and create the HR (admin) account — **the first person to open it becomes admin.**

> Tip: give the site a clear name in **Site configuration → Change site name**, e.g. `alongsiders-leave` → `https://alongsiders-leave.netlify.app`.

**Netlify Blobs is enabled automatically** for any Netlify site — you don't need to turn anything on. Your records persist across deploys and restarts, and pushing new code to GitHub never touches your data.

> **Fixing the earlier "Deploy directory 'public' does not exist" error:** that happened because the nested `public/` folder didn't upload to your GitHub repo. This version removes that dependency — `index.html`, `manifest.json` and `icon.jpg` now sit at the top level, and Netlify builds the `public` folder itself during deploy. Re-upload these files to your repo (replacing the old ones) and it will deploy successfully.

> **Avoid "Deploy manually" (drag-and-drop):** that method skips `npm install`, so the leave-request function won't have what it needs. Use the GitHub method above.

---

## Try it on your own computer first (optional)

Install Node.js (https://nodejs.org), then in this folder run:

```
node server.js
```

Open http://localhost:3000. Running locally uses a `data/db.json` file instead of Netlify Blobs, so you can experiment safely. (You don't need to install anything for local use — `node server.js` has no dependencies.)

---

## Other hosting options (need a persistent disk)

These run the standalone `server.js` and keep data in a `data/db.json` file, so they need a persistent disk. Config files `Dockerfile` and `fly.toml` are included.

- **Fly.io** — `fly launch --no-deploy --copy-config`, then `fly volumes create data --size 1 --region sin`, then `fly deploy`. Set the volume mount to `/data` and env `DATA_DIR=/data`.
- **Render.com (paid Starter plan)** — Start command `node server.js`; add a disk mounted at `/data`; set env `DATA_DIR=/data`. (Render's free plan wipes data on restart — don't use it for real records.)

If you're not sure which to choose, **use Netlify** — it's the simplest and needs no disk.

---

## Email notifications (optional but recommended)

When set up: a new request emails the department head · the department head's decision emails HR (for information) and the employee. Passwords can also be reset by email.

Setup (free, ~10 minutes):

1. Create a free account at https://www.brevo.com (300 emails/day free — far more than needed).
2. In Brevo: **Settings → Senders** → add the address the app sends from (e.g. hr@alongsiders.org) and click the confirmation link.
3. In Brevo: **Settings → API Keys** → generate a key → copy it.
4. Add two environment variables where the app is hosted:
   - On **Netlify**: Site configuration → **Environment variables** → add:
     - `BREVO_API_KEY` = the key you copied
     - `EMAIL_FROM` = the sender address you verified
   - On Fly/Render: add the same two variables in their dashboard.
5. Redeploy / save. In the app, **Settings → Email notifications** should show ✅.

---

## Good to know

- **Public holidays:** Settings → Public holidays. Add each holiday once; it applies to everyone and is never counted against leave. Add next year's holidays when the government announces them.
- **Reports:** Settings → Reports → download a CSV of balances or of every leave request, to open in Excel or Google Sheets.
- **Backups:** Settings → Backup → **Export backup** downloads everything as one file. Do it every week or two and keep it somewhere safe (Google Drive etc.). **Restore from backup** puts a backup file back — useful when moving hosts or recovering.
- **Forgot password (email set up):** staff use "Forgot your password?" on the login page.
- **Locked out with no email set up (e.g. the HR/admin account):** use the one-time recovery key.
  1. In Netlify: **Site configuration → Environment variables** → add a variable named **`RECOVERY_KEY`** with any secret text you choose.
  2. **Deploys → Trigger deploy → Deploy site**, and wait for it to finish (env-var changes only take effect after a redeploy).
  3. Go to `https://your-site.netlify.app/?recover=1` (or click "Locked out…" on the login page), enter the recovery key, your email, and a new password.
  4. You're back in. **Remove the `RECOVERY_KEY` variable** afterwards (and redeploy) so it can't be reused.
- **Staff who never joined:** use the 🔗 Invite button to resend a fresh link.
- **Security:** passwords are stored hashed (scrypt), never in plain text. Login sessions are signed and expire after 30 days.

---

## Files in this project

| File | What it is |
|------|------------|
| `core.js` | All the app logic (approvals, balances, holidays, reports) — shared by both hosting modes. |
| `netlify/functions/api.js` | The Netlify Function; stores data in Netlify Blobs. Used when hosted on Netlify. |
| `netlify.toml` | Netlify configuration (routing + where files live). |
| `server.js` | Standalone Node server for local use / Fly / Render (stores data in `data/db.json`). |
| `index.html` | The whole phone-friendly app (one file). |
| `manifest.json`, `icon.jpg` | "Add to Home Screen" app icon and name. |
| `Dockerfile`, `fly.toml` | For deploying the standalone server to Fly.io. |
