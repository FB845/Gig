// Tests for scripts/install-claude-desktop.mjs (the safe config merge).
import { mergeConfig } from '../scripts/install-claude-desktop.mjs';

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const S = '/Users/me/Gig/mcp/server.mjs', N = '/opt/homebrew/bin/node';
const entry = { command: N, args: [S] };
const parse = (r) => JSON.parse(r.text);
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

console.log('\nInstall into Claude Desktop (config merge)');

// the reported mistake: snippet pasted after the existing object
const existing = JSON.stringify({ preferences: { sidebarMode: 'chat', coworkEnabled: true }, mcpServers: { filesystem: { command: 'npx', args: ['x'] } } }, null, 2);
const pasted = `${existing}\n{\n  "mcpServers": {\n    "gig-tracker": { "command": "node", "args": ["/old/path/server.mjs"] }\n  }\n}\n`;
let r = mergeConfig(pasted, S, N);
let c = parse(r);
ok(c.preferences.coworkEnabled === true && c.mcpServers.filesystem.command === 'npx', 'a second pasted { … } block is merged; existing settings and servers are kept');
ok(JSON.stringify(c.mcpServers['gig-tracker']) === JSON.stringify(entry) && /second/.test(r.notes[0]), 'gig-tracker points at this install\'s node and server (the pasted old path is replaced)');

r = mergeConfig('', S, N);
ok(JSON.stringify(parse(r)) === JSON.stringify({ mcpServers: { 'gig-tracker': entry } }), 'an empty file becomes a config with just gig-tracker');

r = mergeConfig(existing, S, N);
ok(Object.keys(parse(r).mcpServers).join() === 'filesystem,gig-tracker' && parse(r).preferences.sidebarMode === 'chat', 'a normal config keeps its other servers and adds gig-tracker');

const again = mergeConfig(r.text, S, N);
ok(again.text === r.text && /Updated/.test(again.notes.join()), 'running it twice changes nothing more');

ok(/Nothing was changed/.test(throws(() => mergeConfig('{ "a": 1 } this is not json', S, N))), 'extra text that isn\'t JSON is refused, not guessed at');
ok(/Nothing was changed/.test(throws(() => mergeConfig('{ "a": ', S, N))), 'a truncated file is refused');
ok(/Nothing was changed/.test(throws(() => mergeConfig('{ "mcpServers": [] }', S, N))), 'a malformed mcpServers is refused');
ok(/Nothing was changed/.test(throws(() => mergeConfig('[1,2]', S, N))), 'a non-object config is refused');

console.log(fails ? `\nCONFIG MERGE: ${fails} FAILED` : '\nCONFIG MERGE: ALL PASSED ✓');
process.exit(fails ? 1 : 0);
