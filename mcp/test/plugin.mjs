// Tests for scripts/build-cowork-plugin.mjs: the Claude plugin zip.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

console.log('\nClaude plugin (Cowork)');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gig-plugin-'));
execFileSync('node', [path.join(here, '../scripts/build-cowork-plugin.mjs')], { env: { ...process.env, GIG_PLUGIN_OUT: out }, stdio: 'ignore' });

const root = path.join(out, 'gig-tracker');
const json = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const manifest = json('.claude-plugin/plugin.json');
ok(manifest.name === 'gig-tracker' && /^\d+\.\d+\.\d+$/.test(manifest.version) && manifest.description.length > 40, 'manifest: name, version, description');

const srv = json('.mcp.json').mcpServers['gig-tracker'];
ok(path.isAbsolute(srv.command) && fs.existsSync(srv.command) && path.isAbsolute(srv.args[0]) && fs.existsSync(srv.args[0]) && /server\.mjs$/.test(srv.args[0]), '.mcp.json starts this install\'s server with absolute paths that exist');

const skill = fs.readFileSync(path.join(root, 'skills/gig-tracker/SKILL.md'), 'utf8');
ok(/^---\nname: gig-tracker\ndescription: .{40,}\n---/.test(skill) && /gig_status/.test(skill) && /do not open the web app/.test(skill), 'skill: frontmatter matches its folder; tells Claude to use the tools, not the browser');
ok(['commands/status.md', 'commands/weekly.md'].every((f) => /^---\ndescription: .+\n---/.test(fs.readFileSync(path.join(root, f), 'utf8'))), 'two slash commands with descriptions');

const list = execFileSync('unzip', ['-Z1', path.join(out, 'gig-tracker.zip')], { encoding: 'utf8' }).split('\n').filter(Boolean);
ok(list.includes('gig-tracker/.claude-plugin/plugin.json') && list.every((f) => f.startsWith('gig-tracker/')) && !list.some((f) => /^gig-tracker\/bin\//.test(f)), 'zip: one top-level folder holding .claude-plugin/plugin.json, no bin/');

let leaked = false;
for (const f of list.filter((x) => !x.endsWith('/'))) {
  const t = execFileSync('unzip', ['-p', path.join(out, 'gig-tracker.zip'), f], { encoding: 'utf8' });
  if (/gt1\.[A-Za-z0-9_-]{20,}|sk-ant-|AIza[0-9A-Za-z_-]{20,}/.test(t)) leaked = true;
}
ok(!leaked, 'no keys of any kind inside the plugin');

const v = spawnSync('claude', ['plugin', 'validate', root], { encoding: 'utf8' });
if (v.error) console.log('  – (claude CLI not available — skipped `claude plugin validate`)');
else ok(v.status === 0, `\`claude plugin validate\` passes${v.status === 0 ? '' : ': ' + (v.stdout + v.stderr).trim().split('\n').slice(-3).join(' | ')}`);

fs.rmSync(out, { recursive: true, force: true });
console.log(fails ? `\nPLUGIN: ${fails} FAILED` : '\nPLUGIN: ALL PASSED ✓');
process.exit(fails ? 1 : 0);
