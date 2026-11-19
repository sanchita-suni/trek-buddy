// Trek Buddy Radar: pure logic shared by the browser app and the Node tests.
// No DOM or browser APIs in this file, so `node --test` can import it directly.

export const SERVICE_UUID   = '6e400001-b5a3-f393-e0a9-e50e24dc7e01';
export const POSITIONS_UUID = '6e400002-b5a3-f393-e0a9-e50e24dc7e01';
export const SOS_UUID       = '6e400003-b5a3-f393-e0a9-e50e24dc7e01';
export const DEVICE_PREFIX  = 'TrekBuddy';

export const PACKET_LEN = 18;
export const MAX_TTL = 3;
export const TYPE = Object.freeze({ LOCATION: 0, SOS: 1, ACK: 2 });
export const FLAG = Object.freeze({ SOS: 0x01, FALL: 0x02, LOW_BATTERY: 0x04, NO_FIX: 0x08 });

export const STALE_AFTER_MS = 90_000;
export const TRAIL_LEN = 20;
// Relayed copies arrive within seconds; a 2 min window catches them without
// mistaking a rebooted pendant (seq restarts at 0) for duplicates for long.
export const DEDUPE_WINDOW_MS = 120_000;

/* ------------------------------------------------------------------ packets */

function asDataView(input) {
  if (input instanceof DataView) return input;
  if (input instanceof ArrayBuffer) return new DataView(input);
  if (ArrayBuffer.isView(input)) return new DataView(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

export function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0);
}

/**
 * Parse one 18-byte BLE notification (little-endian, packed).
 * Returns null when the payload has the wrong size.
 * lat/lon are null when the NO_FIX flag is set or the values are out of range.
 */
export function parsePacket(input) {
  const dv = asDataView(input);
  if (!dv || dv.byteLength !== PACKET_LEN) return null;

  const ttl = dv.getUint8(5);
  const flags = dv.getUint8(15);
  const lat = dv.getInt32(6, true) / 1e6;
  const lon = dv.getInt32(10, true) / 1e6;
  const rssi = dv.getInt8(16);
  const noFix = (flags & FLAG.NO_FIX) !== 0;
  const hasPos = !noFix && isValidLatLon(lat, lon);

  return {
    group: dv.getUint8(0),
    src: dv.getUint8(1),
    seq: dv.getUint16(2, true),
    type: dv.getUint8(4),
    ttl,
    hops: Math.max(0, MAX_TTL - ttl),
    lat: hasPos ? lat : null,
    lon: hasPos ? lon : null,
    battery: dv.getUint8(14),
    flags,
    sos: (flags & FLAG.SOS) !== 0,
    fall: (flags & FLAG.FALL) !== 0,
    lowBattery: (flags & FLAG.LOW_BATTERY) !== 0,
    noFix,
    rssi,
    snr: dv.getInt8(17) / 4,
    own: rssi === 0,
  };
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Build an 18-byte packet (used by demo mode and tests). */
export function encodePacket(f) {
  const buf = new ArrayBuffer(PACKET_LEN);
  const dv = new DataView(buf);
  dv.setUint8(0, f.group ?? 1);
  dv.setUint8(1, f.src);
  dv.setUint16(2, (f.seq ?? 0) & 0xffff, true);
  dv.setUint8(4, f.type ?? TYPE.LOCATION);
  dv.setUint8(5, f.ttl ?? MAX_TTL);
  dv.setInt32(6, Math.round((f.lat ?? 0) * 1e6), true);
  dv.setInt32(10, Math.round((f.lon ?? 0) * 1e6), true);
  dv.setUint8(14, clampInt(f.battery ?? 100, 0, 255));
  dv.setUint8(15, f.flags ?? 0);
  dv.setInt8(16, clampInt(f.rssi ?? 0, -128, 127));
  dv.setInt8(17, clampInt((f.snr ?? 0) * 4, -128, 127));
  return new Uint8Array(buf);
}

/* ------------------------------------------------------------------- dedupe */

export class Deduper {
  constructor(windowMs = DEDUPE_WINDOW_MS) {
    this.windowMs = windowMs;
    this.seen = new Map(); // key -> time first seen (insertion order == time order)
  }
  isDuplicate(src, seq, now = Date.now()) {
    for (const [k, t] of this.seen) {
      if (now - t > this.windowMs) this.seen.delete(k); else break;
    }
    const key = src * 65536 + (seq & 0xffff);
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    return false;
  }
  get size() { return this.seen.size; }
}

/** True when `seq` is older than `last` in uint16 serial-number arithmetic. */
export function seqIsOlder(seq, last) {
  const d = (last - seq) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/* ---------------------------------------------------------------- geometry */

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversine(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing from point 1 to point 2, degrees clockwise from true north [0, 360). */
export function initialBearing(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

export const normalizeDeg = (d) => ((d % 360) + 360) % 360;

/** Signed shortest difference a - b, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = normalizeDeg(a - b);
  if (d > 180) d -= 360;
  return d;
}

/** Low-pass filter for angles that handles the 359 -> 0 wrap. */
export function smoothAngle(prev, next, k) {
  return normalizeDeg(prev + k * angleDiff(next, prev));
}

/** Compass heading from a deviceorientationabsolute alpha, corrected for screen rotation. */
export function headingFromAlpha(alpha, screenAngle = 0) {
  return normalizeDeg(360 - alpha + screenAngle);
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassText(deg) {
  return POINTS[Math.round(normalizeDeg(deg) / 45) % 8];
}

const RANGE_STEPS = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500,
  10_000, 15_000, 20_000, 30_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];
/** Radar outer-ring distance so the farthest trekker fits with ~15% margin. */
export function niceRange(maxDist) {
  const need = Math.max(0, maxDist) * 1.15;
  for (const s of RANGE_STEPS) if (s >= need) return s;
  return Math.ceil(need / 1_000_000) * 1_000_000;
}

/* -------------------------------------------------------------- formatting */

export function formatDistance(m) {
  if (!Number.isFinite(m)) return '—';
  if (Math.round(m) < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function formatAgo(ms) {
  if (!Number.isFinite(ms)) return 'never';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function formatHops(h) {
  if (h == null) return '—';
  if (h === 0) return 'Direct';
  return h === 1 ? '1 hop' : `${h} hops`;
}

export const formatLatLon = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

/** geo: URI that Organic Maps (and other Android map apps) open as a pin. */
export function geoUri(lat, lon, label) {
  const ll = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return `geo:${ll}?q=${ll}(${encodeURIComponent(label)})`;
}

/** 0-4 signal bars from LoRa RSSI (dBm). RSSI 0 is our own pendant: full bars. */
export function rssiBars(rssi) {
  if (rssi == null) return 0;
  if (rssi === 0 || rssi >= -90) return 4;
  if (rssi >= -100) return 3;
  if (rssi >= -110) return 2;
  if (rssi >= -120) return 1;
  return 0;
}

export const trekkerName = (src) => `Trekker ${src}`;

export const isStale = (t, now = Date.now()) => t.lastSeen == null || now - t.lastSeen > STALE_AFTER_MS;

/* ------------------------------------------------------------------- store */

function blankTrekker(src) {
  return {
    src, name: trekkerName(src), group: null, seq: null, type: null,
    lat: null, lon: null, fixAt: null, lastSeen: null,
    battery: null, flags: 0, sos: false, fall: false, lowBattery: false, noFix: false,
    hops: null, rssi: null, snr: null,
    sosEpisode: 0, sosSince: null,
    trail: [],
  };
}

// A breadcrumb is skipped only if the trekker hasn't moved and the last one is recent
// (SOS packets every 5 s would otherwise fill the 20 slots in under 2 minutes).
const CRUMB_MIN_MOVE_M = 5;
const CRUMB_MIN_GAP_MS = 25_000;
// An out-of-order packet older than this many seqs is treated as a pendant reboot.
const OLD_SEQ_TOLERANCE = 64;
const OLD_SEQ_MAX_AGE_MS = 60_000;

export class TrekkerStore {
  constructor({ dedupeWindowMs = DEDUPE_WINDOW_MS } = {}) {
    this.deduper = new Deduper(dedupeWindowMs);
    this.trekkers = new Map(); // src -> trekker (everyone except my own pendant)
    this.own = null;           // my own pendant (packets with RSSI == 0)
    this.stats = { received: 0, accepted: 0, duplicates: 0, outOfOrder: 0, ignored: 0, invalid: 0 };
  }

  /**
   * Feed one parsed packet. Returns { status: 'ok' | 'duplicate' | 'old' | 'ignored' | 'invalid', ... }.
   * On 'ok': { own, trekker, sosStarted, sosCleared }.
   */
  ingest(pkt, now = Date.now()) {
    this.stats.received++;
    if (!pkt) { this.stats.invalid++; return { status: 'invalid' }; }
    if (pkt.type === TYPE.ACK) { this.stats.ignored++; return { status: 'ignored' }; }
    if (this.deduper.isDuplicate(pkt.src, pkt.seq, now)) { this.stats.duplicates++; return { status: 'duplicate' }; }

    const isOwn = pkt.own || (this.own !== null && pkt.src === this.own.src);
    let t;
    if (isOwn) {
      if (this.own && this.own.src !== pkt.src) this.own = null; // phone switched to another pendant
      this.trekkers.delete(pkt.src);
      t = this.own ??= blankTrekker(pkt.src);
    } else {
      t = this.trekkers.get(pkt.src);
      if (!t) { t = blankTrekker(pkt.src); this.trekkers.set(pkt.src, t); }
    }

    // A late relayed copy of an older packet must not overwrite newer state
    // (e.g. re-raise an SOS that was just cancelled).
    if (t.seq !== null && t.lastSeen !== null && now - t.lastSeen < OLD_SEQ_MAX_AGE_MS &&
        seqIsOlder(pkt.seq, t.seq) && ((t.seq - pkt.seq) & 0xffff) <= OLD_SEQ_TOLERANCE) {
      this.stats.outOfOrder++;
      return { status: 'old', own: isOwn, trekker: t };
    }

    const wasSos = t.sos;
    t.group = pkt.group;
    t.seq = pkt.seq;
    t.type = pkt.type;
    t.lastSeen = now;
    t.battery = pkt.battery;
    t.flags = pkt.flags;
    t.sos = pkt.sos;
    t.fall = pkt.fall;
    t.lowBattery = pkt.lowBattery;
    t.noFix = pkt.noFix;
    t.hops = pkt.hops;
    t.rssi = pkt.rssi;
    t.snr = pkt.snr;
    if (pkt.lat !== null) {
      t.lat = pkt.lat;
      t.lon = pkt.lon;
      t.fixAt = now;
      addCrumb(t, now);
    }
    if (t.sos && !wasSos) { t.sosEpisode++; t.sosSince = now; }
    if (!t.sos) t.sosSince = null;

    this.stats.accepted++;
    return { status: 'ok', own: isOwn, trekker: t, sosStarted: !wasSos && t.sos, sosCleared: wasSos && !t.sos };
  }

  activeSos() { return [...this.trekkers.values()].filter((t) => t.sos); }

  clear() { this.trekkers.clear(); this.own = null; }

  /** Serializable last-known positions (no SOS state, no seq). */
  snapshot() {
    const pick = (t) => ({
      src: t.src, lat: t.lat, lon: t.lon, fixAt: t.fixAt, lastSeen: t.lastSeen,
      battery: t.battery, hops: t.hops, rssi: t.rssi, noFix: t.noFix, lowBattery: t.lowBattery,
      trail: t.trail,
    });
    return { v: 1, own: this.own && pick(this.own), trekkers: [...this.trekkers.values()].map(pick) };
  }

  restore(data) {
    if (!data || data.v !== 1) return false;
    const num = (v) => (Number.isFinite(v) ? v : null);
    const revive = (o) => {
      if (!o || !Number.isInteger(o.src) || o.src < 0 || o.src > 255) return null;
      const t = blankTrekker(o.src);
      if (isValidLatLon(o.lat, o.lon)) { t.lat = o.lat; t.lon = o.lon; t.fixAt = num(o.fixAt); }
      t.lastSeen = num(o.lastSeen);
      t.battery = num(o.battery);
      t.hops = num(o.hops);
      t.rssi = num(o.rssi);
      t.noFix = o.noFix === true;
      t.lowBattery = o.lowBattery === true;
      if (Array.isArray(o.trail)) {
        t.trail = o.trail
          .filter((c) => c && Number.isFinite(c.t) && isValidLatLon(c.lat, c.lon))
          .map((c) => ({ t: c.t, lat: c.lat, lon: c.lon }))
          .slice(-TRAIL_LEN);
      }
      return t;
    };
    this.own = revive(data.own);
    this.trekkers.clear();
    for (const o of Array.isArray(data.trekkers) ? data.trekkers : []) {
      const t = revive(o);
      if (t && (!this.own || t.src !== this.own.src)) this.trekkers.set(t.src, t);
    }
    return true;
  }
}

function addCrumb(t, now) {
  const last = t.trail[t.trail.length - 1];
  if (last && now - last.t < CRUMB_MIN_GAP_MS &&
      haversine(last.lat, last.lon, t.lat, t.lon) < CRUMB_MIN_MOVE_M) return;
  t.trail.push({ t: now, lat: t.lat, lon: t.lon });
  if (t.trail.length > TRAIL_LEN) t.trail.splice(0, t.trail.length - TRAIL_LEN);
}
