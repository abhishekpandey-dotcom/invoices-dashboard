# Deploying the Outstanding Invoices Dashboard to Vercel

## What you'll need
- A [Vercel account](https://vercel.com) (free tier works)
- Your two Stripe restricted API keys (India + US)
- A Google Cloud service account with Sheets API access
- A GitHub account to host the code

---

## Step 1 — Push the code to GitHub

1. Open PowerShell and run:
   ```
   cd C:\Users\DELL
   mkdir invoices-dashboard
   cd invoices-dashboard
   git init
   git remote add origin https://github.com/YOUR_USERNAME/invoices-dashboard.git
   ```
2. Copy the contents of the `invoices-dashboard` folder (from your Claude outputs) into `C:\Users\DELL\invoices-dashboard`.
3. Commit and push:
   ```
   git add .
   git commit -m "Initial invoices dashboard"
   git push -u origin main
   ```

---

## Step 2 — Create a Google Service Account

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable **Google Sheets API**
4. Go to **IAM & Admin → Service Accounts → Create**
5. Give it any name, click **Create**
6. Click the service account → **Keys → Add Key → JSON** → download the file
7. Open the JSON and copy:
   - `client_email` → this is your `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → this is your `GOOGLE_PRIVATE_KEY`

8. **Share your Google Sheet** with the service account email (Editor access)
9. Copy the Sheet ID from the URL:  
   `https://docs.google.com/spreadsheets/d/[SHEET_ID]/edit`

10. Make sure your Sheet has two tabs named exactly:
    - `Invoices`
    - `DSO`

---

## Step 3 — Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your `invoices-dashboard` GitHub repo
3. Framework: **Next.js** (auto-detected)
4. Click **Environment Variables** and add:

   | Variable | Value |
   |----------|-------|
   | `STRIPE_IN_SECRET_KEY` | `rk_live_...` (India restricted key) |
   | `STRIPE_US_SECRET_KEY` | `rk_live_...` (US restricted key) |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `your-sa@your-project.iam.gserviceaccount.com` |
   | `GOOGLE_PRIVATE_KEY` | Paste the private key (with `\n` for newlines) |
   | `GOOGLE_SHEET_ID` | The Sheet ID from step 2 |

5. Click **Deploy** — Vercel builds and deploys automatically (2–3 min)
6. Your shareable URL will be: `https://invoices-dashboard-yourname.vercel.app`

---

## Step 4 — Create Stripe Restricted Keys (read-only)

Never use your full secret key. Create restricted keys instead:

1. Go to **Stripe Dashboard → Developers → API Keys → Restricted Keys**
2. Click **Create restricted key**
3. Give read-only permissions to: **Invoices**, **Customers**
4. Do this separately for India account and US account
5. Copy each `rk_live_...` key into the Vercel env vars above

---

## How the dashboard works

- **Invoices tab**: Every open/past-due invoice from both Stripe accounts with aging badge
  - 🟢 0–30 days · 🟡 31–60 days · 🟠 61–90 days · 🔴 90+ days
  - Filters: account (India/US), aging bucket, free-text search
  - Click any column header to sort
  - "View ↗" links open the Stripe-hosted invoice PDF directly
- **DSO tab**: Days Sales Outstanding per customer (weighted average by invoice amount)
- **Export button**: Writes all data to your Google Sheet (Invoices + DSO tabs)
- Data auto-refreshes every 5 minutes via Vercel's ISR cache

---

## Keeping it private (optional)

Vercel doesn't have built-in auth on the free tier. Options:
1. **Vercel Password Protection** (Pro plan, $20/mo) — simple password on the whole site
2. **Add NextAuth.js** — Google SSO, only your domain can log in (free)
3. **Share the URL only with trusted people** — no credentials exposed, data is read-only

For now, the URL alone is the "password" — only people you share it with can find it.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Missing Stripe keys` | Check env var names match exactly (case-sensitive) |
| `Missing GOOGLE_PRIVATE_KEY` | In Vercel, paste the key with literal `\n` between lines |
| `Sheet not found` | Share the Sheet with the service account email (Editor) |
| `No invoices shown` | Confirm both Stripe accounts have open invoices and the restricted key has Invoices read permission |
