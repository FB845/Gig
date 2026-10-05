// besthours.js — Trends → 最適時間 Best hours: your $/hr by weekday × hour of
// day (from shifts logged with start–finish times), with platform, gross/net
// and period filters, a slot detail, the top slots and how much of your
// history has clock times. "Plan this slot →" opens the Planning desk there.
import * as store from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PNAME = { flex: 'Amazon Flex', doordash: 'DoorDash', other: 'Other' };
const H0 = 6, H1 = 24;
const BG = ['#0b0e13', '#1b2230', '#3a4660', '#a9b8cf', '#3dff7a'];
const FG = ['#5c6880', '#8a95a5', '#c9d4e3', '#05070a', '#04140a'];
const KEY = 'gigtracker.bestHours';

let C = null;
let st = { platform: 'all', net: false, days: 90, pick: null };

export function initBestHours(ctx) {
  C = ctx;
  try { st = { ...st, ...JSON.parse(localStorage.getItem(KEY) || '{}'), pick: null }; } catch { /* ignore */ }
  const card = $('#best-hours-card');
  if (!card) return;
  card.addEventListener('click', (e) => {
    const f = e.target.closest('[data-bh]');
    if (f) {
      const [k, v] = f.dataset.bh.split(':');
      st[k] = k === 'net' ? v === '1' : k === 'days' ? Number(v) : v;
      try { localStorage.setItem(KEY, JSON.stringify({ platform: st.platform, net: st.net, days: st.days })); } catch { /* ignore */ }
      renderBestHours();
      return;
    }
    const cell = e.target.closest('[data-cell]');
    if (cell) { st.pick = cell.dataset.cell.split(',').map(Number); renderBestHours(); return; }
    if (e.target.closest('#bh-plan') && st.pick) {
      const [dow, h] = st.pick;
      C.focusSlot(nextDateFor(dow, h), h);
    }
  });
}

// The next date on that weekday whose hour is still ahead (today counts).
function nextDateFor(dow, hour) {
  const d = new Date();
  for (let i = 0; i < 8; i++) {
    const x = new Date(d); x.setDate(d.getDate() + i);
    if (x.getDay() === dow && (i > 0 || hour > d.getHours())) return store.isoDate(x);
  }
  return store.todayISO();
}

function who(dow, h) {
  if (st.platform !== 'all') return PNAME[st.platform];
  const per = ['flex', 'doordash', 'other'].map((p) => ({ p, c: store.hourlyHeat({ platform: p, days: st.days, net: st.net }).cells[dow][h] }))
    .filter((x) => x.c.rate != null).sort((a, b) => b.c.hours - a.c.hours);
  return per.length ? `mostly ${PNAME[per[0].p]}` : '';
}

export function renderBestHours() {
  const card = $('#best-hours-card');
  if (!card || !C) return;
  const heat = store.hourlyHeat({ platform: st.platform, days: st.days, net: st.net });
  const scale = store.heatScale(heat);
  const ws = store.getSettings().weekStart;
  const order = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);
  const seg = (k, opts) => opts.map(([v, label]) => `<button type="button" class="seg${String(st[k] === true ? 1 : st[k] === false ? 0 : st[k]) === String(v) ? ' active' : ''}" data-bh="${k}:${v}">${label}</button>`).join('');

  $('#bh-filters').innerHTML = `
    <div class="segmented bh-seg" role="group" aria-label="Platform">${seg('platform', [['all', 'All'], ['flex', 'Flex'], ['doordash', 'DoorDash']])}</div>
    <div class="segmented bh-seg" role="group" aria-label="Pay measure">${seg('net', [[0, 'Gross'], [1, 'Net of costs']])}</div>
    <div class="segmented bh-seg" role="group" aria-label="Period">${seg('days', [[30, '30 d'], [90, '90 d'], [0, 'All']])}</div>`;

  if (!scale.n) {
    $('#bh-grid').innerHTML = `<div class="chart-empty">No shifts with start–finish times${st.days ? ` in the last ${st.days} days` : ''} yet. Log with Start–Finish, use drive mode, or import your calendar.</div>`;
    $('#bh-side').innerHTML = coverage(heat);
    $('#bh-legend').innerHTML = '';
    return;
  }
  // Default pick: your single best cell.
  if (!st.pick) {
    let best = null;
    order.forEach((d) => { for (let h = H0; h < H1; h++) { const r = heat.cells[d][h].rate; if (r != null && (!best || r > best.r)) best = { d, h, r }; } });
    st.pick = best ? [best.d, best.h] : [order[0], 18];
  }
  const [pd, ph] = st.pick;

  let html = '<span></span>' + Array.from({ length: H1 - H0 }, (_, i) => `<span class="bh-hr muted">${String(H0 + i).padStart(2, '0')}</span>`).join('');
  for (const d of order) {
    html += `<span class="bh-day${d === 0 || d === 6 ? ' we' : ''}">${DOW_JP[d]} ${DOW_EN[d]}</span>`;
    for (let h = H0; h < H1; h++) {
      const c = heat.cells[d][h];
      const L = scale.level(c.rate);
      const label = `${DOW_EN[d]} ${String(h).padStart(2, '0')}:00: ${c.rate == null ? 'no data' : `${C.fmtMoney(c.rate)} per hour`}`;
      html += `<button type="button" class="bh-cell${L < 0 ? ' none' : ''}${d === pd && h === ph ? ' sel' : ''}" data-cell="${d},${h}" aria-label="${label}"${L >= 0 ? ` style="background:${BG[L]};color:${FG[L]}"` : ''}>${c.rate == null ? '' : Math.round(c.rate)}</button>`;
    }
  }
  $('#bh-grid').innerHTML = `<div class="bh-matrix">${html}</div>`;
  const band = ([a, b]) => (Math.round(a) === Math.round(b) ? `$${Math.round(a)}` : `$${Math.round(a)}–${Math.round(b)}`);
  $('#bh-legend').innerHTML = `<span>$/hr</span>${scale.bands.map((b, L) => (b ? `<span class="bh-lg"><i style="background:${BG[L]}"></i>${band(b)}${L === 4 ? ' best' : ''}</span>` : '')).join('')}<span class="bh-lg"><i class="none"></i>no data</span>`;

  const pc = heat.cells[pd][ph];
  const top = [];
  order.forEach((d) => { for (let h = H0; h < H1; h++) { const c = heat.cells[d][h]; if (c.rate != null) top.push({ d, h, c }); } });
  top.sort((a, b) => b.c.rate - a.c.rate);
  const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;
  $('#bh-side').innerHTML = `
    <div class="bh-slot">
      <span class="k-label">選択した時間帯 THIS SLOT</span>
      <span class="led bh-when">${DOW_JP[pd]} ${DOW_EN[pd]} ${hh(ph)}–${hh(ph + 1)}</span>
      <span><span class="led bh-rate" style="color:${scale.level(pc.rate) === 4 ? 'var(--accent)' : 'var(--text)'}">${pc.rate == null ? '—' : C.fmtMoney(pc.rate)}</span> <span class="k-label">/hr ${st.net ? 'net' : 'gross'}</span></span>
      <span class="muted">${pc.rate == null ? 'No shifts in this slot yet.' : `${who(pd, ph)} · ${pc.shifts} past shift${pc.shifts === 1 ? '' : 's'} · ${C.fmt1(pc.hours)} h`}</span>
      <button type="button" class="btn ghost bh-plan" id="bh-plan">Plan this slot →</button>
    </div>
    <div class="bh-top">
      <span class="k-label">最適時間 TOP SLOTS</span>
      <ol>${top.slice(0, 6).map((x, i) => `<li><span class="led bh-rank">${String(i + 1).padStart(2, '0')}</span><span class="bh-tw"><span class="led">${DOW_JP[x.d]} ${DOW_EN[x.d]} ${hh(x.h)}–${hh(x.h + 1)}</span><span class="muted">${who(x.d, x.h)}</span></span><span class="led" style="color:${i === 0 ? 'var(--accent)' : 'var(--text)'}">${C.fmtMoney(x.c.rate)}</span></li>`).join('')}</ol>
    </div>
    ${coverage(heat)}`;
}

function coverage(heat) {
  const untimed = heat.total - heat.timed;
  return `<div class="bh-cov"><span class="k-label">データ範囲 COVERAGE</span>
    <span><span class="led">${heat.timed}</span> <span class="k-label">of ${heat.total} shifts have start–finish times</span></span>
    ${untimed ? `<span class="muted">${untimed} logged as a duration only — they count in totals, not on the clock. Start–Finish mode, drives and calendar imports fill this in.</span>` : ''}</div>`;
}
