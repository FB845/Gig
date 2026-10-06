# Public App Store version — brief

Handoff for the next phase: turning this personal tracker into a public iOS
app for **American delivery and rideshare drivers**.

## Decisions so far

- **Audience:** US delivery + rideshare drivers in general (DoorDash, Uber Eats,
  Instacart, Spark, Grubhub, Amazon Flex, Uber, Lyft, …).
- **Look:** drop the Japanese station / 白色LED identity for the public
  version. The personal build can keep it.
- **Design direction (picked 2026-10-06): C · Mile Marker.** Three directions
  were sketched on the design canvas
  (https://claude.ai/artifact/R7dscZotpk1kYKusa1fQqs, page "Public app · 3
  directions"): A · Ledger (clean iOS finance), B · Hustle (bold and friendly),
  C · Mile Marker (US highway signs). C won because it looks made for people
  who drive, not generic. Its boards (row C) are the reference for the build:
  - Type: Overpass for text, Overpass Mono for figures. Both are OFL fonts.
    Bundle them with the app; don't load them from Google Fonts.
  - Colour: guide-sign green (`#0B6B3A` by day, `#0E7A44` at night) with a white
    inset border; warning yellow (`#F4C20D` / `#FFD23F`) for "heads up" and the
    goal line; asphalt (`#2A2E2B` / `#232825`); rest-area blue (`#1F4E9E`) for
    earned days off. Grounds: concrete `#E8EAE4` (light), `#0B0E0C` (dark,
    "night driving").
  - Metaphors: today's goal is a guide sign ("$58 TO GO ↗"); today's progress is
    a road with a car marker; stats are mile-marker posts; the week is a
    **route** of stops (one per day) climbing towards a dashed goal line; an
    earned day off is a "REST AREA" sign; an open slot is a yellow-diamond "open
    lane"; GPS miles show on an odometer.
  - Restraint rule: signs only on the hero surfaces (today sign, week summary,
    widgets, Live Activity). Everything else is plain cards and lists, or the
    theme turns kitsch.
  - Tabs: Today · Route · Log · Insights · Taxes.
- **Logo:** the route-line mark survives. Drop the LED dot grid and glow and
  draw it on a guide-sign plate (green, white inset border, white line, last
  stop filled). A one-colour glyph covers the Dynamic Island and notifications.
  See the "Mark + names" board.
- **Name candidates** (none checked yet): Milepost (fits C best), Takehome,
  Daymark; Gig Line for continuity, though "gig" is too generic to trademark.
  Avoid Dash / Flex / Spark / Uber / Lyft and names close to Gridwise, Stride or
  Everlance. Check the App Store, USPTO (TESS) and domains before choosing.

## What exists (reuse it)

- Vanilla-JS PWA, no build step: `index.html`, `css/app.css`, `js/*.js`.
  `js/store.js` is the whole data model + maths (goals with earned days off and
  roll-over, campaign pace, tax set-aside, $/hr/$/mi, best-hours heat map, slot
  estimates, gap-fill suggestions, planner). It has no DOM dependencies.
- Cloud sync: Firebase Auth + Firestore, one doc per record
  (`users/{uid}/records/{type}~{id}`), rules in `firebase/firestore.rules`,
  engine in `js/sync.js`. Project `gig-tracker-c0ad8` (config in
  `js/firebase-config.js`).
- Desktop planning desk (`js/desk.js`), Trends best-hours heat map
  (`js/besthours.js`), drive-mode GPS mileage (`js/geo.js`), OCR / CSV / calendar
  import (`js/ocr.js`, `js/parse.js`, `js/calendar.js`).
- Raycast extension (`raycast/`) reusing `store.js`, syncing over REST.
- Tests: `node scripts/smoke.mjs`, `node scripts/drive-test.mjs`,
  `node scripts/sync-test.mjs` (Firebase emulators), `cd raycast && npm test`.

## What must change for the public

1. **Generalize the model** (keep the personal setup as one configuration):
   - `CAMPAIGN` in `js/store.js` is hard-coded ($350/day, 2026-09-12 → 12-31).
     Make goals user-configured: daily / weekly / monthly targets, optional
     campaigns with dates, days-off rule on/off.
   - Platforms are `flex | doordash | other` + manual income. Add the common US
     apps; platform-specific extras (Flex block types, scheduled block length)
     only where they apply. Replace the JR train-type names with plain ones.
   - Tax: US-only to start; keep the IRS mileage rate + set-aside settings,
     label estimates clearly as "not tax advice".
   - Remove personal bits (TraceHaus defaults, bilingual JP labels, Campaign
     350 naming) behind configuration or out of the public build.
2. **First-run onboarding:** platforms you drive for, your goal, MPG/fuel,
   sign-in (optional; app works on-device).
3. **Native iOS** (Capacitor wrapping the web app is the fastest route; Swift
   for extension targets):
   - WidgetKit home/lock-screen widgets (today vs goal, week, next block).
   - Live Activity during a shift (earned so far vs goal).
   - Background location for mileage (the PWA only tracks in the foreground).
   - Vision text recognition for earnings screenshots instead of Tesseract.
   - Notifications (e.g. "you're $40 from today's goal").
   These also satisfy App Store Guideline 4.2 (no bare web wrappers).
4. **App Store requirements:** Sign in with Apple (required alongside Google,
   4.8); in-app account deletion (5.1.1(v)); privacy policy + privacy nutrition
   labels; data export; tax disclaimer; platform names only, no Amazon /
   DoorDash / Uber logos; a distinctive app name (check availability +
   trademark); Apple Developer Program ($99/yr).
5. **Business model:** to decide — e.g. free core, subscription for sync,
   planning desk, insights and widgets. Firebase usage then becomes a cost to
   watch (the incremental `ts`-based sync keeps reads low).

## Build plan

Phase 1 (design) is done. Every phase below keeps `npm test` and the Raycast
tests green, and each step lands as its own small PR.

### Phase 2A: generalize the model (`js/store.js`), no UI change

The safest first step: it changes maths and data only, and the personal app
must show exactly the same numbers afterwards.

- **Goal settings** replace the hard-coded `CAMPAIGN`:
  `goal: { period: 'day' | 'week' | 'month', amount, drivingDays: [1..6],
  daysOff: true, carryOver: true }`. The daily target is derived:
  `amount ÷ driving days in the period`; non-driving days have a $0 target.
- **Challenges** (the general form of Campaign 350): `{ id, name, start, end,
  daily }`. Inside a challenge's dates its daily target wins. They are a new
  synced collection, so add `challenges` to `SYNC_COLS`.
- **Goal engine:** `periodGoalStats` sums per-day targets instead of
  `daily × days`, so days off, roll-over and projections work for any goal.
  `campaignStats()` becomes `challengeStats(challenge)`. `deskWeek` and
  `desk.js` read the per-day target, not `CAMPAIGN.daily`.
- **Platform registry:** `{ id, label, kind: 'delivery' | 'rideshare' |
  'shopping' | 'blocks', jobNoun: 'orders' | 'trips' | 'batches', blocks? }`
  for DoorDash, Uber Eats, Instacart, Grubhub, Spark, Amazon Flex, Uber, Lyft
  and Other. Keep the ids `flex`, `doordash` and `other` so old data still
  matches. Block presets and tags apply to Amazon Flex only, with plain names
  (no JR train types).
- **Settings move into the synced data** (today they are local-only): goal,
  enabled platforms, vehicle (MPG and fuel price) and tax (mileage rate and
  set-aside %).
- **Personal bits become data:** the TraceHaus keyword in `calendar.js` becomes
  an "income keywords" setting. The JP labels stay in the personal UI only.
- **Migration v1 → v2:** an existing database gets the challenge "Campaign 350"
  (2026-09-12 → 12-31, $350/day), a 7-day weekly goal of $2,450 and the platforms
  Amazon Flex, DoorDash and Other.
- **Tests:** a golden test that loads a v1 snapshot, migrates it and checks that
  campaign, weekly and monthly stats match today's results to the cent. Add unit
  cases for driving days, carry-over across weeks, a challenge overlapping a
  weekly goal, and monthly goals.

### Phase 2B: the Mile Marker UI in the web app

- New `css/road.css` with light and dark tokens (follows the system setting).
  Overpass is bundled.
- Onboarding, 4 steps: apps you drive for → goal (board C1) → vehicle / MPG →
  optional sync sign-in. Everything works on-device without an account.
- Screens, in this order: Today (C2), Log (C3: shift, expense, income; scan
  screenshot), Route (C4: week plan with open-lane suggestions from
  `suggestSlots`), Insights (trends and the best-hours heat map restyled), Taxes
  (set-aside, mileage log export, "Estimate, not tax advice"), Settings (account,
  export, delete).
- English only on the public path. The planning desk (`desk.js`) keeps working
  in a desktop browser and gets restyled later (or becomes the iPad layout).
- Update `smoke.mjs` and the screenshot scripts for the new screens.

### Phase 3: iOS app (Capacitor + Swift)

Needs a Mac with current Xcode and the Apple Developer Program.

- **Local web assets:** Capacitor serves files from the app bundle. Add a small
  copy step (`scripts/build-www.mjs`; no bundler needed) and vendor the Firebase
  SDK, which `sync.js` currently imports from gstatic. Skip Tesseract on iOS.
- **Storage:** put `store.js` persistence behind an adapter. Keep localStorage
  on the web; on iOS write a JSON file in the app's documents folder, because
  iOS can clear WebView storage.
- **Sign-in:** native Apple and Google sign-in through a Capacitor Firebase
  Authentication plugin. Hand the credential to the JS SDK so `sync.js` keeps
  working. The web popup flow does not work inside the iOS app.
- **One custom Swift plugin**, `GigNative`:
  - `setWidgetSnapshot(json)` writes to App Group UserDefaults and calls
    `WidgetCenter.reloadAllTimelines()`.
  - `startShift / updateShift / endShift` drive the Live Activity (ActivityKit).
    Elapsed time uses `Text(timerInterval:)`, and updates come from the app
    (logged earnings, GPS miles), so no push server is needed.
  - `recognizeText(image)` uses Vision on-device and feeds the existing
    `parse.js`.
- **Widget extension (SwiftUI)** from board C5: small "Today's goal" sign, small
  week route, medium three-line guide sign, and lock-screen circular,
  rectangular and inline widgets. Refresh at midnight and at the start of the
  next planned block.
- **Background GPS:** a community background-geolocation plugin. Use
  when-in-use permission plus the background location mode while a shift is
  running (iOS shows the blue location indicator), not "Always". Info.plist
  must explain why location is used.
- **Notifications:** local notifications only ("$40 to today's goal", "Open
  lane in 30 min").
- **Account deletion** (Guideline 5.1.1(v)), in Settings → Delete account:
  1. Sign in again.
  2. Delete everything under `users/{uid}`.
  3. Revoke the Sign in with Apple token.
  4. Delete the Firebase user.
  5. Wipe local data.

  This works client-side, so the free Spark plan is enough. A Cloud Function
  needs the paid Blaze plan.

### Phase 4: App Store readiness and beta

- Privacy policy and support page on GitHub Pages (the workflow already
  exists).
- Privacy nutrition labels: precise location (app functionality), other
  financial info, and email / user ID only if signed in. No tracking.
- A "Not affiliated with DoorDash, Uber, Instacart, Amazon…" line, and platform
  names as text only.
- App Review notes: a demo account, and why the app uses background location.
- TestFlight with about 5–10 drivers, a mix of delivery and rideshare. Check
  that goal setup makes sense for rideshare, and how well screenshot scanning
  works for each app.

### Decisions still open

1. **The personal build.** Recommended: the Mile Marker app becomes the one
   app, and your setup is just data (the Campaign 350 challenge). The LED UI
   stays frozen on its branch rather than kept as a second theme, because two
   full UIs double every change. Needed before Phase 2B.
2. **Name.** Needed before Phase 3: the bundle ID is permanent, though the
   display name can change later.
3. **Sign-in providers.** Recommended: Apple + Google. Google keeps your current
   account working, and Apple is then required (Guideline 4.8). Email/password
   is optional.
4. **Business model.** Needed before submission. For example: a free on-device
   core plus a subscription for sync, Insights and widgets.
5. **Developer account type.** An individual account shows your name as the
   seller. An organization account needs a D-U-N-S number.
