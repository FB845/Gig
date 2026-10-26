# Gig Tracker · Claude connection (MCP)

A small **read-only** server that lets Claude Desktop (and Cowork inside it),
Claude Code, or any MCP client look at your **live** Gig Tracker data — "where am
I on this week's goal?", "write my weekly summary", "when do I earn best on
DoorDash?" — without you exporting or pasting anything.

It reads your cloud-synced data the same way the Raycast extension does, keeps a
private copy on your computer, and computes everything with the app's own code,
so the numbers match what you see in the app. **It can't change anything.**

## Tools

| Tool | What it answers |
|---|---|
| `gig_status` | Where am I now: today vs the $350 goal, week / month / campaign progress, today's and upcoming plans, blocks waiting to be logged |
| `gig_week` | A week day by day: earned, planned, what's on each day, shortfall, best open slots |
| `gig_weekly_digest` | The same digest the app's Weekly summary sends to Claude (for "write my weekly summary") |
| `gig_stats` | Totals for a period: income, expenses, net, $/hr, $/mile, tax set-aside; by platform, weekday and Flex block type |
| `gig_best_hours` | When you earn best, by weekday × hour |
| `gig_records` | The raw shifts / plans / other income / expenses / trips, with filters |
| `gig_settings` | Rates, goal and the Flex standard rate |

Notes you typed on shifts, plans and expenses are left out unless Claude asks
for them (`include_notes`).

## Set up (about five minutes, on your Mac)

You need Node 20+ and this repo cloned on the computer where Claude Desktop runs.

1. **Install**
   ```sh
   cd Gig/mcp
   npm install
   ```
2. **Get your connection key** — in the app: **Settings → Cloud sync → Copy
   Raycast key** (the same key Raycast uses; you must be signed in). Save it
   where only you can read it:
   ```sh
   mkdir -p ~/.config/gig-tracker && chmod 700 ~/.config/gig-tracker
   pbpaste > ~/.config/gig-tracker/key && chmod 600 ~/.config/gig-tracker/key
   ```
   (`pbpaste` writes whatever is on your clipboard — copy the key first.)
   Treat the key like a password: anyone with it can read your tracker. Don't
   paste it into chats or commit it.
3. **Check it works**
   ```sh
   npm run doctor
   ```
   It should end with "All good" and show how many shifts and plans it can see.
4. **Add it to Claude Desktop** — the easy, safe way:
   ```sh
   npm run install-claude
   ```
   It backs up Claude Desktop's config file, keeps everything already in it, and
   adds the server with the right paths (it also repairs the common mistake of
   pasting a second `{ … }` block after the existing one). Then quit Claude
   Desktop completely (Cmd+Q) and reopen it. The tools appear under the
   connector menu in chats and in Cowork.

   *By hand instead:* Settings → Developer → Edit Config, and add an
   `"mcpServers"` entry **inside** the file's existing outer `{ }` (never a
   second `{ }` after it), using the full path to `node` (`which node`) as the
   command and the full path to `server.mjs` in `args`.

   *Claude Code instead:* `claude mcp add gig-tracker -- node /Users/YOU/Gig/mcp/server.mjs`

   If you'd rather not keep the key in a file, put it in the config instead:
   `"env": { "GIG_TRACKER_KEY": "gt1.…" }` — but then it sits in that config file.

## Cowork (and Claude Code): install it as a plugin

Claude Desktop's config file (step 4) makes the tools available in **regular
chats**. **Cowork** loads local servers through **plugins** instead, so build
one from your install:

```sh
cd Gig/mcp
npm run build-plugin
```

That writes `mcp/dist/gig-tracker.zip`. In Claude Desktop go to **Customize →
Plugins → Add → Upload plugin**, pick the zip, then start a **new** Cowork task.
The plugin carries this Mac's paths (build it on the Mac that runs the server)
and **no key** — the server still reads `~/.config/gig-tracker/key`.

It also adds a skill that tells Claude to use the tools instead of opening the
web app in a browser, and two commands: `/gig-tracker:status` and
`/gig-tracker:weekly`.

Anthropic's docs say a local server in a plugin works in Cowork through the
desktop app (so keep Claude Desktop open), and not in chat — which is why chat
uses the config file and Cowork uses the plugin. If Cowork still can't see the
tools, ask it "which gig-tracker tools do you have?" and check the server log:
`~/Library/Logs/Claude/` (look for `gig-tracker`).

## Using it

Ask in plain language, in a chat or a Cowork task:

- "Where am I on this week's goal, and what should I plan to cover the gap?"
- "Write my weekly summary for last week."
- "Which weekday and hours pay best on DoorDash? Does Flex Express beat Local?"
- "Pull my Flex shifts from September and tell me if my block-time use is slipping."

## Good to know

- **Fresh, not instant:** each question re-checks the cloud (cached for 20
  seconds, then only what changed is fetched). If the cloud can't be reached it
  answers from the last saved copy and says so.
- **Key expiry:** if you sign out of the app everywhere or change your Google
  password, the key can stop working — copy a fresh one and replace the file.
- **Privacy:** what Claude reads through these tools becomes part of that
  conversation. The cache lives in `~/.cache/gig-tracker-mcp/` (private to your
  user, `0600`). Delete it any time; it rebuilds.
- **Read-only on purpose.** Logging and planning still happen in the app or
  Raycast. (Letting Claude add plans, with a confirmation step, would be a
  natural next step.)
- **Claude.ai in the browser (Projects)** can't reach a server running on your
  computer — this works in Claude Desktop, Cowork and Claude Code.

## Development

```sh
npm test          # config merge + fake Firebase driven by the real MCP client; never touches your data
npm run doctor    # check your own setup
```

`lib/` is copied from the app (`js/store.js`, `js/plugins/weekly-summary.js`) and
Raycast (`raycast/src/lib/cloud.js`, `shim.js`) by `scripts/sync-core.mjs` on
`npm install` and before the tests, so there is one copy of the maths.
