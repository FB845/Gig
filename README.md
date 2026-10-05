# 📊 Gig Tracker

A private, on-device **Progressive Web App** for tracking earnings, expenses,
and trends across your **Amazon Flex** and **DoorDash** gigs. Install it to your
iPhone or Android home screen and it works like a native app — offline, with no
accounts and no server. All your data stays in your browser.

**Free forever. No accounts. No subscriptions. No paywalled "connection
credits."** It does the thing paid gig apps charge extra for — **automatic GPS
mileage tracking** — without asking for a cent.

![Amazon Flex + DoorDash gig tracker dashboard](icons/icon-512.png)

## Features

- **🚗 Automatic GPS mileage tracking** — tap **Start drive** and it runs a live
  odometer from your phone's GPS, then logs a **timestamped trip** (the kind of
  *contemporaneous* record the IRS actually wants) and rolls the miles straight
  into a shift. No more guessing your miles.
- **💰 Tax set-aside estimator** — shows how much to put aside for taxes on your
  net profit (self-employment + income tax rule-of-thumb, editable), plus your
  estimated take-home, using the larger of your real expenses or the standard
  mileage deduction.
- **Dashboard KPIs** — net income, effective **$/hour**, **$/mile**, and
  **$/delivery**, for the week, month, year, or all time. **Net income (and the
  tax set-aside / take-home) combines gig earnings with your manual non-gig
  income** (e.g. TraceHaus) for a true bottom line, while the per-unit rates
  ($/hour, $/mile, $/delivery) stay **gig-only** — manual income has no
  hours/miles/deliveries to divide by, so folding it in would distort them.
- **Charts** — earnings over time (stacked by platform, with an **Other income**
  segment for manual income), platform split,
  expense breakdown, weekly net, hourly-rate trend, income-vs-expenses, your
  best day of the week, and **Flex $/hour by block type** (which of Rapid
  Express / Express / Rescue / Normal actually pays best per hour).
- **🎯 Campaign 350** — a goal tracker for earning **$350/day, every day
  (2026-09-12 → 2026-12-31)**, combining gig income with manual income
  (e.g. TraceHaus). Shows today's hit/miss, earned-vs-goal-to-date,
  ahead/behind pace, required daily pace (flagged when you've fallen behind),
  current $350+ streak, a 14-day bar chart with a dashed $350 line, and a
  combined income ledger. It also tracks a **weekly goal of $2,450** ($350 × 7)
  and a **monthly goal** ($350 × the month's campaign days — Sept $6,650, Oct
  $10,850, Nov $10,500, Dec $10,850): hit one early and the card shows how many
  **days off** you've earned for the rest of that week/month. Work anyway on an
  earned day off and that income **rolls over**, lowering the next week's /
  month's goal by the same amount (overshoot on the day you hit the goal doesn't
  roll over — only income logged on the days off). Gig shift income is reused directly (never
  duplicated); non-gig income is logged with **Platform → Income** in the Log
  form and counts toward Campaign 350, the dashboard totals and tax — but never
  the gig $/hr, $/mi or per-delivery rates.
- **"Worth it?" offer calculator** — on the dashboard, punch in an offer's pay,
  miles and (optional) minutes for an instant **TAKE / MARGINAL / SKIP** verdict
  with $/mi and $/hr against your own minimums (set in Settings) and your
  historical averages.
- **Year-end tax summary** — in Trends, a per-year breakdown combining gig +
  manual income, standard-mileage vs actual-expense deduction, expenses by
  category, taxable profit, estimated tax and quarterly set-aside — with CSV
  export and Print / Save-PDF. (Estimate, not tax advice.)
- **📅 Planner + income trajectory** — in **Log → Plan**, pre-plan Flex blocks,
  Dashes and income with start–finish times and an **estimated** payout (leave
  it blank to use your recent $/hr on that platform × the planned hours). It
  warns when plans overlap and shows what each one does to this week's goal.
  The agenda groups plans by day; tap **Log it** on the day to open the real
  shift/income form prefilled (enter what you actually made), and the plan is
  marked *Logged ✓ — $92 vs $84 est*. Unlogged past plans show as *Missed*.
  On **Campaign 350**, plans become the **income trajectory**: a this-week +
  next-week chart (earned = solid, planned = dashed), striped "planned" segments
  on the today/weekly/monthly bars, "your plan reaches the goal on Fri → 2 days
  off" or "plan $881 more by Sun", and the days still under $350 even with the
  plan — where to stack more. Plans are forecasts only: they never count as
  income, so earnings, goals, rates and tax stay real.
- **📅 Calendar → planner** — on the **Import** tab (or *📅 Import calendar* on
  the Plan form), bring in blocks you've already scheduled: an **.ics** file
  exported from Google / Apple / Outlook Calendar, or a **screenshot** of your
  schedule (e.g. the Flex calendar), read on-device with OCR. Time zones,
  all-day events, durations, cancelled events and **weekly/daily repeating
  events** are handled; platform and pay are picked up from the event text
  ("Amazon Flex block $88" → Flex, $88). You review every entry first — work
  events are pre-ticked, everyday ones (dentist, gym) aren't, anything already
  in your planner is flagged, and you can fix the date, times, platform or
  estimate. Imports the next 60 days; past events are skipped.
- **One form for shifts + income** — pick **Income** under Platform (next to
  Amazon Flex / DoorDash / Other) to log non-gig money, with a **Flat rate |
  Paid by hour** toggle: flat takes an amount; hourly takes a rate plus time
  worked (same Duration / Start – Finish input) and works the amount out.
  Shifts and income share one date-sorted list in Log; editing an entry and
  switching its platform between a gig and Income converts it in place.
- **Flexible time entry** — toggle between **Duration** (hours + minutes) and
  **Start – Finish** clock times; the length is worked out for you, overnight
  shifts included (22:10 → 01:25 = 3h 15m). Your choice is remembered per
  device, editing a shift reopens it in the mode it was logged with, a Flex
  block preset fills the finish time from your start time, and a GPS drive
  prefills start/finish from when you started and stopped driving.
- **Fast logging** — log a shift (platform, time worked, base pay, tips,
  deliveries, miles, MPG) with live $/hr, $/mi, tax-deduction and **fuel-cost**
  math as you type. Fuel is **auto-calculated** from your miles, the shift's MPG
  (or a default vehicle MPG) and a fuel price — both set in **Settings** like the
  tax and mileage rates — and logged as a linked expense; no more typing dollar
  amounts at the pump.
- **Amazon Flex block tools** — one-tap **block-length presets** (1:00–4:30 +
  custom) for the scheduled block, **block-type tags** (Rapid Express, Express,
  Rescue, Normal), and an **actual-vs-scheduled %** so you can see how often you
  beat the clock (e.g. a 3:00 block finished in 2:15 = 75%).
- **Expense tracking** — fuel, tolls, maintenance, insurance, phone, supplies,
  and more, with category breakdowns.
- **Assisted import** *(see below)* — 📸 screenshot import (OCR), 📄 CSV
  import, and ✉️ email-assisted import.
- **Backup & restore** — export/import a JSON backup, export shifts to CSV.
- **Offline + installable** — full PWA with a service worker.
- **白色LED design** — the whole app is a white-LED Japanese station board on a
  pure-black screen: white dot-matrix numbers (pixel font **DotGothic16**) on
  panels with an unlit-dot grid, **split-flap 種別 tiles** (特急 red · 急行 orange
  · 快速 blue · 普通 green · 収入 white), a **発車標 departure board** whose 行先
  column — like every heading — **flips Japanese ⇄ English every 3 s**, all in
  sync (フレックス ⇄ AMAZON FLEX), a scrolling **まもなく marquee** on Campaign 350,
  an LED segment bar for today's $350, a blinking station clock, and
  **station-number badges** (GT01 · 350 · GT03…) as the menu. Charts get an LED
  dot lattice; planned money is always teal stripes. Motion switches off under
  the phone's reduce-motion setting. Each screen is laid out like a station
  board: an LED screen name in the header (ギグ線 · ホーム ⇄ GIG LINE · HOME), every
  list as 発車標 rows (種別 flap · date · 行先 + details · pay), Trends as LED bar
  rows, and a full-screen odometer in drive mode.
- **Desktop dashboard** — on wide screens the same board becomes an analytics
  dashboard: a sidebar of station badges with a live clock, a stat ticker, the
  **"Gig Line" route map** (earnings as numbered stations with a pulsing "you
  are here"), multi-column KPIs with sparklines and LED count-up numbers.
- **Planning desk (desktop · GT07 計画)** — a week timetable you plan on with the
  mouse: drag down a column to add a block, drag it to move, pull its bottom
  edge to resize (15-min snap). Each new block gets the platform that pays best
  in that slot and an estimate from *your* history for that weekday and hour.
  The week strip tracks earned + planned against the weekly goal and shows the
  day you'd hit it (and the free days that earns). **Fill the gap** ranks the
  best open slots from the last 90 days — hover to preview, + Add to plan —
  preferring ones that keep a free day free. Best-hours shading, overlap
  warnings, a block inspector, **copy last week**, and keys: N new · ←/→ week ·
  H shading · Del · ⌘D duplicate · ⌘Z undo. Everything it makes is an ordinary
  plan, so the phone's planner, Campaign 350 and cloud sync all see it.
- **Best hours (Trends)** — your $/hr by weekday × hour from shifts logged with
  start–finish times (pay spread over the minutes worked), gross or net of
  fuel + wear, by platform and period, coloured on your own scale (top fifth =
  best). Click a slot for details; **Plan this slot** opens the desk (or the
  plan form on a phone). Shows how much of your history has clock times —
  duration-only shifts count in totals but not on the clock. The same slot
  rates now pre-fill estimates in the phone planner and calendar import.

Amazon Flex block tags map to JR train types (種別): **Local (普通)**, **Rapid
(快速)**, **Express (急行)**, **Rapid Express (特急)** — shown as colour-coded
flaps on the departure board, in the form picker and the pay-by-block-type breakdown.

> **On GPS tracking:** phones only allow a web app to read location while it's in
> the **foreground**, so this is a "drive mode" you start when you head out and
> keep on screen — not silent background tracking. The trade-off for that is zero
> cost and zero account. While a drive is running the app holds a **screen wake
> lock** so the display doesn't sleep and silently stop tracking. The distance
> math filters GPS jitter (poor-accuracy fixes, stationary noise, and teleport
> glitches).

## Battery / energy

The whole UI is a **true-black OLED theme** — on OLED phones a black pixel is
physically off, so the background draws ~zero power. This matters most on the
Drive screen, which stays on for your whole shift: it's pure black with a
deliberately dimmed odometer. Also:

- No `backdrop-filter` blur (blur forces constant GPU repaints while scrolling).
- Animations/transitions collapse under the OS **reduce-motion** setting.
- The drive wake lock keeps the screen awake *without* forcing full brightness,
  so a black screen + wake lock is about the most efficient way to keep GPS
  tracking alive.

## How the automation works (and its limits)

**Mileage is fully automatic** — start a drive and GPS handles it. **Earnings**
are the hard part: neither Amazon Flex nor DoorDash offers a public API for
drivers to pull their pay, and a private on-device app can't log in to your gig
accounts, so there's no true background earnings sync (this is also what apps
like GigReal charge extra "connection credits" for). Instead there are three
assisted paths to get earnings in fast:

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

**Updates:** when a new version is deployed, the app detects it and shows a
"New version available — Refresh" banner. Tap **Refresh** to update on the spot;
nothing reloads out from under you until you do.

## Your data

By default everything is stored **locally in your browser** (`localStorage`) —
private, no account, no server. That also means:

- **Back up regularly.** Settings → **Export backup (JSON)**. Clearing your
  browser data (or deleting the installed app) erases the local copy.
- Restore anytime with Settings → **Restore from backup** (merge or replace).

## Cloud sync (optional) — plan on desktop, log on your phone

Cloud sync is **opt-in**; the app works fully on-device without it. It uses
**your own free Firebase project** (the free Spark plan is plenty), so your data
stays in an account you control.

### One-time setup (~10 minutes)

1. At **console.firebase.google.com**, create a project (Analytics not needed),
   then **Add app → Web** and copy the `firebaseConfig` object.
2. **Build → Authentication → Sign-in method**: enable **Google** (and
   **Email/Password** too if you'd like a fallback). Under **Settings →
   Authorized domains**, add the site's domain (e.g. `fb845.github.io`).
3. **Build → Firestore Database**: create a database (production mode), then
   paste the rules from [`firebase/firestore.rules`](firebase/firestore.rules)
   into the **Rules** tab and **Publish**. They let each signed-in user read and
   write only their own records.
4. Put the config in the app (this repo already ships one, for the
   `gig-tracker-c0ad8` project) — either:
   - **Built in (recommended):** paste it into `js/firebase-config.js`
     (`export const FIREBASE_CONFIG = { … }`) and deploy. These values are
     public identifiers, not secrets; the rules and authorized domains protect
     your data. Every device then just shows **Sign in with Google**.
   - **Per device:** leave that file as is and paste the config into
     **Settings → Cloud sync** on each device.
5. **Settings → Cloud sync → Sign in with Google** on each device. Use the same
   sign-in method everywhere (if Google's popup can't open in the iPhone
   home-screen app, use **Use email instead** on *every* device).

### How it works

- **One document per record** at `users/{uid}/records/{type}~{id}` — each shift,
  plan, expense, trip, income entry and the settings sync on their own, so
  planning on desktop while logging on your phone merges cleanly. Only changed
  records are uploaded.
- **Deletes sync too** (a small "deleted" marker stays in the cloud so the record
  doesn't come back from another device).
- **Conflicts:** if both devices edit the *same* record before syncing, the last
  one to sync wins. Different records never conflict.
- **First sign-in on a device** merges what's on it with what's in the cloud:
  nothing is lost, and the cloud's settings are kept (a new phone won't reset
  your desktop's fuel price or MPG).
- **Offline:** changes queue on the device and upload when you're back online;
  live updates arrive from your other devices within a second or two.
- **Cheap:** each device only downloads records changed since it last synced.
- Erase all data / restore from a backup while signed in applies to every
  synced device.

The two-device behaviour (live updates, simultaneous edits, deletes, offline
merge, settings, the security rules, Google sign-in) is tested against the
Firebase emulators: `node scripts/sync-test.mjs` (needs `firebase-tools` and
Java; see the script header).

## Project layout

```
index.html              app shell (tabbed: Home / Log / Trends / Import / Settings)
css/app.css             styles (dark + light, mobile-first)
js/store.js             on-device data model + metrics ($/hr, $/mi, net, tax)
js/charts.js            dependency-free SVG bar / line / donut charts
js/parse.js             CSV parsing + OCR/free-text field extraction
js/ocr.js               lazy Tesseract.js loader for screenshot OCR
js/geo.js               GPS auto-mileage tracker (Haversine + jitter filtering)
js/sync.js              optional Firebase cloud sync (one Firestore doc per record)
js/desk.js              desktop planning desk (week timetable, drag to plan, fill the gap)
js/besthours.js         Trends best-hours heat map ($/hr by weekday × hour)
js/firebase-config.js   your Firebase web config (null = paste it in Settings)
firebase/               Firestore security rules + emulator config
js/calendar.js          .ics + schedule-screenshot parsing for the planner
fonts/                  bundled pixel fonts (DotGothic16 subset, Silkscreen) + their OFL licences
js/app.js               UI wiring
manifest.webmanifest    PWA manifest
sw.js                   offline service worker
icons/                  generated PWA icons
scripts/                icon generator + headless smoke test + screenshot tool
```

## Development

```bash
npm test         # headless smoke test + GPS drive end-to-end (simulated movement)
npm run icons    # regenerate PWA icons (pure Python, no deps)
npm run shots    # generate seeded screenshots
```

The smoke test uses `playwright-core` against the pre-installed Chromium; install
it with `npm install --no-save playwright-core` if needed.

---

Built as a personal tool. Not affiliated with Amazon or DoorDash.

**Fonts:** DotGothic16 (© 2020 The DotGothic16 Project Authors) and Silkscreen
(© 2001 The Silkscreen Project Authors) are
used under the SIL Open Font License 1.1 (see `fonts/`). DotGothic16 is bundled
as a subset — Latin, all kana and the kanji the app uses — so it works offline
at ~50 KB; other characters fall back to the system font.
