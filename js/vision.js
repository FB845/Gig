// vision.js — read schedule and earnings screenshots with Claude.
// Much more accurate than on-device OCR: Claude understands the Flex and
// DoorDash layouts and returns exact dates, 24-hour times and pay.
//
// Uses your own Anthropic API key, kept in this browser only (never synced,
// never in backups). Each screenshot is sent to Anthropic to be read. The
// official SDK is loaded on first use.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm';
const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'gigtracker.anthropicKey';
const MAX_EDGE = 1568; // larger images are scaled down by the API anyway

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}
export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch { /* ignore */ }
}
export const visionEnabled = () => !!getApiKey();

let sdk = null;
async function client() {
  const key = getApiKey();
  if (!key) throw new Error('Add your Anthropic API key in Settings first.');
  if (!sdk) sdk = import(SDK_URL).catch((e) => { sdk = null; throw e; });
  const { default: Anthropic } = await sdk;
  return { Anthropic, api: new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 }) };
}

// File → base64 JPEG/PNG, long edge ≤ MAX_EDGE (keeps uploads small).
async function toImageBlock(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const url = c.toDataURL('image/jpeg', 0.9);
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) } };
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const today = (iso) => `Today is ${DOW[new Date(iso + 'T00:00:00').getDay()]} ${iso}.`;

const COMMON = `You read screenshots from a US gig driver's apps (Amazon Flex, DoorDash, Uber, etc.) and return the data as JSON for their earnings tracker.
- Times: 24-hour HH:MM (5:30 PM → 17:30). A block that ends after midnight just has the earlier end time (22:00–01:30).
- Dates: YYYY-MM-DD. Resolve "Today", "Tomorrow", weekday names and dates without a year from today's date; a date with no year is the nearest one (upcoming for schedules, past for earnings).
- Money: plain numbers in dollars, 0 when not shown. Never guess a number that isn't on screen.
- platform: "flex" for Amazon Flex, "doordash" for DoorDash (Dasher), "other" for anything else.`;

async function ask(images, system, prompt, schema) {
  const { Anthropic, api } = await client();
  let res;
  try {
    res = await api.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Re-routes the rare declined request to another model automatically.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Your Anthropic API key wasn’t accepted — check it in Settings.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('This API key isn’t allowed to use Claude — check it in the Anthropic Console.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is busy right now (rate limit) — try again in a minute.');
    if (e instanceof Anthropic.BadRequestError && /credit/i.test(e.message)) throw new Error('Your Anthropic account is out of credit — add some in the Anthropic Console (Billing).');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Couldn’t reach Claude — check your connection and try again.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude couldn’t read it (${e.status || 'error'}): ${e.message}`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to read this screenshot.');
  if (res.stop_reason === 'max_tokens') throw new Error('That was too much to read in one go — try fewer screenshots at once.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// ---- schedule screenshots → planner rows ----
const SCHEDULE_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start: { type: 'string', description: '24-hour HH:MM' },
          end: { type: 'string', description: '24-hour HH:MM' },
          platform: { type: 'string', enum: ['flex', 'doordash', 'other'] },
          pay: { type: 'number', description: 'Block pay in dollars; the lower figure of a range; 0 if not shown' },
          place: { type: 'string', description: 'Station / zone / area shown, or empty' },
          note: { type: 'string', description: 'Anything worth knowing (pay range, "offer — not accepted"), or empty' },
        },
        required: ['date', 'start', 'end', 'platform', 'pay', 'place', 'note'],
        additionalProperties: false,
      },
    },
    unreadable: { type: 'string', description: 'What, if anything, couldn’t be read; empty if all clear' },
  },
  required: ['blocks', 'unreadable'],
  additionalProperties: false,
};

// files: File[] (one or more screenshots of the same schedule).
// → { events (calendar-import rows), unreadable }
export async function readSchedule(files, nowISO) {
  const images = await Promise.all(files.map(toImageBlock));
  const system = `${COMMON}
Task: list every scheduled block or shift the driver has on their calendar — one entry per block, each exactly once even if it appears in two overlapping screenshots. Leave out offers they haven't accepted, unless the screenshots show nothing else (then include them and say "offer" in note). Leave out past blocks only if the screen marks them completed.`;
  const out = await ask(images, system, `${today(nowISO)} Read the schedule in ${images.length > 1 ? 'these screenshots' : 'this screenshot'}.`, SCHEDULE_SCHEMA);
  const ok = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  const NAME = { flex: 'Amazon Flex', doordash: 'DoorDash', other: 'Other' };
  const events = (out.blocks || [])
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && ok(b.start) && ok(b.end))
    .map((b) => ({
      date: b.date, startTime: b.start, endTime: b.end,
      summary: [NAME[b.platform] || 'Block', b.place].filter(Boolean).join(' · '),
      detail: b.note || '',
      platform: b.platform,
      estimate: b.pay > 0 ? Math.round(b.pay * 100) / 100 : 0,
      recognized: true,
    }));
  return { events, unreadable: out.unreadable || '' };
}

// ---- earnings screenshot → one shift ----
const EARNINGS_SCHEMA = {
  type: 'object',
  properties: {
    platform: { type: 'string', enum: ['flex', 'doordash', 'other'] },
    date: { type: 'string', description: 'YYYY-MM-DD of the shift / block, or empty if not shown' },
    start: { type: 'string', description: '24-hour HH:MM, or empty' },
    end: { type: 'string', description: '24-hour HH:MM, or empty' },
    hours: { type: 'number', description: 'Time worked / active time in hours; 0 if not shown' },
    base_pay: { type: 'number', description: 'Pay before tips (Flex block pay; DoorDash base pay + promotions)' },
    tips: { type: 'number', description: 'Customer tips' },
    total: { type: 'number', description: 'Total earnings shown' },
    deliveries: { type: 'number', description: 'Number of deliveries / orders; 0 if not shown' },
    miles: { type: 'number', description: 'Miles driven; 0 if not shown' },
    unreadable: { type: 'string', description: 'What couldn’t be read; empty if all clear' },
  },
  required: ['platform', 'date', 'start', 'end', 'hours', 'base_pay', 'tips', 'total', 'deliveries', 'miles', 'unreadable'],
  additionalProperties: false,
};

// → the same shape parse.js's extractFromText returns (for the review form).
export async function readEarnings(file, nowISO, platformHint = '') {
  const system = `${COMMON}
Task: read ONE shift / block / dash from an earnings screen. If base pay isn't split out, base_pay = total − tips. If the screen shows a whole week or several dashes, read the single most prominent one and say so in unreadable.`;
  const hint = platformHint ? ` It's from ${platformHint === 'flex' ? 'Amazon Flex' : 'DoorDash'}.` : '';
  const g = await ask([await toImageBlock(file)], system, `${today(nowISO)} Read this earnings screenshot.${hint}`, EARNINGS_SCHEMA);
  const ok = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');
  const base = g.base_pay || (g.total ? Math.max(0, g.total - (g.tips || 0)) : 0);
  return {
    platform: platformHint || g.platform || 'other',
    date: /^\d{4}-\d{2}-\d{2}$/.test(g.date) ? g.date : '',
    startTime: ok(g.start) ? g.start : '', endTime: ok(g.end) ? g.end : '',
    hours: g.hours || 0, gross: Math.round(base * 100) / 100, tips: g.tips || 0,
    jobs: g.deliveries || 0, miles: g.miles || 0,
    unreadable: g.unreadable || '',
    _confidence: base || g.tips ? 2 : 0,
  };
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
