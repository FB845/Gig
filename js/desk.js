// desk.js — the desktop Planning desk (GT07 計画): a week timetable you plan on
// by dragging, shaded by when you actually earn best, with "fill the gap"
// suggestions for the weekly goal.
//
// Plans are ordinary planner records (store.addPlan/updatePlan), so the phone's
// Log → Plan list, Campaign 350's trajectory and cloud sync all see the same
// blocks. Logged shifts/incomes with clock times show as solid blocks.
import * as store from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ROW = 32;     // px per hour
const SNAP = 15;    // minutes
const MIN_LEN = 30; // shortest block, minutes
const DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PCOL = { flex: '#6aa8ff', doordash: '#ff6b5f', other: '#a78bfa', income: '#e8f1ff' };
const PNAME = { flex: 'Amazon Flex', doordash: 'DoorDash', other: 'Other', income: 'Income' };
const PLATS = ['flex', 'doordash', 'other'];

let C = null; // helpers from app.js
const st = { week: null, heat: true, sel: null, undo: [], range: [6, 24], drag: null, flash: null, cache: null };

const weekStartOf = (iso) => store.isoDate(store.startOfWeek(new Date(iso + 'T00:00:00')));
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return store.isoDate(d); };
const md = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${m}/${d}`; };
const hm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const snap = (m) => Math.round(m / SNAP) * SNAP;
const dowOf = (iso) => new Date(iso + 'T00:00:00').getDay();
const esc = (s) => C.escapeHtml(String(s ?? ''));
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

export function initDesk(ctx) {
  C = ctx;
  st.week = weekStartOf(store.todayISO());
  try { st.heat = localStorage.getItem('gigtracker.deskHeat') !== '0'; } catch { /* ignore */ }

  $('#desk-prev').addEventListener('click', () => goWeek(-1));
  $('#desk-next').addEventListener('click', () => goWeek(1));
  $('#desk-today').addEventListener('click', () => { st.week = weekStartOf(store.todayISO()); renderDesk(); });
  $('#desk-copy').addEventListener('click', copyLastWeek);
  $$('#desk-heat-seg .seg').forEach((b) => b.addEventListener('click', () => setHeat(b.dataset.heat === '1')));

  const grid = $('#desk-grid');
  grid.addEventListener('pointerdown', onPointerDown);
  grid.addEventListener('keydown', (e) => {
    const blk = e.target.closest('.dblk');
    if (blk && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(blk.dataset.kind, blk.dataset.id); }
  });
  grid.addEventListener('click', (e) => {
    const chip = e.target.closest('.d-chip');
    if (chip) select(chip.dataset.kind, chip.dataset.id);
  });

  $('#desk-sugg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (b) addSuggestion(Number(b.dataset.add));
  });
  $('#desk-sugg').addEventListener('mouseover', (e) => { const r = e.target.closest('[data-sugg]'); if (r) preview(Number(r.dataset.sugg)); });
  $('#desk-sugg').addEventListener('mouseleave', () => preview(null));
  $('#desk-sugg').addEventListener('focusin', (e) => { const r = e.target.closest('[data-sugg]'); if (r) preview(Number(r.dataset.sugg)); });
  $('#desk-sugg').addEventListener('focusout', () => preview(null));

  const insp = $('#desk-inspector');
  insp.addEventListener('change', onInspectorChange);
  insp.addEventListener('click', onInspectorClick);

  document.addEventListener('keydown', onKey);
}

// Open the desk on the week containing `date`, highlighting an hour (from the
// best-hours heat map's "Plan this slot").
export function focusSlot(date, hour) {
  st.week = weekStartOf(date);
  st.flash = { date, min: hour * 60 };
  C.showView('desk');
}

function goWeek(n) { st.week = addDays(st.week, 7 * n); st.sel = null; renderDesk(); }
function setHeat(on) {
  st.heat = on;
  try { localStorage.setItem('gigtracker.deskHeat', on ? '1' : '0'); } catch { /* ignore */ }
  renderDesk();
}

// ---------------------------------------------------------------------------
// Data for the visible week
// ---------------------------------------------------------------------------
function buildCache() {
  const heats = Object.fromEntries(PLATS.map((p) => [p, store.estimateHeat(p)]));
  const all = store.estimateHeat('all');
  const counts = {};
  for (const s of store.getShifts()) counts[s.platform] = (counts[s.platform] || 0) + 1;
  const usual = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'flex';
  const fallback = Object.fromEntries([...PLATS, 'income'].map((p) => [p, store.suggestedRate(p === 'income' ? 'other' : p)]));
  return { heats, all, usual, fallback, scale: store.heatScale(all) };
}

// Expected pay for a slot from the cached heat maps.
function estimate(date, startMin, endMin, platform) {
  const st0 = hm(startMin), en0 = hm(endMin);
  const hours = (endMin - startMin) / 60;
  const r = platform !== 'income' ? store.rateFromHeat(st.cache.heats[platform], date, st0, en0) : null;
  const rate = r ?? st.cache.fallback[platform] ?? 0;
  return { estimate: Math.round(rate * hours), rate, fromSlot: r != null };
}
// The platform that pays best in a slot (with history), else your usual one.
function bestPlatform(date, startMin, endMin) {
  let best = null;
  for (const p of PLATS) {
    const r = store.rateFromHeat(st.cache.heats[p], date, hm(startMin), hm(endMin));
    if (r != null && (!best || r > best.r)) best = { p, r };
  }
  return best ? best.p : st.cache.usual;
}

function itemsByDate(dates) {
  const set = new Set(dates);
  const m = new Map(dates.map((d) => [d, []]));
  for (const p of store.getPlans()) {
    if (!set.has(p.date) || store.planLogged(p)) continue;
    m.get(p.date).push({ kind: 'plan', id: p.id, rec: p, span: store.spanOf(p), platform: p.platform, tag: p.tag, amount: p.estimate, name: p.platform === 'income' ? (p.source || 'Income') : PNAME[p.platform], status: store.planStatus(p) });
  }
  for (const s of store.getShifts()) {
    if (!set.has(s.date)) continue;
    m.get(s.date).push({ kind: 'shift', id: s.id, rec: s, span: store.spanOf(s), platform: s.platform, tag: s.tag, amount: store.shiftIncome(s), name: PNAME[s.platform], hours: s.hours });
  }
  for (const i of store.getIncomes()) {
    if (!set.has(i.date)) continue;
    m.get(i.date).push({ kind: 'income', id: i.id, rec: i, span: store.spanOf(i), platform: 'income', amount: i.amount, name: i.source || 'Income', hours: i.hours });
  }
  return m;
}

// Side-by-side lanes for overlapping blocks; `warn` marks real overlaps.
function layout(items) {
  const timed = items.filter((x) => x.span).sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  let cluster = [], end = -1;
  const flush = () => {
    const laneEnds = [];
    for (const it of cluster) {
      let i = laneEnds.findIndex((e) => e <= it.span[0]);
      if (i === -1) { i = laneEnds.length; laneEnds.push(0); }
      laneEnds[i] = it.span[1]; it.lane = i;
    }
    for (const it of cluster) {
      it.lanes = laneEnds.length;
      it.warn = cluster.some((o) => o !== it && o.span[0] < it.span[1] && it.span[0] < o.span[1]);
    }
  };
  for (const it of timed) {
    if (cluster.length && it.span[0] >= end) { flush(); cluster = []; end = -1; }
    cluster.push(it); end = Math.max(end, it.span[1]);
  }
  if (cluster.length) flush();
  return timed;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
export function renderDesk() {
  if (!C || !$('#view-desk')) return;
  st.cache = buildCache();
  const today = store.todayISO();
  const wk = store.deskWeek(st.week);
  const items = itemsByDate(wk.dates);
  if (st.sel && !findItem(st.sel, items)) st.sel = null;

  // Hour range: 06–24, earlier if something starts earlier.
  let h0 = 6;
  for (const list of items.values()) for (const it of list) if (it.span) h0 = Math.min(h0, Math.floor(it.span[0] / 60));
  st.range = [h0, 24];

  // Header
  const diff = Math.round((new Date(st.week) - new Date(weekStartOf(today))) / (7 * 86400000));
  $('#desk-week-label').textContent = `${md(wk.start)} – ${md(wk.end)}`;
  $('#desk-week-sub').innerHTML = C.swapHTML(...(diff === 0 ? ['今週', 'THIS WEEK'] : diff === 1 ? ['来週', 'NEXT WEEK'] : diff === -1 ? ['先週', 'LAST WEEK'] : diff > 0 ? [`${diff}週後`, `IN ${diff} WEEKS`] : [`${-diff}週前`, `${-diff} WEEKS AGO`]));
  $('#desk-today').classList.toggle('hidden', diff === 0);
  $$('#desk-heat-seg .seg').forEach((b) => b.classList.toggle('active', (b.dataset.heat === '1') === st.heat));

  renderGoal(wk, today);
  renderGrid(wk, items, today);
  renderSuggestions(wk, today);
  renderInspector(items);
}

function renderGoal(wk, today) {
  const cells = Array.from({ length: 35 }, (_, i) => {
    const at = ((i + 0.5) / 35) * wk.goal;
    return `<span class="${at <= wk.earned ? 'lit' : at <= wk.projected ? 'plan' : ''}"></span>`;
  }).join('');
  const past = wk.end < today;
  const met = wk.projected >= wk.goal;
  const metDay = wk.metOn ? DOW_EN[dowOf(wk.metOn)] : '';
  const offs = wk.daysOff.map((d) => DOW_EN[dowOf(d)]).join(' & ');
  let flap, en, sub, color;
  if (past) { flap = met ? ['達成', 'grn'] : ['未達', 'red']; en = met ? `MET ${metDay.toUpperCase()}` : `MISSED BY ${C.fmtMoney0(wk.goal - wk.earned)}`; sub = 'final'; color = met ? 'var(--accent)' : 'var(--danger)'; }
  else if (met) { flap = ['達成', 'grn']; en = `MET ${metDay.toUpperCase()}`; sub = offs ? `${offs} earned off` : 'no free day left'; color = 'var(--accent)'; }
  else { flap = ['不足', 'gold']; en = `SHORT ${C.fmtMoney0(wk.shortfall)}`; sub = 'add blocks or extend one'; color = 'var(--gold)'; }
  const rate = wk.hours ? wk.timedMoney / wk.hours : 0;
  $('#desk-goal').innerHTML = `
    <div class="dg-amt"><span class="k-label">週間目標 WEEKLY GOAL</span><span><span class="led dg-total">${C.fmtMoney0(wk.projected)}</span> <span class="dg-goal">/ ${C.fmtMoney0(wk.goal)}</span></span></div>
    <div class="dg-bar"><div class="dg-cells" aria-hidden="true">${cells}</div>
      <span class="muted dg-sub">${C.fmtMoney0(wk.earned)} earned · ${C.fmtMoney0(wk.planned)} planned · ${C.fmt1(wk.hours)} h on the clock${rate ? ` · ${C.fmtMoney(rate)}/hr` : ''}</span></div>
    <div class="dg-status"><span class="flap lg ${flap[1]}">${flap[0]}</span><span class="dg-st"><span class="led" style="color:${color}">${en}</span><span class="muted">${sub}</span></span></div>`;
}

const HEAT_BG = ['transparent', 'transparent', 'rgba(232,241,255,.02)', 'rgba(232,241,255,.045)', 'rgba(61,255,122,.10)'];
function heatBg(rate) {
  const L = st.cache.scale.level(rate);
  return L < 0 ? 'transparent' : HEAT_BG[L];
}

function renderGrid(wk, items, today) {
  const [h0, h1] = st.range;
  const H = (h1 - h0) * ROW;
  const nm = nowMin();
  let head = '<span></span>', chips = '<span class="d-gut muted">終日</span>', cols = '';
  const gutter = Array.from({ length: h1 - h0 }, (_, i) => `<span style="top:${i * ROW - 6}px">${String(h0 + i).padStart(2, '0')}:00</span>`).join('');
  wk.days.forEach((day) => {
    const d = day.date, dow = dowOf(d);
    const isToday = d === today;
    const tc = day.total >= store.CAMPAIGN.daily ? 'var(--accent)' : day.total > 0 ? 'var(--text)' : '#3a4150';
    head += `<div class="d-head${isToday ? ' today' : ''}${day.past ? ' past' : ''}">
      <span class="d-hl"><span>${DOW_JP[dow]} ${DOW_EN[dow].toUpperCase()} <small>${md(d)}</small></span><span class="led" style="color:${tc}">${day.total ? C.fmtMoney0(day.total) : '—'}</span></span>
      <span class="d-hbar"><span style="width:${Math.min(100, (day.total / store.CAMPAIGN.daily) * 100)}%;background:${tc}"></span></span></div>`;
    const list = items.get(d);
    chips += `<div class="d-chips">${list.filter((x) => !x.span).map((x) => `<button type="button" class="d-chip k-${x.kind}${isSel(x) ? ' sel' : ''}" data-kind="${x.kind}" data-id="${x.id}" style="--c:${PCOL[x.platform] || PCOL.other}">${x.kind === 'plan' ? 'Anytime' : x.hours ? C.fmtHM(x.hours) : '—'} · ${esc(x.name)} <b>${C.fmtMoney0(x.amount)}${x.kind === 'plan' ? ' est' : ''}</b></button>`).join('')}</div>`;
    const heat = st.heat ? `<div class="d-heat" aria-hidden="true">${Array.from({ length: h1 - h0 }, (_, i) => `<span style="background:${heatBg(st.cache.all.cells[dow][h0 + i].rate)}"></span>`).join('')}</div>` : '';
    const off = wk.daysOff.includes(d) ? '<div class="d-off" aria-hidden="true"><span class="led">休</span></div>' : '';
    const now = isToday && nm >= h0 * 60 && nm < h1 * 60 ? `<div class="d-now" style="top:${(nm / 60 - h0) * ROW}px" aria-hidden="true"></div>` : '';
    const flash = st.flash && st.flash.date === d ? `<div class="d-flash" style="top:${(st.flash.min / 60 - h0) * ROW}px;height:${ROW}px" aria-hidden="true"></div>` : '';
    const blocks = layout(list).map((it) => blockHTML(it, d)).join('');
    cols += `<div class="dcol${day.past ? ' past' : ''}" data-date="${d}" style="height:${H}px">${heat}${off}${flash}${blocks}${now}</div>`;
  });
  $('#desk-grid').innerHTML = `
    <div class="d-row d-heads">${head}</div>
    <div class="d-row d-chiprow">${chips}</div>
    <div class="d-row d-body"><div class="d-gutter muted" style="height:${H}px">${gutter}</div>${cols}</div>`;
  st.flash = null;
}

function isSel(it) { return st.sel && st.sel.kind === it.kind && st.sel.id === it.id; }
function findItem(sel, items) {
  for (const list of items.values()) { const it = list.find((x) => x.kind === sel.kind && x.id === sel.id); if (it) return it; }
  return null;
}

function blockHTML(it, date) {
  const [h0, h1] = st.range;
  const s = it.span[0], e = Math.min(it.span[1], h1 * 60);
  const top = (s / 60 - h0) * ROW + 1;
  const h = Math.max(14, ((e - s) / 60) * ROW - 3);
  const ty = it.tag && C.TRAIN_TYPES[it.tag];
  const plan = it.kind === 'plan';
  const amt = plan ? `${C.fmtMoney0(it.amount)} est` : C.fmtMoney0(it.amount);
  const cls = ['dblk', `k-${it.kind}`, plan ? `st-${it.status}` : '', it.warn ? 'warn' : '', isSel(it) ? 'sel' : '', h < 46 ? 'short' : ''].filter(Boolean).join(' ');
  const label = `${DOW_EN[dowOf(date)]} ${hm(s)}–${hm(it.span[1])}, ${it.name}, ${amt}${it.warn ? ', overlaps another block' : ''}`;
  return `<div class="${cls}" role="button" tabindex="0" data-kind="${it.kind}" data-id="${it.id}" aria-label="${esc(label)}"
    style="top:${top}px;height:${h}px;left:calc(${(it.lane / it.lanes) * 100}% + 2px);width:calc(${100 / it.lanes}% - 4px);--c:${PCOL[it.platform] || PCOL.other}">
    <span class="db-top"><span class="db-time">${hm(s)}–${hm(it.span[1])}</span>${ty ? C.flapHTML(ty.label, ty.color, ty.ink, 'sm') : ''}</span>
    <span class="db-name">${esc(it.name)}</span>
    <span class="db-amt">${amt}</span>
    ${plan ? '<span class="db-rs" data-rs="1" aria-hidden="true"></span>' : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Fill the gap
// ---------------------------------------------------------------------------
let suggs = [];
function renderSuggestions(wk, today) {
  const host = $('#desk-sugg');
  const line = $('#desk-gap-line');
  if (wk.end < today) { suggs = []; host.innerHTML = '<li class="empty-list">This week is over.</li>'; line.textContent = ''; return; }
  suggs = store.suggestSlots(wk.start);
  const heatTimed = st.cache.all.timed;
  if (!suggs.length) {
    host.innerHTML = `<li class="empty-list">${heatTimed ? 'No open slots with enough history this week.' : 'Log shifts with start–finish times (or use drive mode / calendar import) to get suggestions.'}</li>`;
  } else {
    host.innerHTML = suggs.map((s, i) => {
      const dow = dowOf(s.date);
      return `<li class="d-sugg" data-sugg="${i}" tabindex="-1">
        <span class="ds-main">
          <span class="ds-top"><span class="led">${DOW_EN[dow]} ${s.startTime}–${s.endTime}</span>${s.freeDay ? '<span class="ds-free">uses a free day</span>' : ''}</span>
          <span class="muted">${PNAME[s.platform]} · ${C.fmtMoney(s.rate)}/hr · ${s.shifts} past shift${s.shifts === 1 ? '' : 's'}</span>
        </span>
        <span class="ds-act"><span class="led ds-est">+${C.fmtMoney0(s.estimate)}</span><button type="button" class="btn ghost ds-add" data-add="${i}" aria-label="Add ${DOW_EN[dow]} ${s.startTime} to ${s.endTime} ${PNAME[s.platform]}">+ Add</button></span>
      </li>`;
    }).join('');
  }
  line.textContent = gapLine(wk);
  line.className = 'd-gap ' + (wk.shortfall ? 'muted' : 'ok');
  line.dataset.base = line.textContent;
}

function gapLine(wk) {
  if (!wk.shortfall) {
    const offs = wk.daysOff.map((d) => DOW_EN[dowOf(d)]).join(' & ');
    return `Goal covered${offs ? ` — ${offs} off` : ''}.`;
  }
  if (!suggs.length) return `${C.fmtMoney0(wk.shortfall)} still to plan.`;
  const pick = (list) => { let acc = 0; const out = []; for (const s of list) { if (acc >= wk.shortfall) break; acc += s.estimate; out.push(s); } return { acc, out }; };
  const keep = pick(suggs.filter((s) => !s.freeDay));
  const any = pick(suggs);
  const names = (xs) => xs.map((s) => `${DOW_EN[dowOf(s.date)]} ${s.startTime}`).join(', ');
  if (keep.acc >= wk.shortfall) return `${names(keep.out)} cover the ${C.fmtMoney0(wk.shortfall)} gap${suggs.some((s) => s.freeDay) ? ' and keep your free day' : ''}.`;
  if (any.acc >= wk.shortfall) return `${names(any.out)} cover the ${C.fmtMoney0(wk.shortfall)} gap (uses a free day).`;
  return `Every suggestion still leaves ${C.fmtMoney0(wk.shortfall - any.acc)} — extend a block or add a longer one.`;
}

function preview(i) {
  $$('.d-ghost.pv', $('#desk-grid')).forEach((g) => g.remove());
  const line = $('#desk-gap-line');
  if (i == null || !suggs[i]) { if (line.dataset.base != null) line.textContent = line.dataset.base; return; }
  const s = suggs[i];
  const col = $(`.dcol[data-date="${s.date}"]`);
  if (!col) return;
  const sp = store.spanOf(s);
  col.insertAdjacentHTML('beforeend', ghostHTML('pv', sp[0], sp[1], `+${C.fmtMoney0(s.estimate)}`));
  const wk = store.deskWeek(st.week);
  line.textContent = `With this: ${C.fmtMoney0(wk.projected)} → ${C.fmtMoney0(wk.projected + s.estimate)}${wk.projected + s.estimate >= wk.goal ? ' — goal met' : ` · ${C.fmtMoney0(wk.goal - wk.projected - s.estimate)} to go`}`;
}

function ghostHTML(cls, s, e, text) {
  const [h0] = st.range;
  return `<div class="d-ghost ${cls}" style="top:${(s / 60 - h0) * ROW + 1}px;height:${Math.max(14, ((e - s) / 60) * ROW - 3)}px" aria-hidden="true"><span class="db-time">${hm(s)}–${hm(e)}</span><span class="db-amt">${text}</span></div>`;
}

function addSuggestion(i) {
  const s = suggs[i];
  if (!s) return;
  const p = store.addPlan({ date: s.date, platform: s.platform, startTime: s.startTime, endTime: s.endTime, estimate: s.estimate });
  pushUndo({ type: 'add', ids: [p.id] });
  st.sel = { kind: 'plan', id: p.id };
  renderDesk();
  C.toast(`Planned ${DOW_EN[dowOf(s.date)]} ${s.startTime}–${s.endTime} · +${C.fmtMoney0(s.estimate)}`);
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------
function select(kind, id) { st.sel = { kind, id }; renderDesk(); }

function renderInspector(items) {
  const host = $('#desk-inspector');
  const head = `<div class="card-head"><h2 aria-label="Selected"><span class="swap"><span>選択中</span><span>SELECTED</span></span></h2>`;
  const it = st.sel && findItem(st.sel, items);
  if (!it) {
    host.innerHTML = `${head}</div><p class="muted">Select a block — or drag down an empty column to add one. Keys: N new · ←/→ week · H best hours · Del delete · ⌘D duplicate · ⌘Z undo.</p>`;
    return;
  }
  const r = it.rec;
  const dow = DOW_EN[dowOf(r.date)];
  const time = it.span ? `${hm(it.span[0])}–${hm(it.span[1])}` : 'Anytime';
  const ty = it.tag && C.TRAIN_TYPES[it.tag];
  if (it.kind !== 'plan') {
    host.innerHTML = `${head}<span class="flap grn">Logged ✓</span></div>
      <div class="di-when"><span class="led">${dow} ${time}</span>${ty ? C.flapHTML(ty.label, ty.color, ty.ink) : ''}</div>
      <p class="muted">${esc(it.name)} · ${it.hours ? C.fmtHM(it.hours) : '—'} · ${C.fmtMoney(it.amount)}</p>
      <div class="btn-grid2"><button type="button" class="btn span2" data-di="edit-logged">Edit in Log</button></div>`;
    return;
  }
  const status = { today: ['Today', 'tea'], upcoming: ['Planned', 'gold'], missed: ['Missed', 'red'] }[it.status] || ['Planned', 'gold'];
  const hrs = it.span ? (it.span[1] - it.span[0]) / 60 : r.hours;
  const est = it.span ? estimate(r.date, it.span[0], it.span[1], r.platform) : null;
  const platChips = [...PLATS, 'income'].map((p) => `<button type="button" class="chip${r.platform === p ? ' active' : ''}" data-di-plat="${p}">${p === 'income' ? '収入' : p === 'flex' ? 'Flex' : PNAME[p]}</button>`).join('');
  const tags = r.platform === 'flex' ? `<div class="di-tags">${Object.entries(C.TRAIN_TYPES).map(([k, t]) => `<button type="button" class="di-tag${r.tag === k ? ' active' : ''}" data-di-tag="${k}" aria-label="${k}" aria-pressed="${r.tag === k}">${C.flapHTML(t.label, t.color, t.ink, 'sm')}</button>`).join('')}</div>` : '';
  host.innerHTML = `${head}<span class="flap ${status[1]}">${status[0]}</span></div>
    <div class="di-when"><span class="led">${dow} ${md(r.date)} ${time}</span>${ty ? C.flapHTML(ty.label, ty.color, ty.ink) : ''}</div>
    <p class="muted">${esc(it.name)}${hrs ? ` · ${C.fmtHM(hrs)}` : ''}</p>
    <div class="di-plats">${platChips}</div>
    ${tags}
    <div class="row">
      <div class="field"><label for="di-start">Start 発</label><input type="time" id="di-start" value="${r.startTime || ''}" /></div>
      <div class="field"><label for="di-end">Finish 着</label><input type="time" id="di-end" value="${r.endTime || ''}" /></div>
    </div>
    <div class="field"><label for="di-est">Estimate 見込 $ ${est ? `<span class="hint">your ${dow} avg here ${C.fmtMoney(est.rate)}/hr → ${C.fmtMoney0(est.estimate)}${est.fromSlot ? '' : ' (overall avg)'}</span>` : ''}</label><input type="number" id="di-est" min="0" step="1" inputmode="decimal" value="${r.estimate || ''}" /></div>
    ${r.platform === 'income' ? `<div class="field"><label for="di-source">Source 取引先</label><input type="text" id="di-source" value="${esc(r.source)}" /></div>` : ''}
    <div class="field"><label for="di-note">Note メモ</label><input type="text" id="di-note" value="${esc(r.note)}" /></div>
    <div class="di-acts">
      <button type="button" class="btn" data-di="dup">Duplicate</button>
      <button type="button" class="btn ghost di-log" data-di="log">Log it</button>
      <button type="button" class="btn danger" data-di="del">Delete</button>
    </div>`;
}

function selPlan() { return st.sel && st.sel.kind === 'plan' ? store.getPlans().find((p) => p.id === st.sel.id) : null; }
function snapshot(p) { return { ...p }; }

function onInspectorChange(e) {
  const p = selPlan();
  if (!p) return;
  const t = e.target;
  const patch = {};
  if (t.id === 'di-start' || t.id === 'di-end') {
    const s = $('#di-start').value, en = $('#di-end').value;
    if (!s || !en || s === en) { C.toast('Start and finish must differ'); renderDesk(); return; }
    patch.startTime = s; patch.endTime = en;
    Object.assign(patch, reEstimate(p, p.date, s, en, p.platform));
  } else if (t.id === 'di-est') patch.estimate = Number(t.value) || 0;
  else if (t.id === 'di-note') patch.note = t.value;
  else if (t.id === 'di-source') patch.source = t.value;
  else return;
  commitUpdate(p, patch);
}

function onInspectorClick(e) {
  const p = selPlan();
  const plat = e.target.closest('[data-di-plat]');
  const tag = e.target.closest('[data-di-tag]');
  const act = e.target.closest('[data-di]');
  if (plat && p) {
    const platform = plat.dataset.diPlat;
    commitUpdate(p, { platform, ...reEstimate(p, p.date, p.startTime, p.endTime, platform) });
  } else if (tag && p) {
    commitUpdate(p, { tag: p.tag === tag.dataset.diTag ? '' : tag.dataset.diTag });
  } else if (act) {
    const a = act.dataset.di;
    if (a === 'edit-logged') {
      if (st.sel.kind === 'shift') C.editShift(st.sel.id); else C.editIncome(st.sel.id);
      C.showView('log');
    } else if (a === 'del' && p) deleteSelected();
    else if (a === 'dup' && p) duplicateSelected();
    else if (a === 'log' && p) C.logPlan(p.id);
  }
}

// If a plan's estimate is still the automatic one, keep it automatic when its
// slot or platform changes; a hand-typed estimate is left alone.
function reEstimate(p, date, startTime, endTime, platform) {
  const sp0 = store.spanOf(p), sp1 = store.spanOf({ startTime, endTime });
  if (!sp1) return {};
  const auto = sp0 ? estimate(p.date, sp0[0], sp0[1], p.platform).estimate : null;
  if (auto != null && Math.abs(auto - (p.estimate || 0)) > 1 && p.estimate) return {};
  return { estimate: estimate(date, sp1[0], sp1[1], platform).estimate };
}

function commitUpdate(p, patch) {
  if (Object.keys(patch).every((k) => p[k] === patch[k])) return; // nothing changed
  pushUndo({ type: 'update', before: snapshot(p) });
  store.updatePlan(p.id, patch);
}

function deleteSelected() {
  const p = selPlan();
  if (!p) return;
  pushUndo({ type: 'delete', plans: [snapshot(p)] });
  st.sel = null;
  store.deletePlan(p.id);
  C.toast('Plan deleted — ⌘Z to undo');
}

// Duplicate to the next day at the same time (or the first later day that's free).
function duplicateSelected() {
  const p = selPlan();
  if (!p) return;
  const sp = store.spanOf(p);
  let date = addDays(p.date, 1);
  if (sp) {
    for (let i = 1; i <= 7; i++) {
      const d = addDays(p.date, i);
      const busy = [...store.getPlans().filter((x) => x.date === d && !store.planLogged(x)), ...store.getShifts().filter((x) => x.date === d), ...store.getIncomes().filter((x) => x.date === d)]
        .map((x) => store.spanOf(x)).filter(Boolean);
      if (!busy.some((b) => sp[0] < b[1] && b[0] < sp[1])) { date = d; break; }
    }
  }
  const { id, createdAt, loggedId, loggedType, ...rest } = p;
  const np = store.addPlan({ ...rest, date, ...(sp ? reEstimate(p, date, p.startTime, p.endTime, p.platform) : {}) });
  pushUndo({ type: 'add', ids: [np.id] });
  st.sel = { kind: 'plan', id: np.id };
  if (date < st.week || date > addDays(st.week, 6)) st.week = weekStartOf(date);
  renderDesk();
  C.toast(`Duplicated to ${DOW_EN[dowOf(date)]} ${md(date)}`);
}

function copyLastWeek() {
  const ids = store.copyWeekPlans(addDays(st.week, -7), st.week);
  if (!ids.length) { C.toast('Nothing to copy from last week (or it would all overlap)'); return; }
  pushUndo({ type: 'add', ids });
  C.toast(`Copied ${ids.length} block${ids.length === 1 ? '' : 's'} from last week — ⌘Z to undo`);
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
function pushUndo(op) { st.undo.push(op); if (st.undo.length > 50) st.undo.shift(); }
function undo() {
  const op = st.undo.pop();
  if (!op) { C.toast('Nothing to undo'); return; }
  if (op.type === 'add') op.ids.forEach((id) => store.deletePlan(id));
  else if (op.type === 'update') store.restorePlan(op.before);
  else if (op.type === 'delete') op.plans.forEach((p) => store.restorePlan(p));
  C.toast('Undone');
}

// ---------------------------------------------------------------------------
// Keys (only while the desk is showing and you're not typing in a field)
// ---------------------------------------------------------------------------
function onKey(e) {
  if (!$('#view-desk').classList.contains('active')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (mod || e.altKey) return;
  else if (k === 'arrowleft') { e.preventDefault(); goWeek(-1); }
  else if (k === 'arrowright') { e.preventDefault(); goWeek(1); }
  else if (k === 'h') setHeat(!st.heat);
  else if (k === 'n') newBlockAtNextFreeHour();
  else if (k === 'delete' || k === 'backspace') { if (selPlan()) { e.preventDefault(); deleteSelected(); } }
  else if (k === 'escape') { st.sel = null; renderDesk(); }
}

// N: a 3-hour block at the next free whole hour (today if this week, else the
// first day of the week from 09:00), on whichever platform pays best there.
function newBlockAtNextFreeHour() {
  const today = store.todayISO();
  const start = st.week <= today && today <= addDays(st.week, 6) ? today : st.week;
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    if (date > addDays(st.week, 6)) break;
    const from = date === today ? Math.max(6, Math.ceil((nowMin() + 1) / 60)) : (date === st.week && start === st.week ? 9 : 6);
    const busy = [...store.getPlans().filter((x) => x.date === date && !store.planLogged(x)), ...store.getShifts().filter((x) => x.date === date), ...store.getIncomes().filter((x) => x.date === date)]
      .map((x) => store.spanOf(x)).filter(Boolean);
    for (let h = from; h + 3 <= 24; h++) {
      const span = [h * 60, (h + 3) * 60];
      if (busy.some((b) => span[0] < b[1] && b[0] < span[1])) continue;
      createPlan(date, span[0], span[1]);
      return;
    }
  }
  C.toast('No free 3-hour slot left this week');
}

function createPlan(date, s, e) {
  const platform = bestPlatform(date, s, e);
  const est = estimate(date, s, e, platform);
  const p = store.addPlan({ date, platform, startTime: hm(s), endTime: hm(e), estimate: est.estimate });
  pushUndo({ type: 'add', ids: [p.id] });
  st.sel = { kind: 'plan', id: p.id };
  renderDesk(); // the save above re-rendered before the selection was set
  return p;
}

// ---------------------------------------------------------------------------
// Drag: create (empty column), move (plan body), resize (plan bottom edge)
// ---------------------------------------------------------------------------
function colAt(x) {
  return $$('.dcol', $('#desk-grid')).find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; }) || null;
}
function minAt(col, y) {
  const [h0, h1] = st.range;
  const r = col.getBoundingClientRect();
  return Math.max(h0 * 60, Math.min(h1 * 60, h0 * 60 + ((y - r.top) / ROW) * 60));
}
function tip(col, text, atMin) {
  let t = $('.d-tip', $('#desk-grid'));
  if (!t) { t = document.createElement('div'); t.className = 'd-tip'; }
  if (t.parentElement !== col) col.appendChild(t);
  t.textContent = text;
  t.style.top = `${(atMin / 60 - st.range[0]) * ROW + 4}px`;
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const grid = $('#desk-grid');
  const blk = e.target.closest('.dblk');
  const col = e.target.closest('.dcol');
  if (!col) return;
  if (blk) {
    const kind = blk.dataset.kind, id = blk.dataset.id;
    const p = kind === 'plan' ? store.getPlans().find((x) => x.id === id) : null;
    const sp = p && store.spanOf(p);
    if (!sp) { st.drag = { mode: 'click', kind, id, x: e.clientX, y: e.clientY }; }
    else if (e.target.closest('[data-rs]')) st.drag = { mode: 'resize', p, sp, col, x: e.clientX, y: e.clientY, end: sp[1], moved: false };
    else st.drag = { mode: 'move', p, sp, col, x: e.clientX, y: e.clientY, grab: minAt(col, e.clientY) - sp[0], date: p.date, start: sp[0], moved: false };
  } else {
    if (e.pointerType === 'touch') return; // let touch scroll the grid
    const m = snap(minAt(col, e.clientY));
    st.drag = { mode: 'create', col, date: col.dataset.date, a: m, b: m, x: e.clientX, y: e.clientY, moved: false };
  }
  e.preventDefault();
  grid.setPointerCapture(e.pointerId);
  grid.addEventListener('pointermove', onPointerMove);
  grid.addEventListener('pointerup', onPointerUp, { once: true });
  grid.addEventListener('pointercancel', onPointerCancel, { once: true });
}

function onPointerMove(e) {
  const d = st.drag;
  if (!d) return;
  if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
  d.moved = true;
  $('#desk-grid').classList.add('dragging');
  const [h0, h1] = st.range;
  if (d.mode === 'create') {
    d.b = snap(minAt(d.col, e.clientY));
    const s = Math.min(d.a, d.b), en = Math.max(d.a, d.b, s + MIN_LEN);
    const end = Math.min(en, h1 * 60);
    drawGhost(d.col, 'new', s, end, '');
    const plat = bestPlatform(d.date, s, end);
    tip(d.col, `${hm(s)}–${hm(end)} · ${C.fmtHM((end - s) / 60)} · est ${C.fmtMoney0(estimate(d.date, s, end, plat).estimate)} ${PNAME[plat]}`, end);
  } else if (d.mode === 'move') {
    const col = colAt(e.clientX) || d.col;
    const len = d.sp[1] - d.sp[0];
    const s = Math.max(h0 * 60, Math.min(h1 * 60 - len, snap(minAt(col, e.clientY) - d.grab)));
    d.date = col.dataset.date; d.start = s; d.col = col;
    $(`.dblk[data-id="${d.p.id}"]`)?.classList.add('lifted');
    drawGhost(col, 'move', s, s + len, '');
    const est = reEstimate(d.p, d.date, hm(s), hm(s + len), d.p.platform).estimate;
    tip(col, `${DOW_EN[dowOf(d.date)]} ${hm(s)}–${hm(s + len)}${est != null ? ` · est ${C.fmtMoney0(est)}` : ''}`, s + len);
  } else if (d.mode === 'resize') {
    d.end = Math.min(h1 * 60, Math.max(d.sp[0] + MIN_LEN, snap(minAt(d.col, e.clientY))));
    drawGhost(d.col, 'move', d.sp[0], d.end, '');
    $(`.dblk[data-id="${d.p.id}"]`)?.classList.add('lifted');
    const est = reEstimate(d.p, d.p.date, d.p.startTime, hm(d.end), d.p.platform).estimate;
    const delta = est != null ? est - (d.p.estimate || 0) : null;
    tip(d.col, `${hm(d.end)}${delta ? ` · ${delta > 0 ? '+' : '−'}${C.fmtMoney0(Math.abs(delta))}` : ''}`, d.end);
  }
}

function drawGhost(col, cls, s, e, text) {
  $$('.d-ghost.drag', $('#desk-grid')).forEach((g) => g.remove());
  col.insertAdjacentHTML('beforeend', ghostHTML(`drag ${cls}`, s, e, text));
}

function cleanupDrag() {
  const grid = $('#desk-grid');
  grid.removeEventListener('pointermove', onPointerMove);
  grid.classList.remove('dragging');
  $$('.d-ghost.drag, .d-tip', grid).forEach((g) => g.remove());
  $$('.dblk.lifted', grid).forEach((b) => b.classList.remove('lifted'));
}
function onPointerCancel() { cleanupDrag(); st.drag = null; }

function onPointerUp() {
  const d = st.drag;
  st.drag = null;
  cleanupDrag();
  if (!d) return;
  if (d.mode === 'click' || (!d.moved && d.mode !== 'create')) { select(d.kind || 'plan', d.id || d.p.id); return; }
  if (d.mode === 'create') {
    if (!d.moved) { if (st.sel) { st.sel = null; renderDesk(); } return; }
    const s = Math.min(d.a, d.b), e = Math.min(Math.max(d.a, d.b, s + MIN_LEN), st.range[1] * 60);
    const p = createPlan(d.date, s, e);
    C.toast(`Planned ${DOW_EN[dowOf(d.date)]} ${p.startTime}–${p.endTime} · ${C.fmtMoney0(p.estimate)} est`);
  } else if (d.mode === 'move') {
    const len = d.sp[1] - d.sp[0];
    if (d.date === d.p.date && d.start === d.sp[0]) return;
    const startTime = hm(d.start), endTime = hm(d.start + len);
    st.sel = { kind: 'plan', id: d.p.id };
    commitUpdate(d.p, { date: d.date, startTime, endTime, ...reEstimate(d.p, d.date, startTime, endTime, d.p.platform) });
  } else if (d.mode === 'resize') {
    if (d.end === d.sp[1]) return;
    st.sel = { kind: 'plan', id: d.p.id };
    commitUpdate(d.p, { endTime: hm(d.end), ...reEstimate(d.p, d.p.date, d.p.startTime, hm(d.end), d.p.platform) });
  }
}
