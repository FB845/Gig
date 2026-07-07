// parse.js — CSV parsing + heuristic extraction of gig fields from free text
// (OCR output or pasted statements). No dependencies.

// ---- CSV ----
export function parseCSV(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f.trim() !== '')) rows.push(row); }
  return rows;
}

// Map a CSV (with header row) into shift records. Tries to auto-detect columns
// for common DoorDash / Amazon Flex / generic earnings exports.
export function csvToShifts(text, platformHint = '') {
  const rows = parseCSV(text);
  if (rows.length < 2) return { shifts: [], headers: [], warnings: ['No data rows found'] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (names) => headers.findIndex((h) => names.some((n) => h.includes(n)));

  const dateI = idx(['date', 'day', 'delivery date', 'payout date']);
  const grossI = idx(['pay', 'base', 'earnings', 'amount', 'subtotal', 'fare']);
  const tipsI = idx(['tip', 'tips', 'customer tip']);
  const milesI = idx(['mile', 'distance', 'mileage']);
  const jobsI = idx(['deliveries', 'orders', 'trips', 'packages', 'jobs', 'count']);
  const hoursI = idx(['hour', 'time', 'duration', 'active time']);

  const warnings = [];
  if (dateI === -1) warnings.push('Could not find a Date column — rows may be skipped.');
  if (grossI === -1 && tipsI === -1) warnings.push('Could not find an earnings column.');

  const shifts = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const date = normalizeDate(cols[dateI]);
    if (!date) continue;
    shifts.push({
      platform: platformHint || 'other',
      date,
      gross: money(cols[grossI]),
      tips: money(cols[tipsI]),
      miles: numOnly(cols[milesI]),
      jobs: Math.round(numOnly(cols[jobsI])),
      hours: parseHours(cols[hoursI]),
      notes: 'CSV import',
    });
  }
  return { shifts, headers, warnings };
}

// ---- OCR / free-text heuristics ----
// Pull the most likely earnings, tips, miles, and delivery count from a blob of
// text captured from a Flex or Dasher earnings screen.
export function extractFromText(text, platformHint = '') {
  const clean = text.replace(/[|]/g, ' ').replace(/ /g, ' ');
  const lines = clean.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const lower = clean.toLowerCase();

  const platform = platformHint ||
    (/(amazon|flex|block)/i.test(clean) ? 'flex' :
     (/(doordash|dasher|dash)/i.test(clean) ? 'doordash' : 'other'));

  // all dollar amounts
  const dollars = [...clean.matchAll(/\$\s?(\d[\d,]*\.?\d{0,2})/g)]
    .map((m) => parseFloat(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));

  const total = labeledMoney(lines, ['total', 'earnings', 'you earned', 'total earnings', 'net']);
  const tips = labeledMoney(lines, ['tip', 'tips', 'customer tip']);
  const base = labeledMoney(lines, ['base', 'pay', 'active pay', 'base pay', 'guaranteed']);

  // Fall back: biggest dollar amount is likely the total.
  const guessTotal = total ?? (dollars.length ? Math.max(...dollars) : null);
  let gross = base;
  let tip = tips;
  if (gross == null && guessTotal != null) {
    gross = tip != null ? Math.max(0, guessTotal - tip) : guessTotal;
  }

  const miles = labeledNumber(lines, ['mile', 'mi', 'distance']) ?? numberNear(lower, /(\d[\d,.]*)\s*(?:mi|miles)/);
  const jobs = labeledNumber(lines, ['deliveries', 'delivery', 'orders', 'trips', 'packages', 'stops']) ??
    numberNear(lower, /(\d+)\s*(?:deliveries|delivery|orders|trips|packages|stops)/);
  const hours = extractHours(lower);
  const date = extractDate(clean);

  return {
    platform,
    date: date || '',
    gross: round2(gross ?? 0),
    tips: round2(tip ?? 0),
    miles: round2(miles ?? 0),
    jobs: jobs ? Math.round(jobs) : 0,
    hours: round2(hours ?? 0),
    _dollarsFound: dollars,
    _confidence: (guessTotal != null ? 1 : 0) + (miles != null ? 1 : 0) + (jobs != null ? 1 : 0),
  };
}

// ---- helpers ----
function labeledMoney(lines, labels) {
  for (const line of lines) {
    const low = line.toLowerCase();
    if (labels.some((l) => low.includes(l))) {
      const m = line.match(/\$?\s?(\d[\d,]*\.?\d{0,2})/);
      if (m) return parseFloat(m[1].replace(/,/g, ''));
    }
  }
  return null;
}

function labeledNumber(lines, labels) {
  for (const line of lines) {
    const low = line.toLowerCase();
    if (labels.some((l) => low.includes(l))) {
      const m = line.match(/(\d[\d,]*\.?\d*)/);
      if (m) return parseFloat(m[1].replace(/,/g, ''));
    }
  }
  return null;
}

function numberNear(text, re) {
  const m = text.match(re);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function extractHours(text) {
  // "3h 30m", "3.5 hrs", "3:30"
  let m = text.match(/(\d+)\s*h(?:ours?|rs?)?\s*(\d+)?\s*m?/);
  if (m) return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 60 : 0);
  m = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/);
  if (m) return parseFloat(m[1]);
  m = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  return null;
}

function extractDate(text) {
  // ISO
  let m = text.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  // US MM/DD/YYYY or MM/DD/YY
  m = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (m) {
    let y = m[3]; if (y.length === 2) y = '20' + y;
    return `${y}-${pad(m[1])}-${pad(m[2])}`;
  }
  // Month name: "Jan 5, 2026" / "January 5 2026"
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(20\d{2}))?/);
  if (m) {
    const mo = months.indexOf(m[1]) + 1;
    const y = m[3] || String(new Date().getFullYear());
    return `${y}-${pad(mo)}-${pad(m[2])}`;
  }
  return null;
}

export function normalizeDate(v) {
  if (!v) return null;
  return extractDate(String(v));
}

function parseHours(v) {
  if (!v) return 0;
  return extractHours(String(v).toLowerCase()) || numOnly(v);
}

function money(v) { return round2(numOnly(v)); }
function numOnly(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function round2(n) { return Math.round((n || 0) * 100) / 100; }
function pad(n) { return String(n).padStart(2, '0'); }
