// npm run install-claude — adds the Gig Tracker server to Claude Desktop's
// config safely: backs the file up, keeps everything already in it, and fixes
// the common mistake of pasting a second `{ … }` after the existing one.
// Prints no secrets (the connection key is not in this file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function configPath() {
  if (process.env.CLAUDE_DESKTOP_CONFIG) return process.env.CLAUDE_DESKTOP_CONFIG;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

// text → { text, notes }. Throws (without guessing) if the file can't be understood.
export function mergeConfig(text, serverPath, nodePath) {
  const notes = [];
  let cfg;
  const src = String(text || '').trim();
  if (!src) { cfg = {}; notes.push('The config was empty.'); }
  else {
    try { cfg = JSON.parse(src); } catch (e) {
      // "…after JSON at position N": a complete object, then more stuff.
      const m = /position (\d+)/.exec(e.message);
      if (!m) throw new Error(`Claude Desktop's config isn't valid JSON and I can't tell where it goes wrong (${e.message}). Nothing was changed.`);
      const at = Number(m[1]);
      let head, tail;
      try { head = JSON.parse(src.slice(0, at)); tail = JSON.parse(src.slice(at)); } catch {
        throw new Error('The config has extra text after its closing brace that isn\'t a second JSON object, so I won\'t guess. Nothing was changed. Open the file, delete everything after the first complete { … } block, and run this again.');
      }
      if (!isObj(head) || !isObj(tail)) throw new Error('The config isn\'t a JSON object. Nothing was changed.');
      cfg = head;
      notes.push('Found a second { … } block pasted after the first — merged it in.');
      if (isObj(tail.mcpServers)) cfg.mcpServers = { ...(isObj(cfg.mcpServers) ? cfg.mcpServers : {}), ...tail.mcpServers };
      for (const [k, v] of Object.entries(tail)) if (k !== 'mcpServers' && !(k in cfg)) cfg[k] = v;
    }
  }
  if (!isObj(cfg)) throw new Error('The config isn\'t a JSON object. Nothing was changed.');
  if (cfg.mcpServers !== undefined && !isObj(cfg.mcpServers)) throw new Error('"mcpServers" in the config isn\'t an object. Nothing was changed.');
  const had = !!cfg.mcpServers?.['gig-tracker'];
  cfg.mcpServers = { ...(cfg.mcpServers || {}), 'gig-tracker': { command: nodePath, args: [serverPath] } };
  notes.push(had ? 'Updated the existing "gig-tracker" entry.' : 'Added "gig-tracker".');
  return { text: JSON.stringify(cfg, null, 2) + '\n', notes, servers: Object.keys(cfg.mcpServers) };
}

function main() {
  const file = configPath();
  const server = path.join(here, 'server.mjs');
  if (!fs.existsSync(server)) { console.error(`✗ ${server} not found — run this from the mcp folder of the Gig repo.`); process.exit(1); }
  const exists = fs.existsSync(file);
  const before = exists ? fs.readFileSync(file, 'utf8') : '';
  let out;
  try { out = mergeConfig(before, server, process.execPath); } catch (e) { console.error('\n✗ ' + e.message + `\n  File: ${file}\n`); process.exit(1); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = '';
  if (exists) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    backup = `${file}.backup-${stamp}`;
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, out.text);
  console.log('\nClaude Desktop config updated\n');
  console.log(`  file:    ${file}`);
  if (backup) console.log(`  backup:  ${backup}`);
  for (const n of out.notes) console.log(`  • ${n}`);
  console.log(`  servers: ${out.servers.join(', ')}`);
  console.log(`  runs:    ${process.execPath} ${server}`);
  console.log('\nNext: quit Claude Desktop completely (Cmd+Q) and reopen it.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
