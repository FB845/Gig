# Public App Store version — brief

Handoff for the next phase: turning this personal tracker into a public iOS
app for **American delivery and rideshare drivers**.

## Decisions so far

- **Audience:** US delivery + rideshare drivers in general (DoorDash, Uber Eats,
  Instacart, Spark, Grubhub, Amazon Flex, Uber, Lyft, …).
- **Look:** drop the Japanese station / 白色LED identity for the public
  version. The personal build can keep it. Open question: whether the route-line
  logo mark (stations climbing a line, `icons/logo.svg`) survives as an abstract
  mark under a new English name.
- **First step:** design. Sketch three public-facing directions on the design
  canvas (https://claude.ai/artifact/R7dscZotpk1kYKusa1fQqs — add a new page),
  each across the key screens: first-run goal setup, home, log a shift, weekly
  plan / planning desk, and the iOS widget + Live Activity. Light and dark.
  Suggested axes: clean mainstream iOS finance · bold and friendly · one more
  distinct option. Pick one, then build.

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

## Suggested phases

1. Design directions on the canvas → pick one.
2. Generalize `store.js` + onboarding + the new UI in the web app (benefits the
   personal build too; keep tests green).
3. Capacitor iOS project + native extras (widget, Live Activity, background
   GPS, Sign in with Apple, account deletion).
4. TestFlight beta with a few drivers → App Store submission.
