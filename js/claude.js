// claude.js — the Claude layer of the tracker.
//   • your Anthropic API key (this browser only — never synced, never in backups)
//   • ask(): one helper that talks to Claude through the official SDK and
//     returns JSON that matches a schema
//   • a tiny plugin registry, so Claude-powered features are one file each and
//     can be switched on and off in Settings → Claude
//
// A plugin is a plain object:
//   { id, name, jp, blurb,            // shown in Settings → Claude
//     slot,                           // optional: the view it adds a card to ('trends', …)
//     render(card, ctx) }             // fills that card; called whenever the view is shown
// Plugins without a slot are built-in behaviours that just read isEnabled(id)
// (screenshot reading is one). Register with registerPlugin(); see
// js/plugins/weekly-summary.js for a complete example.
//
// The SDK itself is only downloaded the first time Claude is actually asked.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm';
export const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'gigtracker.anthropicKey';
const FLAGS_STORE = 'gigtracker.claudePlugins';

// ---- key ----
export function getApiKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}
export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch { /* ignore */ }
}
export const hasKey = () => !!getApiKey();

// ---- client ----
let sdk = null;
async function client() {
  const key = getApiKey();
  if (!key) throw new Error('Add your Anthropic API key in Settings → Claude first.');
  if (!sdk) sdk = import(SDK_URL).catch((e) => { sdk = null; throw e; });
  const { default: Anthropic } = await sdk;
  return { Anthropic, api: new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 }) };
}

// Ask Claude and get back JSON matching `schema`.
//   images: image content blocks · system / prompt: strings · effort: low|medium|high
export async function ask({ images = [], system, prompt, schema, effort = 'low' }) {
  const { Anthropic, api } = await client();
  let res;
  try {
    res = await api.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Re-routes the rare declined request to another model automatically.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Your Anthropic API key wasn’t accepted — check it in Settings → Claude.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('This API key isn’t allowed to use Claude — check it in the Anthropic Console.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is busy right now (rate limit) — try again in a minute.');
    if (e instanceof Anthropic.BadRequestError && /credit/i.test(e.message)) throw new Error('Your Anthropic account is out of credit — add some in the Anthropic Console (Billing).');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Couldn’t reach Claude — check your connection and try again.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude couldn’t do that (${e.status || 'error'}): ${e.message}`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer this.');
  if (res.stop_reason === 'max_tokens') throw new Error('The answer was cut off — try again.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// Cheap key check (no tokens used): look up the model.
export async function testKey() {
  const { Anthropic, api } = await client();
  try { await api.models.retrieve(MODEL); return true; } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('That key wasn’t accepted.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Couldn’t reach Anthropic — check your connection.');
    throw new Error(e.message || String(e));
  }
}

// ---- plugin registry ----
const registry = [];
export function registerPlugin(p) {
  if (!p || !p.id || registry.some((x) => x.id === p.id)) return;
  registry.push(p);
}
export const listPlugins = () => [...registry];

// Per-device on/off switches. Everything is on until you turn it off.
function flags() {
  try { return JSON.parse(localStorage.getItem(FLAGS_STORE) || '{}'); } catch { return {}; }
}
export const isEnabled = (id) => flags()[id] !== false;
export function setEnabled(id, on) {
  const f = flags();
  f[id] = !!on;
  try { localStorage.setItem(FLAGS_STORE, JSON.stringify(f)); } catch { /* ignore */ }
}

// Add / refresh / remove the cards of plugins that live in `viewId`.
// Cards only exist while there's a key and the plugin is on.
export function mountPlugins(viewId, ctx) {
  const view = document.getElementById(`view-${viewId}`);
  if (!view) return;
  for (const p of registry) {
    if (p.slot !== viewId || typeof p.render !== 'function') continue;
    let card = view.querySelector(`:scope > [data-plugin="${p.id}"]`);
    if (!(hasKey() && isEnabled(p.id))) { card?.remove(); continue; }
    if (!card) {
      card = document.createElement('div');
      card.className = 'card claude-card';
      card.dataset.plugin = p.id;
      view.prepend(card);
    }
    try { p.render(card, ctx); } catch (e) {
      card.innerHTML = `<p class="muted">${p.name} couldn’t load: ${String(e.message || e).replace(/[<&]/g, ' ')}</p>`;
    }
  }
}

// Settings → Claude: one switch per feature.
export function renderFeatureList(host, escapeHtml = (s) => s) {
  host.innerHTML = registry.map((p) => `
    <label class="cf-row">
      <input type="checkbox" data-feature="${p.id}"${isEnabled(p.id) ? ' checked' : ''} />
      <span class="cf-text"><b>${escapeHtml(p.name)}</b> <span class="cf-jp">${escapeHtml(p.jp || '')}</span>
        <small class="muted">${escapeHtml(p.blurb || '')}</small></span>
    </label>`).join('');
  host.querySelectorAll('input[data-feature]').forEach((c) => c.addEventListener('change', () => setEnabled(c.dataset.feature, c.checked)));
}
