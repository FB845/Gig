// npm run build-plugin — packages this server as a Claude plugin
// (mcp/dist/gig-tracker.zip) that you upload at Customize → Plugins → Add →
// Upload plugin. Cowork loads local MCP servers through plugins (not through
// claude_desktop_config.json), so this is how the tracker reaches Cowork.
//
// The plugin contains: the manifest, an .mcp.json that starts THIS install's
// server (absolute paths for your Mac — so build it on the Mac that will run
// it), a skill that tells Claude how to use the tools, and two commands.
// It does not contain your connection key; the server reads that from
// ~/.config/gig-tracker/key on your computer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const dist = process.env.GIG_PLUGIN_OUT || path.join(here, 'dist');
const root = path.join(dist, 'gig-tracker');
const zip = path.join(dist, 'gig-tracker.zip');
const server = path.join(here, 'server.mjs');

const write = (rel, text) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(zip, { force: true });

write('.claude-plugin/plugin.json', JSON.stringify({
  name: 'gig-tracker',
  displayName: 'Gig Tracker',
  version: pkg.version,
  description: 'Live, read-only access to your Gig Tracker data — earnings vs your goal, this week\'s plan, best hours, weekly summaries — from Claude. Runs a small local server on your computer.',
  author: { name: 'Gig Tracker (personal)' },
}, null, 2) + '\n');

write('.mcp.json', JSON.stringify({
  mcpServers: { 'gig-tracker': { command: process.execPath, args: [server] } },
}, null, 2) + '\n');

write('skills/gig-tracker/SKILL.md', `---
name: gig-tracker
description: Look up the driver's live Gig Tracker data — earnings today and this week, progress against the $350/day goal, planned blocks, best hours to work, weekly summaries, shifts, expenses and tax set-aside. Use whenever the user asks about their gig earnings, goal, plans, schedule, hours, or "where am I".
---

The user is a US delivery driver (Amazon Flex, DoorDash, other apps) tracking income in their own Gig Tracker app. The \`gig-tracker\` tools read their live data. Use them instead of asking the user to paste numbers, and **do not open the web app in a browser to find their data** — the browser has no data in it.

- "Where am I / how's today / this week?" → \`gig_status\` first.
- A week's schedule, gaps, what to plan → \`gig_week\` (it includes the best open slots).
- Write a weekly summary → \`gig_weekly_digest\`, then write it: what happened, what to watch, what to do next week. Use only numbers from the digest.
- Totals, $/hr, tax set-aside, by platform / weekday / Flex block type → \`gig_stats\`.
- When do they earn best → \`gig_best_hours\` (say so if the history is thin).
- Specific rows → \`gig_records\` (notes are left out unless asked for).

Money is US dollars, times are 24-hour HH:MM, dates are YYYY-MM-DD. The weekly goal is the user's own, with earned days off once it is met early. Flex blocks are estimated at the standard $26.50/hr; other platforms have no automatic estimate. The tools are read-only: to log or plan something, tell the user to use the app or Raycast.

If the tools aren't available, the local server isn't running — tell the user to check the Gig Tracker connection (mcp/README.md) rather than guessing numbers.
`);

write('commands/status.md', `---
description: Where am I today and this week against my goal
---

Call \`gig_status\`, then tell me in a few lines: today's earnings and what's left to the daily goal, how the week stands (earned, planned, shortfall, any days off earned), and my next planned blocks. Plain and specific.
`);

write('commands/weekly.md', `---
description: Write my weekly summary (last week, or this week so far)
---

Call \`gig_weekly_digest\` (use \`week: "last"\` if today is Monday or Tuesday, otherwise \`"this"\`; use any week I name). Then write a short summary: a one-line headline, what happened (best day, platform and block type, $/hr), what to watch, and 2–3 concrete things to do next week using the digest's plans and suggested slots. Only use numbers from the digest.
`);

write('README.md', `# Gig Tracker (Claude plugin)

Lets Claude look at your live Gig Tracker data — earnings vs your goal, the week's plan, best hours, weekly summaries — through a small read-only server that runs on your computer.

## Use it

Ask in Cowork or Claude Code, for example "where am I on this week's goal?", or run \`/gig-tracker:status\` or \`/gig-tracker:weekly\`.

## Data

The server runs locally and reads your cloud-synced Gig Tracker data with the connection key stored in \`~/.config/gig-tracker/key\`. The key is not part of this plugin. Anything Claude reads through the tools becomes part of that conversation. Nothing is written back.
`);

fs.mkdirSync(dist, { recursive: true });
try {
  execFileSync('zip', ['-r', '-q', zip, 'gig-tracker'], { cwd: dist });
} catch {
  console.error(`✓ plugin folder built: ${root}\n✗ couldn't run \`zip\` — compress that folder yourself (right-click → Compress) and upload the .zip.`);
  process.exit(1);
}
console.log(`\nClaude plugin built\n\n  zip:     ${zip}\n  runs:    ${process.execPath} ${server}\n\nNext: Claude desktop → Customize → Plugins → Add → Upload plugin → pick that zip.\nThen start a new Cowork task. (Build it on the Mac that will run the server — it contains this Mac's paths.)\n`);
