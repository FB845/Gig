// charts.js — tiny dependency-free SVG charts. Theme-aware via currentColor
// and CSS variables. All render into a container element.

const NS = 'http://www.w3.org/2000/svg';
const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function el(tag, attrs = {}, kids = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.appendChild(k);
  return e;
}

function emptyState(container, msg) {
  container.innerHTML = `<div class="chart-empty">${msg}</div>`;
}

// ---- Bar chart (single or stacked series) ----
// data: [{ label, values: {seriesKey: number} }], series: [{key,label,color}]
export function barChart(container, data, series, opts = {}) {
  container.innerHTML = '';
  if (!data.length) return emptyState(container, opts.empty || 'No data yet');

  const W = opts.width || container.clientWidth || 320;
  const H = opts.height || 200;
  const padL = 44, padR = 12, padT = 12, padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const totals = data.map((d) => series.reduce((a, s) => a + (d.values[s.key] || 0), 0));
  const refV = opts.refLine ? opts.refLine.value : 0;
  const max = Math.max(1, refV, ...totals);
  const niceMax = niceCeil(max);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });

  // gridlines + y labels
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const y = padT + plotH - (plotH * i) / ticks;
    const val = (niceMax * i) / ticks;
    svg.appendChild(el('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid' }));
    svg.appendChild(text(4, y + 3, money(val), 'axis'));
  }

  const groupW = plotW / data.length;
  const barW = Math.min(38, groupW * 0.62);

  data.forEach((d, i) => {
    const cx = padL + groupW * i + groupW / 2;
    let yCursor = padT + plotH;
    series.forEach((s) => {
      const v = d.values[s.key] || 0;
      if (v <= 0) return;
      const h = (v / niceMax) * plotH;
      yCursor -= h;
      const rect = el('rect', {
        x: cx - barW / 2, y: yCursor, width: barW, height: Math.max(0, h),
        rx: 3, fill: d.color || s.color, class: 'bar', // per-point color override
      });
      rect.appendChild(el('title', {}, [document.createTextNode(`${d.label} · ${s.label}: ${money(v)}`)]));
      svg.appendChild(rect);
    });
    // x label (skip some if crowded)
    if (data.length <= 14 || i % Math.ceil(data.length / 12) === 0) {
      svg.appendChild(text(cx, H - 12, d.label, 'axis mid'));
    }
  });

  // optional dashed reference line (e.g. the $350 goal)
  if (opts.refLine) {
    const ry = padT + plotH - (Math.min(opts.refLine.value, niceMax) / niceMax) * plotH;
    svg.appendChild(el('line', {
      x1: padL, y1: ry, x2: W - padR, y2: ry, class: 'refline',
      stroke: opts.refLine.color || 'var(--accent)', 'stroke-dasharray': '5 4', 'stroke-width': 1.5,
    }));
    if (opts.refLine.label) {
      const t = text(W - padR, ry - 4, opts.refLine.label, 'axis');
      t.setAttribute('text-anchor', 'end');
      t.setAttribute('fill', opts.refLine.color || 'var(--accent)');
      svg.appendChild(t);
    }
  }

  container.appendChild(svg);
}

// ---- Line chart (multiple series) ----
// data: [{label, values:{key:number}}], series:[{key,label,color}]
export function lineChart(container, data, series, opts = {}) {
  container.innerHTML = '';
  if (!data.length) return emptyState(container, opts.empty || 'No data yet');

  const W = opts.width || container.clientWidth || 320;
  const H = opts.height || 200;
  const padL = 44, padR = 12, padT = 12, padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  let max = 0;
  for (const d of data) for (const s of series) max = Math.max(max, d.values[s.key] || 0);
  const niceMax = niceCeil(Math.max(1, max));

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });

  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const y = padT + plotH - (plotH * i) / ticks;
    const val = (niceMax * i) / ticks;
    svg.appendChild(el('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid' }));
    svg.appendChild(text(4, y + 3, opts.moneyAxis === false ? String(Math.round(val)) : money(val), 'axis'));
  }

  const xFor = (i) => data.length === 1 ? padL + plotW / 2 : padL + (plotW * i) / (data.length - 1);
  const yFor = (v) => padT + plotH - (v / niceMax) * plotH;

  series.forEach((s) => {
    const pts = data.map((d, i) => `${xFor(i)},${yFor(d.values[s.key] || 0)}`);
    if (opts.area) {
      const area = `${padL},${padT + plotH} ` + pts.join(' ') + ` ${xFor(data.length - 1)},${padT + plotH}`;
      svg.appendChild(el('polygon', { points: area, fill: s.color, 'fill-opacity': 0.12, stroke: 'none' }));
    }
    svg.appendChild(el('polyline', { points: pts.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    data.forEach((d, i) => {
      const c = el('circle', { cx: xFor(i), cy: yFor(d.values[s.key] || 0), r: 3, fill: s.color, class: 'dot' });
      c.appendChild(el('title', {}, [document.createTextNode(`${d.label} · ${s.label}: ${opts.moneyAxis === false ? (d.values[s.key] || 0) : money(d.values[s.key] || 0)}`)]));
      svg.appendChild(c);
    });
  });

  data.forEach((d, i) => {
    if (data.length <= 14 || i % Math.ceil(data.length / 12) === 0) {
      svg.appendChild(text(xFor(i), H - 12, d.label, 'axis mid'));
    }
  });

  container.appendChild(svg);
}

// ---- Donut (category breakdown) ----
// slices: [{label, value, color}]
export function donutChart(container, slices, opts = {}) {
  container.innerHTML = '';
  const filtered = slices.filter((s) => s.value > 0);
  if (!filtered.length) return emptyState(container, opts.empty || 'No data yet');

  const size = opts.size || 180;
  const r = size / 2;
  const inner = r * 0.6;
  const total = filtered.reduce((a, s) => a + s.value, 0);
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, class: 'chart donut' });

  let angle = -Math.PI / 2;
  for (const s of filtered) {
    const frac = s.value / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = r + r * Math.cos(angle), y1 = r + r * Math.sin(angle);
    const x2 = r + r * Math.cos(a2), y2 = r + r * Math.sin(a2);
    const xi2 = r + inner * Math.cos(a2), yi2 = r + inner * Math.sin(a2);
    const xi1 = r + inner * Math.cos(angle), yi1 = r + inner * Math.sin(angle);
    const path = el('path', {
      d: `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${inner} ${inner} 0 ${large} 0 ${xi1} ${yi1} Z`,
      fill: s.color, class: 'slice',
    });
    path.appendChild(el('title', {}, [document.createTextNode(`${s.label}: ${money(s.value)} (${Math.round(frac * 100)}%)`)]));
    svg.appendChild(path);
    angle = a2;
  }
  const center = el('text', { x: r, y: r, class: 'donut-center', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
  center.textContent = money(total);
  svg.appendChild(center);
  container.appendChild(svg);
}

function text(x, y, str, cls) {
  const t = el('text', { x, y, class: cls || '' });
  t.textContent = str;
  if (cls && cls.includes('mid')) t.setAttribute('text-anchor', 'middle');
  return t;
}

function niceCeil(n) {
  if (n <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const norm = n / mag;
  let step;
  if (norm <= 1) step = 1; else if (norm <= 2) step = 2; else if (norm <= 5) step = 5; else step = 10;
  return step * mag;
}

export function legend(container, series) {
  container.innerHTML = series.map((s) =>
    `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.label}</span>`
  ).join('');
}
