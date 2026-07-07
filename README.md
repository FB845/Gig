# 📊 Gig Tracker

A private, on-device **Progressive Web App** for tracking earnings, expenses,
and trends across your **Amazon Flex** and **DoorDash** gigs. Install it to your
iPhone or Android home screen and it works like a native app — offline, with no
accounts and no server. All your data stays in your browser.

![Amazon Flex + DoorDash gig tracker dashboard](icons/icon-512.png)

## Features

- **Dashboard KPIs** — net income, effective **$/hour**, **$/mile**, and
  **$/delivery**, for the week, month, year, or all time.
- **Charts** — earnings over time (stacked by platform), platform split,
  expense breakdown, weekly net, hourly-rate trend, income-vs-expenses, and your
  best day of the week.
- **Fast logging** — log a shift (platform, hours, base pay, tips, deliveries,
  miles, fuel) with live $/hr, $/mi and tax-deduction math as you type.
- **Expense tracking** — fuel, tolls, maintenance, insurance, phone, supplies,
  and more, with category breakdowns.
- **Tax help** — IRS **standard-mileage-deduction** estimate (rate editable in
  Settings; defaults to $0.70/mi).
- **Assisted automation** *(see below)* — 📸 screenshot import (OCR), 📄 CSV
  import, and ✉️ email-assisted import.
- **Backup & restore** — export/import a JSON backup, export shifts to CSV.
- **Offline + installable** — full PWA with a service worker.

## How the "automation" works (and its limits)

Neither Amazon Flex nor DoorDash offers a public API for drivers to pull their
earnings, and a private on-device app can't log in to your gig accounts. So there
is no true background auto-sync. Instead there are three assisted paths:

1. **📸 Screenshot import (OCR)** — On the **Import** tab, snap or upload a photo
   of your Flex or Dasher earnings screen. The app runs on-device OCR
   (Tesseract.js) and pre-fills the earnings, tips, miles and delivery count for
   you to review and save. *First use needs internet to download the OCR engine
   (~a few MB); after that it's cached.*
2. **📄 CSV import** — Import DoorDash's earnings export (or any spreadsheet with
   date / earnings / miles / deliveries columns). Columns are auto-detected; you
   preview before importing.
3. **✉️ Email-assisted import** — Flex and DoorDash email you every payout. Ask
   Claude (with your Gmail connected) to pull those deposit emails and generate a
   CSV, then import it with path #2. This is the closest thing to automatic.

## Use it

### Option A — GitHub Pages (recommended, free)
This repo includes a workflow that publishes the app to GitHub Pages on every
push to the default branch.

1. In your repo: **Settings → Pages → Build and deployment → Source: GitHub
   Actions**.
2. Push to the default branch (or merge this branch). The **Deploy to Pages**
   workflow builds and publishes it.
3. Open the published URL on your phone.

### Option B — any static host
It's plain static files. Drag the folder into **Netlify Drop**, **Vercel**,
**Cloudflare Pages**, or serve it yourself. A service worker + `manifest` require
**HTTPS** (or `localhost`) to install as a PWA.

### Option C — run locally
```bash
npm start        # serves at http://localhost:8080 (python3 http.server)
# then open http://localhost:8080
```

## Install to your phone (use it like an app)

- **iPhone (Safari):** open the site → tap **Share** → **Add to Home Screen**.
- **Android (Chrome):** open the site → menu → **Install app** (or the in-app
  Install button in Settings).

Once installed it launches full-screen and works offline.

## Your data

Everything is stored **locally in your browser** (`localStorage`) — private, no
account, no server. That also means:

- **Back up regularly.** Settings → **Export backup (JSON)**. Clearing your
  browser data (or deleting the installed app) erases everything.
- Restore anytime with Settings → **Restore from backup** (merge or replace).

## Project layout

```
index.html              app shell (tabbed: Home / Log / Trends / Import / Settings)
css/app.css             styles (dark + light, mobile-first)
js/store.js             on-device data model + metrics ($/hr, $/mi, net, deduction)
js/charts.js            dependency-free SVG bar / line / donut charts
js/parse.js             CSV parsing + OCR/free-text field extraction
js/ocr.js               lazy Tesseract.js loader for screenshot OCR
js/app.js               UI wiring
manifest.webmanifest    PWA manifest
sw.js                   offline service worker
icons/                  generated PWA icons
scripts/                icon generator + headless smoke test + screenshot tool
```

## Development

```bash
npm test         # headless browser smoke test (drives the real UI + unit checks)
npm run icons    # regenerate PWA icons (pure Python, no deps)
npm run shots    # generate seeded screenshots
```

The smoke test uses `playwright-core` against the pre-installed Chromium; install
it with `npm install --no-save playwright-core` if needed.

---

Built as a personal tool. Not affiliated with Amazon or DoorDash.
