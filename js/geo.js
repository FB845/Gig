// geo.js — GPS auto-mileage tracking. A foreground live odometer that turns
// raw geolocation fixes into a jitter-filtered distance in miles, plus a
// timestamped trip record for IRS-friendly contemporaneous mileage logs.
//
// Note: iOS/Android PWAs only get location while the app is in the foreground
// (screen on). This is a "drive mode" tracker, not true background tracking —
// it's honest about that in the UI.

const EARTH_MI = 3958.7613; // mean earth radius in miles

export function haversineMiles(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Pure, testable distance accumulator. Filters GPS jitter:
//  - drops fixes with poor accuracy (> maxAccuracy meters)
//  - ignores micro-moves below minSegMi (standing still noise)
//  - rejects single-step teleports over maxJumpMi (GPS glitch / tunnel exit)
//
// The glitch guard is distance-per-fix, not speed, on purpose: consumer GPS
// often emits fixes with near-identical timestamps, which would make a normal
// move look like an impossible speed and get wrongly dropped. At ~1 Hz
// sampling even highway speed is well under a mile between fixes, so any single
// step over ~2 miles is a glitch regardless of timing.
export function accumulate(points, opts = {}) {
  const maxAccuracy = opts.maxAccuracy ?? 50;   // meters
  const minSegMi = opts.minSegMi ?? 0.006;      // ~10 meters
  const maxJumpMi = opts.maxJumpMi ?? 2;        // > this in one step = glitch
  let miles = 0;
  let prev = null;
  const kept = [];
  for (const p of points) {
    if (p.accuracy != null && p.accuracy > maxAccuracy) continue;
    if (!prev) { prev = p; kept.push(p); continue; }
    const seg = haversineMiles(prev, p);
    if (seg < minSegMi) continue;          // stationary jitter
    if (seg > maxJumpMi) { prev = p; continue; } // GPS teleport glitch
    miles += seg;
    prev = p;
    kept.push(p);
  }
  return { miles: Math.round(miles * 100) / 100, kept };
}

export class DriveTracker {
  constructor(opts = {}) {
    this.opts = opts;
    this.points = [];
    this.watchId = null;
    this.startedAt = null;
    this._onUpdate = null;
  }

  get miles() { return accumulate(this.points, this.opts).miles; }
  get elapsedMs() { return this.startedAt ? Date.now() - this.startedAt : 0; }

  // onUpdate({miles, elapsedMs, accuracy})
  start(onUpdate) {
    if (!('geolocation' in navigator)) {
      return Promise.reject(new Error('This device/browser has no GPS access.'));
    }
    this._onUpdate = onUpdate;
    this.points = [];
    this.startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let resolved = false;
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          this._push(pos);
          if (!resolved) { resolved = true; resolve(); }
        },
        (err) => {
          if (!resolved) { resolved = true; reject(mapGeoError(err)); }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
      );
    });
  }

  // Manually feed a fix (used by tests / external sources).
  ingest(lat, lon, accuracy, t) {
    this._push({ coords: { latitude: lat, longitude: lon, accuracy }, timestamp: t ?? Date.now() });
  }

  _push(pos) {
    this.points.push({
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      t: pos.timestamp || Date.now(),
    });
    if (this._onUpdate) {
      this._onUpdate({ miles: this.miles, elapsedMs: this.elapsedMs, accuracy: pos.coords.accuracy });
    }
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    const endedAt = Date.now();
    const { miles, kept } = accumulate(this.points, this.opts);
    return {
      miles,
      startedAt: this.startedAt,
      endedAt,
      durationMs: this.startedAt ? endedAt - this.startedAt : 0,
      fixes: kept.length,
    };
  }
}

function mapGeoError(err) {
  if (err && err.code === 1) return new Error('Location permission denied. Enable it in your browser/phone settings to auto-track miles.');
  if (err && err.code === 2) return new Error('Location unavailable right now. Make sure GPS is on.');
  if (err && err.code === 3) return new Error('Timed out getting your location. Try again with a clear sky view.');
  return new Error((err && err.message) || 'Could not access GPS.');
}
