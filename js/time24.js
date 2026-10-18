// time24.js — 24-hour time fields everywhere.
// Native <input type="time"> follows the phone's region, so a US iPhone shows
// "5:00 PM". These are plain text fields (class "t24") with the numeric
// keypad that always hold "HH:MM" in 24-hour time:
//   type 1730 → 17:30 · 930 → 09:30 · 9 → 09:00 · ↑/↓ = ±15 min
// Half-typed values ("17:3") are kept from the app's own input listeners, so
// the forms only ever see "" or a complete time — same as the native input.
// A time that can't be read (e.g. 25:00) reverts to what was there before.

export const T24_ATTRS = 'type="text" inputmode="numeric" class="t24" maxlength="5" placeholder="--:--" autocomplete="off" spellcheck="false" enterkeyhint="done"';

const VALID = /^([01]\d|2[0-3]):[0-5]\d$/;
const isT24 = (el) => el && el.classList && el.classList.contains('t24');
const pad = (n) => String(n).padStart(2, '0');

// While typing: digits only, colon added after the hour. A first digit of 3–9
// (or 24–29) can only be a one-digit hour, so it becomes 0X.
export function shapeTime(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (/^[3-9]/.test(d) || /^2[4-9]/.test(d)) d = '0' + d;
  d = d.slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}:${d.slice(2)}` : d;
}

// On leaving the field: complete it ("9" → 09:00, "17:3" → 17:30), or null if
// it isn't a real time.
export function finishTime(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const d = shapeTime(s).replace(':', '');
  const hh = d.slice(0, 2).padStart(2, '0');
  const mm = (d.slice(2) + '00').slice(0, 2);
  const out = `${hh}:${mm}`;
  return VALID.test(out) ? out : null;
}

function stepTime(v, minutes) {
  const t = VALID.test(v) ? v : '00:00';
  const m = ((+t.slice(0, 2) * 60 + +t.slice(3) + minutes) % 1440 + 1440) % 1440;
  const snapped = Math.round(m / 15) * 15 % 1440;
  return `${pad(Math.floor(snapped / 60))}:${pad(snapped % 60)}`;
}

let installed = false;
export function initTime24(root = document) {
  if (installed) return;
  installed = true;

  root.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!isT24(el)) return;
    el.dataset.prev = el.value;
    // Tap → type straight over the old time.
    // (Skipped if typing already began, so a fast first keystroke isn't lost.)
    setTimeout(() => { if (el.value === el.dataset.prev) { try { el.select(); } catch { /* ignore */ } } }, 0);
  });

  // Capture phase: runs before the app's own listeners on the field.
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (!isT24(el) || e.t24) return;
    el.classList.remove('t24-bad');
    const shaped = shapeTime(el.value);
    if (shaped !== el.value) el.value = shaped;
    if (shaped && !VALID.test(shaped)) e.stopImmediatePropagation();
  }, true);

  root.addEventListener('change', (e) => {
    const el = e.target;
    if (!isT24(el) || e.t24) return;
    const done = finishTime(el.value);
    if (done === null) {
      e.stopImmediatePropagation();
      el.value = el.dataset.prev || '';
      el.classList.add('t24-bad');
      setTimeout(() => el.classList.remove('t24-bad'), 1600);
    } else if (done !== el.value) {
      el.value = done;
      // The app missed the half-typed value — let its input listeners catch up.
      const ev = new Event('input', { bubbles: true });
      ev.t24 = true;
      el.dispatchEvent(ev);
    }
    el.dataset.prev = el.value;
  }, true);

  root.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!isT24(el)) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      el.value = stepTime(finishTime(el.value) || el.dataset.prev || '', e.key === 'ArrowUp' ? 15 : -15);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (e.key === 'Enter' && !el.form) {
      el.blur();
    }
  });

  // Arrow-key steps don't make the browser fire "change" on blur — do it, so
  // fields that save on change (the planning desk) keep the new time.
  root.addEventListener('focusout', (e) => {
    const el = e.target;
    if (!isT24(el) || el.value === (el.dataset.prev ?? el.value)) return;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
