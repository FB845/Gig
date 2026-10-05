# Gig Tracker for Raycast

Campaign 350 in your Mac's menu bar, plus quick commands — all synced with the
Gig Tracker app through your Firebase cloud sync.

| Command | What it does |
|---|---|
| **Campaign 350** (menu bar) | Today's $ vs $350 as the menu-bar title (✓ and green once you hit it). The menu shows today (earned, still planned, to go), this week (earned + planned vs the weekly goal, the day you'd meet it, days off), your next blocks (today's open straight into Log Shift), Campaign 350 pace, and shortcuts. Refreshes every 10 minutes. |
| **Today & This Week** | The same numbers as a list: today's plans (Log It / Delete), the week, the campaign. |
| **Log Shift** | Flex / DoorDash / other gig shift or other income (TraceHaus…). Fuel is added automatically from miles ÷ MPG, exactly like the app. |
| **Plan Block** | Plan a block; the estimate is pre-filled from your best-hours history for that weekday and time, with overlap and weekly-goal checks. |
| **Week Plan** | This / next week by day, the weekly goal, and **Fill the gap** — the best open slots from your last 90 days, one ⏎ to add. |

Raycast has no desktop widgets; its menu-bar command is the always-visible
"widget". ⌘ Open Planning Desk jumps to the app's desktop planner.

## Set up (once)

1. In the Gig Tracker app, sign in to cloud sync (**Settings → Cloud sync**),
   then tap **Copy Raycast key**.
2. On your Mac (Node 22+):
   ```bash
   cd raycast
   npm install
   npm run dev        # imports the extension into Raycast and keeps it updated
   ```
   (Stop `npm run dev` once it's imported — the extension stays in Raycast.)
3. Open any Gig Tracker command; Raycast asks for the **Connection Key** — paste
   it. In Raycast Settings → Extensions you can pin **Campaign 350** to the
   menu bar.

The key lets Raycast read and write *your* records only (the same Firestore
rules as the app). Treat it like a password. To revoke it, disable or delete
the user in Firebase console → Authentication (signing out of the app doesn't
invalidate keys already copied).

## How it works

- `src/lib/store.js` is **copied from the app** (`../js/store.js`) before every
  dev/build, so goals, estimates and suggestions use exactly the app's code.
- `src/lib/cloud.js` syncs over Firebase REST with the same record layout as
  the app (`users/{uid}/records/{type}~{id}`): opens instantly from a local
  cache, then downloads only records changed since the last sync; every action
  uploads only the records it changed (deletes as tombstones).
- `npm test` renders every command against a mock of `@raycast/api` with sample
  data; the two-device sync test in `../scripts/sync-test.mjs` also drives this
  client against the Firebase emulators.
