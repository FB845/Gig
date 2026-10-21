// Weekly summary — a Claude plugin. Adds a card at the top of Trends: tap
// Generate and Claude writes a short, specific summary of the week (this week
// so far, or last week) from your own numbers.
//
// What's sent: totals, per-day amounts, per-platform and per-block-type rates,
// the best and worst shifts (date, time window, platform), expenses by
// category, the previous four weeks, and next week's plan. NOT sent: notes,
// locations, income source names, or anything outside that week's digest.
// Summaries are saved on this device per week, so reopening is free; it only
// costs anything (about 2¢) when you tap Generate / Regenerate.

const CACHE_KEY = 'gigtracker.claude.weekly';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const r2 = (n) => Math.round(n * 100) / 100;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One plain sentence, at most about 90 characters: how the week went.' },
    verdict: { type: 'string', enum: ['ahead', 'on_track', 'behind', 'thin_data'] },
    highlights: { type: 'array', items: { type: 'string' }, description: '2–4 short, specific points about what happened (best day, best platform or block type, $/hr, hours).' },
    watch: { type: 'array', items: { type: 'string' }, description: '0–3 things to watch: a weak spot, a slipping trend, a goal shortfall. Empty if nothing.' },
    next_week: { type: 'array', items: { type: 'string' }, description: '2–3 concrete things to do next week, grounded in the digest’s plans and suggested slots.' },
  },
  required: ['headline', 'verdict', 'highlights', 'watch', 'next_week'],
  additionalProperties: false,
};

const SYSTEM = `You write a short weekly summary for a US delivery driver (Amazon Flex, DoorDash, other gig apps) from a JSON digest of their own week. They read it on a phone between jobs.
Rules:
- Use only numbers that appear in the digest (rounding is fine). Never invent figures, reasons or events.
- Totals as whole dollars; hourly and per-mile rates with cents. Times in 24-hour HH:MM. Days as Mon, Tue, …
- Be specific and plain: name the actual best and worst days, platforms, block types and hours. No filler, no cheerleading, no tax or legal advice.
- "goal" is the driver's own weekly target and "daily_goal" their daily one. Finishing the goal early earns days off — count those as a win.
- If week_complete is false it is a partial week: judge the pace against the goal for the days elapsed and never call it a bad week just for being unfinished.
- If there are fewer than 3 shifts, say the data is thin, use verdict "thin_data" and keep it brief.
- Each bullet is one short sentence.`;

// ---- the digest (exported so it can be tested) ----
export function buildDigest(store, weekStart, nowISO = store.todayISO()) {
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return store.isoDate(d); };
  const dow = (iso) => DOW[new Date(iso + 'T00:00:00').getDay()];
  const end = addDays(weekStart, 6);
  const settings = store.getSettings();
  const all = { shifts: store.getShifts(), incomes: store.getIncomes(), expenses: store.getExpenses() };
  const inWeek = (ws) => {
    const we = addDays(ws, 6);
    const f = (x) => x.date >= ws && x.date <= we;
    return { shifts: all.shifts.filter(f), incomes: all.incomes.filter(f), expenses: all.expenses.filter(f) };
  };
  const wk = inWeek(weekStart);
  const sum = store.summarize(wk.shifts, wk.expenses, settings, wk.incomes);
  const desk = store.deskWeek(weekStart, nowISO);
  const daily = store.CAMPAIGN.daily;

  const byPlatform = {};
  for (const s of wk.shifts) {
    const p = (byPlatform[s.platform] ||= { income: 0, hours: 0, miles: 0, shifts: 0 });
    p.income += store.shiftIncome(s); p.hours += s.hours || 0; p.miles += s.miles || 0; p.shifts += 1;
  }
  for (const p of Object.values(byPlatform)) {
    p.per_hour = p.hours ? r2(p.income / p.hours) : null;
    p.income = r2(p.income); p.hours = r2(p.hours); p.miles = r2(p.miles);
  }

  const byCategory = {};
  for (const e of wk.expenses) byCategory[e.category || 'Other'] = r2((byCategory[e.category || 'Other'] || 0) + (e.amount || 0));

  const rated = wk.shifts.filter((s) => s.hours > 0).map((s) => ({
    date: s.date, day: dow(s.date), start: s.startTime || null, end: s.endTime || null, platform: s.platform,
    block_type: s.tag || null, hours: r2(s.hours), income: r2(store.shiftIncome(s)), per_hour: r2(store.shiftIncome(s) / s.hours),
  })).sort((a, b) => b.per_hour - a.per_hour);

  const plans = store.getPlans().filter((p) => p.date >= weekStart && p.date <= end);
  const planStatus = { logged: 0, skipped: 0, missed: 0, still_to_come: 0 };
  for (const p of plans) {
    if (store.planLogged(p)) planStatus.logged++;
    else if (p.skipped) planStatus.skipped++;
    else if (p.date < nowISO) planStatus.missed++;
    else planStatus.still_to_come++;
  }

  const previous = [1, 2, 3, 4].map((i) => {
    const ws = addDays(weekStart, -7 * i);
    const w = inWeek(ws);
    const s = store.summarize(w.shifts, w.expenses, settings, w.incomes);
    return { week_starting: ws, income: r2(s.totalIncome), net: r2(s.net), hours: r2(s.hours), per_hour: s.hours ? r2(s.perHour) : null };
  });

  const nextStart = addDays(weekStart, 7);
  const next = store.deskWeek(nextStart, nowISO);
  const slots = store.suggestSlots(nextStart, { max: 3, nowISO }).map((s) => ({
    day: dow(s.date), start: s.startTime, end: s.endTime, platform: s.platform, typical_per_hour: r2(s.rate),
  }));

  return {
    week: `${weekStart} (${dow(weekStart)}) to ${end}`,
    today: `${nowISO} (${dow(nowISO)})`,
    week_complete: end < nowISO,
    goal: r2(desk.goal), daily_goal: daily,
    earned: r2(desk.earned), still_planned: r2(desk.planned), goal_met_on: desk.metOn,
    days_off_earned: desk.daysOff.map(dow),
    totals: {
      gig_income: r2(sum.gigIncome), other_income: r2(sum.manualIncome), expenses: r2(sum.expenseTotal), net: r2(sum.net),
      tax_set_aside_estimate: r2(sum.taxSetAside), hours: r2(sum.hours), miles: r2(sum.miles), deliveries: sum.jobs,
      per_hour: sum.hours ? r2(sum.perHour) : null, per_mile: sum.miles ? r2(sum.perMile) : null, shifts: sum.shiftCount,
    },
    days: desk.days.map((d) => ({ day: dow(d.date), date: d.date, income: r2(d.actual), planned_still_to_come: r2(d.planned), future: d.date > nowISO })),
    by_platform: byPlatform,
    flex_by_block_type: store.flexByTag(wk.shifts).map((t) => ({ type: t.tag, blocks: t.count, income: r2(t.income), per_hour: r2(t.perHour), block_time_used_pct: t.effPct ? Math.round(t.effPct) : null })),
    expenses_by_category: byCategory,
    best_shifts: rated.slice(0, 2),
    worst_shifts: rated.length >= 4 ? rated.slice(-2).reverse() : [],
    plans_this_week: planStatus,
    previous_weeks: previous,
    next_week: { starting: nextStart, goal: r2(next.goal), planned: r2(next.planned), shortfall: r2(next.shortfall), suggested_open_slots: slots },
  };
}

// FNV-1a — just to notice that the numbers changed since a summary was written.
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; } }
function writeCache(c) {
  const keep = Object.keys(c).sort().slice(-8); // eight weeks is plenty
  const out = {}; for (const k of keep) out[k] = c[k];
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch { /* ignore */ }
}

// ---- the card ----
const ui = { which: null, busy: false, error: '', last: null };

export default {
  id: 'weekly-summary',
  name: 'Weekly summary',
  jp: '週間サマリー',
  blurb: 'A short written summary of your week on Trends: what worked, what to watch, what to do next week. Sends that week’s totals and per-day numbers (no notes or places) when you tap Generate; about 2¢ each.',
  slot: 'trends',

  render(card, ctx) {
    ui.last = { card, ctx };
    const { store, escapeHtml: esc } = ctx;
    const today = store.todayISO();
    const thisWeek = store.isoDate(store.startOfWeek(new Date()));
    const lastWeek = (() => { const d = new Date(thisWeek + 'T00:00:00'); d.setDate(d.getDate() - 7); return store.isoDate(d); })();
    // Early in a new week the interesting one is the week that just ended.
    if (!ui.which) ui.which = (Date.parse(today) - Date.parse(thisWeek)) / 86400000 < 2 ? 'last' : 'this';
    const weekStart = ui.which === 'last' ? lastWeek : thisWeek;

    const digest = buildDigest(store, weekStart, today);
    const sig = hash(JSON.stringify(digest));
    const saved = readCache()[weekStart];
    const empty = !digest.totals.shifts && !digest.totals.other_income;
    const stale = saved && saved.sig !== sig;
    const res = saved && saved.result;

    const pill = res ? { ahead: ['AHEAD', 'ok'], on_track: ['ON TRACK', 'ok'], behind: ['BEHIND', 'busy'], thin_data: ['THIN DATA', ''] }[res.verdict] || ['', ''] : null;
    const list = (title, items, cls = '') => items && items.length ? `<div class="ws-sec ${cls}"><h3>${title}</h3><ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : '';

    let body;
    if (ui.busy) body = `<p class="muted">Claude is reading your week…</p><div class="progress indeterminate"><span></span></div>`;
    else if (res) {
      body = `<p class="ws-headline">${esc(res.headline)}</p>
        ${list('WHAT HAPPENED', res.highlights)}${list('WATCH', res.watch, 'watch')}${list('NEXT WEEK', res.next_week, 'next')}
        <p class="muted ws-foot">Written ${esc(new Date(saved.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))}${stale ? ' · <b>your numbers have changed since</b>' : ''}</p>`;
    } else if (empty) body = `<p class="muted">Nothing logged ${ui.which === 'last' ? 'last' : 'this'} week yet.</p>`;
    else body = `<p class="muted">Claude reads ${ui.which === 'last' ? 'last week’s' : 'this week’s'} numbers and writes a short summary. Saved on this device — it only costs (about 2¢) when you tap the button.</p>`;
    if (ui.error && !ui.busy) body += `<p class="ws-err">⚠️ ${esc(ui.error)}</p>`;

    card.innerHTML = `
      <div class="card-head"><h2 aria-label="Weekly summary"><span class="swap"><span>週間サマリー</span><span>WEEKLY SUMMARY</span></span></h2>${pill && pill[0] ? `<span class="sync-pill ${pill[1]}">${pill[0]}</span>` : ''}</div>
      <div class="segmented ws-weeks" role="group" aria-label="Week">
        <button type="button" class="seg${ui.which === 'last' ? ' active' : ''}" data-ws-week="last">Last week</button>
        <button type="button" class="seg${ui.which === 'this' ? ' active' : ''}" data-ws-week="this">This week${digest.week_complete ? '' : ' so far'}</button>
      </div>
      <p class="muted ws-range">${esc(digest.week.replace(/ \(\w+\)/g, ''))}</p>
      ${body}
      <button type="button" class="btn ${res && !stale ? 'ghost' : 'primary'} ws-go" data-ws-go${ui.busy || empty ? ' disabled' : ''}>${res ? (stale ? 'Update summary' : 'Regenerate') : 'Generate summary'}</button>`;

    card.onclick = async (e) => {
      const w = e.target.closest('[data-ws-week]');
      if (w) { ui.which = w.dataset.wsWeek; ui.error = ''; this.render(card, ctx); return; }
      if (!e.target.closest('[data-ws-go]') || ui.busy) return;
      ui.busy = true; ui.error = ''; this.render(card, ctx);
      try {
        const out = await ctx.ask({ system: SYSTEM, prompt: `Digest:\n${JSON.stringify(digest)}`, schema: SCHEMA, effort: 'medium' });
        const c = readCache(); c[weekStart] = { at: Date.now(), sig, result: out }; writeCache(c);
      } catch (err) { ui.error = err.message || String(err); }
      ui.busy = false;
      this.render(card, ctx);
    };
  },
};
