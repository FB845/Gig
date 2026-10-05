// calendar.js — turn an existing calendar into planner entries.
//
// Two sources, one output shape ({ date, startTime, endTime, summary,
// estimate, platform, recognized }):
//   • parseICS(text)            — an .ics export (Google / Apple / Outlook)
//   • parseScheduleText(text)   — OCR text from a schedule screenshot
//                                 (e.g. the Amazon Flex calendar)
// Pure functions (no DOM, no storage) so they're easy to test.

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmmOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoOf(d); };

// ---------------------------------------------------------------------------
// Platform + money guesses from free text
// ---------------------------------------------------------------------------
export function guessPlatform(text) {
  const t = (text || '').toLowerCase();
  if (/amazon|\bflex\b/.test(t)) return 'flex';
  if (/door ?dash|\bdasher?\b|\bdash\b/.test(t)) return 'doordash';
  if (/\buber\b|\blyft\b|instacart|grubhub|\bspark\b|shipt|roadie|gopuff/.test(t)) return 'other';
  if (/tracehaus|invoice|\bclient\b|consult|retainer/.test(t)) return 'income';
  return '';
}

export function moneyIn(text) {
  const m = (text || '').match(/\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
}

// ---------------------------------------------------------------------------
// ICS
// ---------------------------------------------------------------------------

// Wall-clock time in an IANA zone → the real instant (as a Date). Falls back to
// device-local time for unknown zones (e.g. Outlook's "Pacific Standard Time").
function zonedToDate(y, mo, d, h, mi, tz) {
  if (!tz) return new Date(y, mo - 1, d, h, mi);
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const offset = (ms) => {
      const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
    };
    const asUTC = Date.UTC(y, mo - 1, d, h, mi);
    let t = asUTC - offset(asUTC);
    const off2 = offset(t); // correct across a DST change
    if (asUTC - off2 !== t) t = asUTC - off2;
    return new Date(t);
  } catch {
    return new Date(y, mo - 1, d, h, mi);
  }
}

// Wall-clock parts in a zone → instant. tz: IANA name, 'UTC', or null (device
// local / "floating"); all-day dates are local midnight.
function toInstant(y, mo, d, h, mi, tz, allDay) {
  if (allDay) return new Date(y, mo - 1, d);
  if (tz === 'UTC') return new Date(Date.UTC(y, mo - 1, d, h, mi));
  return zonedToDate(y, mo, d, h, mi, tz);
}

// An ICS date/date-time value → { date: Date (instant), allDay, parts, tz }.
// `parts` + `tz` keep the original wall-clock time so repeats can be expanded
// in the event's own time zone.
function parseIcsDate(value, params = {}) {
  const v = (value || '').trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  const allDay = h === undefined || params.VALUE === 'DATE';
  const parts = { y: +y, mo: +mo, d: +d, h: allDay ? 0 : +h, mi: allDay ? 0 : +mi };
  const tz = allDay ? null : (z ? 'UTC' : (params.TZID || null));
  return { date: toInstant(parts.y, parts.mo, parts.d, parts.h, parts.mi, tz, allDay), allDay, parts, tz };
}

function parseDuration(v) {
  const m = (v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((((+w || 0) * 7 + (+d || 0)) * 24 + (+h || 0)) * 60 + (+mi || 0)) * 60000 + (+s || 0) * 1000;
  return sign === '-' ? -ms : ms;
}

const unescapeText = (s) => (s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Occurrence start times for an event: DTSTART alone, or a DAILY / WEEKLY
// RRULE (INTERVAL, COUNT, UNTIL, BYDAY) minus EXDATEs. Repeats step through
// calendar days in the event's OWN zone (BYDAY=TU means Tuesday there), then
// each occurrence is converted to an instant. Other repeat rules (monthly,
// yearly…) import just their first occurrence.
function occurrences(ev, windowEnd) {
  const { date: start, parts, tz, allDay } = ev.dtstart;
  if (!ev.rrule) return [start];
  const r = Object.fromEntries(ev.rrule.split(';').map((kv) => kv.split('=')));
  const freq = r.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return [start];
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const until = r.UNTIL ? (parseIcsDate(r.UNTIL) || {}).date : null;
  const out = [];
  let n = 0;
  const push = (d) => {
    if (until && d > until) return false;
    if (n >= count || d > windowEnd) return false;
    n += 1;
    out.push(d);
    return true;
  };
  // Calendar-day arithmetic on the wall-clock date (UTC math = no DST drift).
  const baseDay = Date.UTC(parts.y, parts.mo - 1, parts.d);
  const dayAt = (offset) => {
    const x = new Date(baseDay + offset * 86400000);
    return toInstant(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), parts.h, parts.mi, tz, allDay);
  };
  if (freq === 'DAILY') {
    for (let i = 0; i < 3000; i++) {
      if (!push(dayAt(i * interval))) break;
    }
  } else {
    const startDow = new Date(baseDay).getUTCDay();
    const days = (r.BYDAY ? r.BYDAY.split(',').map((c) => DAY_CODES[c.slice(-2)]) : [startDow])
      .filter((x) => x !== undefined).sort((a, b) => a - b);
    outer: for (let w = 0; w < 600; w += interval) {
      for (const wd of days) {
        const offset = w * 7 + wd - startDow; // days from DTSTART (week starts Sunday)
        if (offset < 0) continue;
        if (!push(dayAt(offset))) break outer;
      }
    }
  }
  const ex = new Set(ev.exdates.map((d) => d.getTime()));
  return out.filter((d) => !ex.has(d.getTime()));
}

// Parse an .ics file into planner events within [fromISO, toISO].
// Returns { events, skippedPast, skippedLater, cancelled }.
export function parseICS(text, { fromISO, toISO } = {}) {
  // Unfold: a line starting with space/tab continues the previous one.
  const lines = (text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const raw = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) raw.push(cur); cur = null; continue; }
    if (!cur) continue;
    const m = line.match(/^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const name = m[1].toUpperCase();
    const params = Object.fromEntries(m[2].split(';').filter(Boolean).map((p) => {
      const [k, ...v] = p.split('='); return [k.toUpperCase(), v.join('=').replace(/^"|"$/g, '')];
    }));
    const value = m[3];
    if (name === 'DTSTART') cur.dtstart = parseIcsDate(value, params);
    else if (name === 'DTEND') cur.dtend = parseIcsDate(value, params);
    else if (name === 'DURATION') cur.duration = parseDuration(value);
    else if (name === 'SUMMARY') cur.summary = unescapeText(value);
    else if (name === 'DESCRIPTION') cur.description = unescapeText(value);
    else if (name === 'LOCATION') cur.location = unescapeText(value);
    else if (name === 'RRULE') cur.rrule = value;
    else if (name === 'STATUS') cur.status = value.toUpperCase();
    else if (name === 'EXDATE') value.split(',').forEach((v) => { const p = parseIcsDate(v, params); if (p) cur.exdates.push(p.date); });
  }

  const from = fromISO ? new Date(fromISO + 'T00:00:00') : new Date(0);
  const windowEnd = toISO ? new Date(toISO + 'T23:59:59') : new Date(8.64e15);
  const events = [];
  let skippedPast = 0, skippedLater = 0, cancelled = 0;
  for (const ev of raw) {
    if (!ev.dtstart) continue;
    if (ev.status === 'CANCELLED') { cancelled += 1; continue; }
    const allDay = ev.dtstart.allDay;
    const durMs = ev.dtend ? ev.dtend.date - ev.dtstart.date : (ev.duration || 0);
    const text = [ev.summary, ev.description, ev.location].filter(Boolean).join(' ');
    const occ = occurrences({ dtstart: ev.dtstart, rrule: ev.rrule, exdates: ev.exdates }, windowEnd);
    if (!ev.rrule && ev.dtstart.date > windowEnd) { skippedLater += 1; continue; }
    for (const start of occ) {
      if (start < from) { skippedPast += 1; continue; }
      const end = new Date(start.getTime() + durMs);
      const platform = guessPlatform(text);
      const estimate = moneyIn(text);
      events.push({
        date: isoOf(start),
        startTime: allDay ? '' : hhmmOf(start),
        endTime: allDay || !(durMs > 0) ? '' : hhmmOf(end),
        summary: (ev.summary || '(no title)').trim(),
        detail: [ev.location, (ev.description || '').split('\n')[0]].filter(Boolean).join(' · '),
        platform, estimate,
        recognized: !!platform || estimate > 0,
      });
    }
  }
  events.sort((a, b) => (a.date + (a.startTime || '99')).localeCompare(b.date + (b.startTime || '99')));
  return { events, skippedPast, skippedLater, cancelled };
}

// ---------------------------------------------------------------------------
// Screenshot (OCR text) of a schedule
// ---------------------------------------------------------------------------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// A date mentioned on a line (headers like "Wed, Oct 7", "October 7", "10/7",
// "Today", "Tomorrow", or a bare weekday → its next occurrence).
export function dateFromLine(line, nowISO) {
  const t = line.toLowerCase();
  if (/\btoday\b/.test(t)) return nowISO;
  if (/\btomorrow\b/.test(t)) return addDays(nowISO, 1);
  const year = +nowISO.slice(0, 4);
  const withYear = (mo, d, y) => {
    let iso = `${y || year}-${pad(mo)}-${pad(d)}`;
    // No year given and well in the past → it's next year's date.
    if (!y && iso < addDays(nowISO, -31)) iso = `${year + 1}-${pad(mo)}-${pad(d)}`;
    return iso;
  };
  // Real month names/abbreviations only (so "Market 5" isn't March 5th).
  let m = t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/);
  if (m && +m[2] >= 1 && +m[2] <= 31) return withYear(MONTHS.indexOf(m[1].slice(0, 3)) + 1, +m[2], m[3] ? +m[3] : 0);
  m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : 0;
    return withYear(+m[1], +m[2], y);
  }
  // A line that is just a weekday ("Tuesday", "Thu") → its next occurrence.
  m = t.match(/^\W*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thur?s?|fri|sat)\.?\W*$/);
  if (m) {
    const want = WEEKDAYS.indexOf(m[1].slice(0, 3));
    const now = new Date(nowISO + 'T00:00:00');
    return addDays(nowISO, (want - now.getDay() + 7) % 7);
  }
  return null;
}

// "9:00 AM - 12:30 PM", "11 - 2pm", "17:00–21:00" → { startTime, endTime }.
// Needs a meridiem or colons on both sides so counts like "10-12" don't match.
export function timeRangeFromLine(line) {
  const re = /(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|a|p)?\s*(?:-|–|—|to)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|a|p)?(?![a-z])/i;
  const m = line.match(re);
  if (!m) return null;
  let [, h1, m1, a1, h2, m2, a2] = m;
  if (!a1 && !a2 && !(m1 && m2)) return null;
  h1 = +h1; h2 = +h2; m1 = +(m1 || 0); m2 = +(m2 || 0);
  if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return null;
  const pm = (a) => (a ? a[0].toLowerCase() === 'p' : null);
  const to24 = (h, isPm) => (isPm === null ? h : (h % 12) + (isPm ? 12 : 0));
  let p1 = pm(a1), p2 = pm(a2);
  if (p1 === null && p2 !== null) {
    // "11 - 2pm" → 11am; "1 - 4pm" → 1pm
    p1 = p2;
    if (to24(h1, p1) * 60 + m1 > to24(h2, p2) * 60 + m2) p1 = !p2;
  } else if (p2 === null && p1 !== null) {
    p2 = p1;
    if (to24(h2, p2) * 60 + m2 <= to24(h1, p1) * 60 + m1) p2 = !p1;
  }
  const s = to24(h1, p1), e = to24(h2, p2);
  if (s > 23 || e > 24) return null;
  return { startTime: `${pad(s)}:${pad(m1)}`, endTime: `${pad(e % 24)}:${pad(m2)}` };
}

// OCR text of a schedule → events. Each time range becomes one event, dated by
// the nearest header above it, priced by a $ amount on the same or following
// lines (before the next time range).
export function parseScheduleText(text, nowISO) {
  const lines = (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const events = [];
  let curDate = null;
  let used = -1; // last line index already claimed by a block (so prices aren't shared)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const d = dateFromLine(line, nowISO);
    if (d) curDate = d;
    const tr = timeRangeFromLine(line);
    if (!tr) continue;
    // Price above the time (some layouts) — only if no earlier block used it.
    let estimate = i - 1 > used && !dateFromLine(lines[i - 1] || '', nowISO) ? moneyIn(lines[i - 1] || '') : 0;
    estimate = moneyIn(line) || estimate;
    used = i;
    const context = [line];
    for (let j = i + 1; j < lines.length && j <= i + 3 && !timeRangeFromLine(lines[j]) && !dateFromLine(lines[j], nowISO); j++) {
      // A price below the time wins; stop at the first one so the next block keeps its own.
      context.push(lines[j]);
      used = j;
      const below = moneyIn(lines[j]);
      if (below) { estimate = below; break; }
    }
    const date = curDate || nowISO;
    if (events.some((e) => e.date === date && e.startTime === tr.startTime && e.endTime === tr.endTime)) continue;
    const ctx = context.join(' ');
    events.push({
      date, ...tr,
      summary: ctx.replace(/\s+/g, ' ').slice(0, 80),
      detail: '',
      platform: guessPlatform(ctx),
      estimate,
      recognized: true, // a time range on a schedule screenshot is a block
    });
  }
  return { events };
}
