// Trek Buddy Radar: browser app (Web Bluetooth, compass, radar, cards, SOS).
import {
  SERVICE_UUID, POSITIONS_UUID, SOS_UUID, DEVICE_PREFIX,
  parsePacket, TrekkerStore, isStale,
  haversine, initialBearing, compassText, niceRange, normalizeDeg, smoothAngle, headingFromAlpha,
  formatDistance, formatAgo, formatHops, formatLatLon, geoUri, rssiBars,
} from './core.js';
import { startDemo } from './demo.js';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const DEMO_SPEED = Math.min(20, Math.max(0.25, Number(params.get('speed')) || 1));

const STORAGE_KEY = 'trekbuddy-radar:last-known:v1';
const POS_MAX_AGE_MS = 120_000;   // a fix older than this is "last known", not live
const HOLD_MS = 2000;             // press-and-hold time for my SOS
const COMPASS_WAIT_MS = 3000;     // no orientation event by then -> north-up
const PHONE_GPS_AFTER_MS = 40_000; // connected this long without a pendant fix -> phone GPS
const PHONE_FIX_LIVE_MS = 15_000;  // phone fix newer than this beats the pendant's 30 s fix

const $ = (id) => document.getElementById(id);
const el = {
  connBtn: $('connect-btn'), connDot: $('conn-dot'), connText: $('conn-text'), meText: $('me-text'),
  banner: $('sos-banner'), canvas: $('radar'), hint: $('compass-hint'),
  cards: $('cards'), empty: $('empty'), stats: $('stats'),
  clearBtn: $('clear-btn'), demoLink: $('demo-link'),
  mySos: $('my-sos'), mySosLabel: $('my-sos-label'), toast: $('toast'), tpl: $('card-tpl'),
};

const store = new TrekkerStore();
const state = {
  conn: DEMO ? 'demo' : 'idle', // idle | connecting | connected | retrying | lost | demo
  device: null, posChar: null, sosChar: null, retried: false, userDisconnect: false,
  heading: null, compass: 'waiting', tilted: false, compassAsked: false, // compass: waiting | ok | none
  phoneFix: null, geoWatch: null, geoError: null, gpsTimer: null,
  mySos: false, lastOwnSosFlag: null, sosBusy: false, swallowClick: false,
  silenced: new Set(), nextBuzzAt: 0, buzzing: false,
  wakeLock: null, dirty: true, uiQueued: false, demo: null,
};
const cardViews = new Map();   // src -> { root, refs, bearing, trailKey }
const bannerRows = new Map();  // src -> { row, text, btn }

/* =============================================================== packets */

function handleBytes(dataView) {
  const res = store.ingest(parsePacket(dataView), Date.now());
  if (res.status === 'ok') {
    if (res.own) {
      const t = res.trekker;
      // Follow the pendant's own SOS flag on change only (the pendant button can raise SOS too).
      if (t.sos !== state.lastOwnSosFlag) { state.lastOwnSosFlag = t.sos; state.mySos = t.sos; }
      if (t.noFix) startPhoneGps();
    }
    if (res.sosStarted) state.nextBuzzAt = 0;
    if (res.sosCleared) forgetSilence(res.trekker.src);
  }
  scheduleUi();
}

/* ============================================================= bluetooth */

async function connect() {
  if (!navigator.bluetooth) {
    toast('Web Bluetooth is not available. Use Chrome on Android, over HTTPS or localhost.');
    return;
  }
  requestCompassPermission();
  startPhoneGps();
  setConn('connecting');
  try {
    if (!state.device) {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: DEVICE_PREFIX }],
        optionalServices: [SERVICE_UUID],
      });
      device.addEventListener('gattserverdisconnected', onDisconnected);
      state.device = device;
    }
    await openGatt();
  } catch (err) {
    if (err && err.name === 'NotFoundError') setConn(state.device ? 'lost' : 'idle'); // picker cancelled
    else { toast(`Connect failed: ${err?.message ?? err}`); setConn(state.device ? 'lost' : 'idle'); }
  }
}

async function openGatt() {
  const server = await state.device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const posChar = await service.getCharacteristic(POSITIONS_UUID);
  const sosChar = await service.getCharacteristic(SOS_UUID);
  if (state.posChar) state.posChar.removeEventListener('characteristicvaluechanged', onNotify);
  posChar.addEventListener('characteristicvaluechanged', onNotify);
  await posChar.startNotifications();
  state.posChar = posChar;
  state.sosChar = sosChar;
  state.retried = false;
  setConn('connected');
  requestWakeLock();
  clearTimeout(state.gpsTimer);
  state.gpsTimer = setTimeout(() => {
    if (!store.own || store.own.lat == null || store.own.noFix) startPhoneGps();
  }, PHONE_GPS_AFTER_MS);
}

function onNotify(event) { handleBytes(event.target.value); }

function onDisconnected() {
  state.sosChar = null;
  if (state.userDisconnect) {
    state.userDisconnect = false;
    state.device?.removeEventListener('gattserverdisconnected', onDisconnected);
    state.device = null;
    state.posChar = null;
    releaseWakeLock();
    setConn('idle');
    return;
  }
  if (!state.retried) {
    state.retried = true;
    setConn('retrying');
    setTimeout(async () => {
      try { await openGatt(); }
      catch { releaseWakeLock(); setConn('lost'); }
    }, 1500);
  } else {
    releaseWakeLock();
    setConn('lost');
  }
}

async function reconnect() {
  setConn('connecting');
  try { await openGatt(); }
  catch (err) { toast(`Reconnect failed: ${err?.message ?? err}`); setConn('lost'); }
}

function disconnect() {
  state.userDisconnect = true;
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
  else onDisconnected();
}

function setConn(s) {
  state.conn = s;
  renderAll();
}

el.connBtn.addEventListener('click', () => {
  switch (state.conn) {
    case 'idle': connect(); break;
    case 'lost': reconnect(); break;
    case 'connected': disconnect(); break;
    case 'demo': location.href = location.pathname; break;
    default: break;
  }
});

/* ================================================================ my SOS */

async function sendMySos(on) {
  state.sosBusy = true;
  renderMySos();
  try {
    if (DEMO) {
      state.demo.setOwnSos(on);
    } else {
      if (!state.sosChar) throw new Error('pendant not connected');
      const value = Uint8Array.of(on ? 0x01 : 0x00);
      if (state.sosChar.writeValueWithResponse) await state.sosChar.writeValueWithResponse(value);
      else await state.sosChar.writeValue(value);
    }
    state.mySos = on;
    toast(on ? 'SOS sent to all trekkers' : 'SOS cancelled');
    vibrate(on ? [300] : [80]);
  } catch (err) {
    toast(`Could not ${on ? 'send' : 'cancel'} SOS: ${err?.message ?? err}`);
  } finally {
    state.sosBusy = false;
    renderMySos();
  }
}

let hold = null;
function endHold() {
  if (!hold) return;
  cancelAnimationFrame(hold.raf);
  hold = null;
  el.mySos.classList.remove('holding');
  el.mySos.style.setProperty('--p', 0);
  renderMySos();
}
el.mySos.addEventListener('pointerdown', (e) => {
  state.swallowClick = false; // a fresh press: the hold's own release-click never came
  if (el.mySos.disabled || state.mySos || hold) return;
  e.preventDefault();
  try { el.mySos.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  hold = { start: performance.now(), raf: 0 };
  el.mySos.classList.add('holding');
  el.mySosLabel.textContent = 'Keep holding…';
  const step = () => {
    if (!hold) return;
    const p = Math.min(1, (performance.now() - hold.start) / HOLD_MS);
    el.mySos.style.setProperty('--p', p);
    if (p >= 1) {
      endHold();
      state.swallowClick = true; // releasing the hold fires a click: don't treat it as "cancel"
      sendMySos(true);
    } else {
      hold.raf = requestAnimationFrame(step);
    }
  };
  hold.raf = requestAnimationFrame(step);
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.mySos.addEventListener(ev, endHold);
el.mySos.addEventListener('contextmenu', (e) => e.preventDefault());
el.mySos.addEventListener('click', () => {
  if (state.swallowClick) { state.swallowClick = false; return; }
  if (el.mySos.disabled || !state.mySos) return;
  if (confirm('Cancel your SOS? Other trekkers will stop being alerted.')) sendMySos(false);
});

/* ======================================================= other SOS alarms */

const sosKey = (t) => `${t.src}:${t.sosEpisode}`;

function silence(src) {
  const t = store.trekkers.get(src);
  if (!t || !t.sos) return;
  state.silenced.add(sosKey(t));
  updateBuzz();
  renderAll();
}

function forgetSilence(src) {
  for (const k of state.silenced) if (k.startsWith(`${src}:`)) state.silenced.delete(k);
}

function vibrate(pattern) {
  // Chrome ignores vibrate() until the user has interacted with the page.
  if (!('vibrate' in navigator)) return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  navigator.vibrate(pattern);
}

function updateBuzz(now = Date.now()) {
  const loud = store.activeSos().some((t) => !state.silenced.has(sosKey(t)));
  if (loud) {
    if (now >= state.nextBuzzAt) {
      vibrate([600, 200, 600, 200, 600]);
      state.nextBuzzAt = now + 3500;
      state.buzzing = true;
    }
  } else if (state.buzzing) {
    vibrate(0);
    state.buzzing = false;
    state.nextBuzzAt = 0;
  }
}

/* =========================================================== my position */

function startPhoneGps() {
  if (DEMO || state.geoWatch != null || !('geolocation' in navigator)) return;
  state.geoWatch = navigator.geolocation.watchPosition(
    (p) => {
      state.phoneFix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
      state.geoError = null;
      scheduleUi();
    },
    (err) => { state.geoError = err.message || 'unavailable'; scheduleUi(); },
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 60_000 },
  );
}

/**
 * My position: the phone's GPS while it is updating (about 1 Hz, so walking toward
 * someone feels live), else the pendant's GPS (every 30 s), else the last known of either.
 */
function myPosition(now) {
  const o = store.own;
  const p = state.phoneFix;
  if (p && now - p.at < PHONE_FIX_LIVE_MS) return { lat: p.lat, lon: p.lon, source: 'phone', acc: p.acc };
  if (o && o.lat != null && !o.noFix && now - o.fixAt < POS_MAX_AGE_MS) return { lat: o.lat, lon: o.lon, source: 'pendant' };
  if (p && now - p.at < POS_MAX_AGE_MS) return { lat: p.lat, lon: p.lon, source: 'phone', acc: p.acc };
  const candidates = [];
  if (o && o.lat != null) candidates.push({ lat: o.lat, lon: o.lon, source: 'pendant-old', at: o.fixAt });
  if (p) candidates.push({ lat: p.lat, lon: p.lon, source: 'phone-old', at: p.at });
  candidates.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return candidates[0] ?? null;
}

function relation(t, me) {
  if (!me || t.lat == null) return null;
  return { dist: haversine(me.lat, me.lon, t.lat, t.lon), bearing: initialBearing(me.lat, me.lon, t.lat, t.lon) };
}

/* =============================================================== compass */

const needsOrientationPermission =
  typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';

function screenAngle() {
  return (screen.orientation && screen.orientation.angle) || window.orientation || 0;
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (e.alpha != null && (e.type === 'deviceorientationabsolute' || e.absolute)) h = headingFromAlpha(e.alpha, screenAngle());
  if (h == null) return;
  state.heading = state.heading == null ? h : smoothAngle(state.heading, h, 0.3);
  state.tilted = Math.abs(e.beta ?? 0) > 35 || Math.abs(e.gamma ?? 0) > 35;
  if (state.compass !== 'ok') { state.compass = 'ok'; scheduleUi(); }
  state.dirty = true;
}

function initCompass() {
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrientation);
  else if ('ondeviceorientation' in window) window.addEventListener('deviceorientation', onOrientation);
  setTimeout(() => {
    if (state.compass === 'waiting') { state.compass = 'none'; scheduleUi(); }
  }, COMPASS_WAIT_MS);
}

async function requestCompassPermission() {
  if (!needsOrientationPermission || state.compassAsked) return;
  state.compassAsked = true;
  try { await DeviceOrientationEvent.requestPermission(); } catch { /* user said no */ }
  if (state.compass !== 'ok') {
    state.compass = 'waiting';
    scheduleUi();
    setTimeout(() => {
      if (state.compass === 'waiting') { state.compass = 'none'; scheduleUi(); }
    }, COMPASS_WAIT_MS);
  }
}

const viewHeading = () => (state.compass === 'ok' && state.heading != null ? state.heading : 0);

el.hint.addEventListener('click', requestCompassPermission);

/* ================================================================= radar */

const COLORS = {
  disc: '#03120b', ring: '#1f6b47', ringOuter: '#3dff9a', tick: '#7fe8b5', label: '#ffffff', minor: '#9fb8aa',
  north: '#ff5a3c', ringLabel: '#c4f7dc', me: '#ffffff', other: '#4fd1ff', stale: '#8a9690', sos: '#ff3b3b',
};

function haloText(ctx, text, x, y, color) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawRadar(now, me) {
  const cv = el.canvas;
  const S = cv.clientWidth;
  if (!S) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.round(S * dpr);
  if (cv.width !== px || cv.height !== px) { cv.width = px; cv.height = px; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);

  const c = S / 2;
  const R = c - 34;
  const heading = viewHeading();
  const rad = (d) => (d * Math.PI) / 180;
  const polar = (deg, r) => [c + r * Math.sin(rad(deg)), c - r * Math.cos(rad(deg))];

  const targets = [];
  if (me) {
    for (const t of store.trekkers.values()) {
      const rel = relation(t, me);
      if (rel) targets.push({ t, ...rel, stale: isStale(t, now) });
    }
  }
  const range = niceRange(targets.reduce((m, x) => Math.max(m, x.dist), 0));

  // Disc and range rings
  ctx.beginPath();
  ctx.arc(c, c, R, 0, 2 * Math.PI);
  ctx.fillStyle = COLORS.disc;
  ctx.fill();
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(c, c, (R * i) / 4, 0, 2 * Math.PI);
    ctx.strokeStyle = i === 4 ? COLORS.ringOuter : COLORS.ring;
    ctx.lineWidth = i === 4 ? 2.5 : 1.5;
    ctx.stroke();
  }

  // "Ahead" line when the compass is live
  if (state.compass === 'ok') {
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c, c - R);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // Rose ticks (rotate with heading)
  for (let deg = 0; deg < 360; deg += 10) {
    const len = deg % 90 === 0 ? 16 : deg % 30 === 0 ? 11 : 6;
    const [x1, y1] = polar(deg - heading, R);
    const [x2, y2] = polar(deg - heading, R - len);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = deg === 0 ? COLORS.north : COLORS.tick;
    ctx.lineWidth = deg % 90 === 0 ? 3 : 1.5;
    ctx.stroke();
  }

  // Cardinal letters (positions rotate, text stays upright)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [lbl, deg] of [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]]) {
    const major = lbl.length === 1;
    const [x, y] = polar(deg - heading, R + 17);
    ctx.font = major ? '800 22px system-ui, sans-serif' : '700 13px system-ui, sans-serif';
    ctx.fillStyle = lbl === 'N' ? COLORS.north : major ? COLORS.label : COLORS.minor;
    ctx.fillText(lbl, x, y);
  }

  // Ring distance labels (screen-fixed, lower right)
  ctx.font = '700 13px system-ui, sans-serif';
  for (let i = 1; i <= 4; i++) {
    const [x, y] = polar(155, (R * i) / 4);
    haloText(ctx, formatDistance((range * i) / 4), x + 4, y, COLORS.ringLabel);
  }

  // Me (drawn before the trekkers so their labels stay readable when close)
  ctx.save();
  ctx.translate(c, c);
  ctx.fillStyle = COLORS.me;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (state.compass === 'ok') {
    ctx.moveTo(0, -14); ctx.lineTo(10, 10); ctx.lineTo(0, 5); ctx.lineTo(-10, 10); ctx.closePath();
  } else {
    ctx.arc(0, 0, 8, 0, 2 * Math.PI);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Trekkers: stale under fresh, SOS on top
  const phase = (now % 1200) / 1200;
  targets.sort((a, b) => (a.t.sos - b.t.sos) || (b.stale - a.stale));
  for (const x of targets) {
    const r = Math.min(x.dist / range, 1) * R;
    const [tx, ty] = polar(x.bearing - heading, r);
    const col = x.t.sos ? COLORS.sos : x.stale ? COLORS.stale : COLORS.other;
    if (x.t.sos) {
      ctx.beginPath();
      ctx.arc(tx, ty, 11 + 24 * phase, 0, 2 * Math.PI);
      ctx.strokeStyle = `rgba(255,59,59,${(1 - phase).toFixed(3)})`;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(tx, ty, x.t.sos ? 12 : 9, 0, 2 * Math.PI);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.font = '800 15px system-ui, sans-serif';
    const lx = Math.max(44, Math.min(S - 44, tx));
    // Label below the dot, unless that would land on the centre marker or off the bottom.
    const above = ty > S - 44 || (ty < c && c - ty < 50 && Math.abs(tx - c) < 60);
    const ly = ty + (above ? -24 : 24);
    haloText(ctx, x.t.name, lx, ly, x.t.sos ? '#ffd0d0' : x.stale ? COLORS.stale : '#ffffff');
  }

  if (!me) {
    ctx.font = '700 16px system-ui, sans-serif';
    haloText(ctx, 'Waiting for my position…', c, c + 34, COLORS.label);
  }
}

function updateArrows() {
  const heading = viewHeading();
  for (const v of cardViews.values()) {
    if (v.bearing == null) continue;
    v.refs.arrow.style.transform = `rotate(${normalizeDeg(v.bearing - heading).toFixed(1)}deg)`;
  }
}

function frame() {
  const now = Date.now();
  const pulsing = store.activeSos().length > 0;
  if (state.dirty || pulsing) {
    drawRadar(now, myPosition(now));
    updateArrows();
    state.dirty = false;
  }
  requestAnimationFrame(frame);
}

/* ================================================================= cards */

function ensureCard(src) {
  let v = cardViews.get(src);
  if (v) return v;
  const root = el.tpl.content.firstElementChild.cloneNode(true);
  const q = (s) => root.querySelector(s);
  const refs = {
    name: q('.name'), badges: q('.badges'), arrow: q('.arrow'), dist: q('.dist'), dir: q('.dir'),
    seen: q('.seen'), batt: q('.batt'), hops: q('.hops'), bars: q('.bars'), note: q('.note'),
    maps: q('.maps'), copy: q('.copy'), trailSummary: q('.trail summary'), trailList: q('.trail ol'),
  };
  refs.copy.addEventListener('click', () => copyCoords(src));
  v = { root, refs, bearing: null, trailKey: '' };
  cardViews.set(src, v);
  return v;
}

function badge(text, cls) {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

const timeFmt = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function updateCard(v, t, rel, stale, me, now) {
  const r = v.refs;
  v.root.classList.toggle('sos', t.sos);
  v.root.classList.toggle('stale', stale);
  v.root.dataset.src = t.src;
  r.name.textContent = t.name;

  const badges = [];
  if (t.sos) badges.push(badge('SOS', 'sos'));
  if (t.fall) badges.push(badge('FALL', 'sos'));
  if (stale) badges.push(badge('STALE', 'stale'));
  if (t.lowBattery) badges.push(badge('LOW BATT', 'warn'));
  if (t.noFix) badges.push(badge('NO GPS', 'warn'));
  r.badges.replaceChildren(...badges);

  if (rel) {
    r.dist.textContent = formatDistance(rel.dist);
    r.dir.textContent = `${compassText(rel.bearing)} · ${Math.round(rel.bearing)}°`;
    v.bearing = rel.bearing;
    r.arrow.style.visibility = 'visible';
  } else {
    r.dist.textContent = t.lat == null ? 'No position' : '—';
    r.dir.textContent = t.lat == null ? 'Waiting for their GPS' : 'Waiting for my position';
    v.bearing = null;
    r.arrow.style.visibility = 'hidden';
  }

  r.seen.textContent = t.lastSeen != null ? formatAgo(now - t.lastSeen) : '—';
  r.batt.textContent = t.battery != null ? `${t.battery}%` : '—';
  r.hops.textContent = formatHops(t.hops);
  const n = rssiBars(t.rssi);
  [...r.bars.children].forEach((b, i) => b.classList.toggle('on', i < n));
  r.bars.setAttribute('aria-label', t.rssi != null ? `${n} of 4 bars, ${t.rssi} dBm` : 'no signal data');
  r.bars.title = t.rssi != null ? `${t.rssi} dBm, SNR ${t.snr ?? '?'} dB` : '';

  let note = '';
  if (t.noFix && t.lat != null) note = `No GPS fix right now. Showing their position from ${formatAgo(now - t.fixAt)}.`;
  else if (t.noFix) note = 'No GPS fix yet on this pendant.';
  r.note.textContent = note;
  r.note.hidden = !note;

  if (t.lat != null) {
    r.maps.href = geoUri(t.lat, t.lon, t.name);
    r.maps.removeAttribute('aria-disabled');
    r.copy.disabled = false;
  } else {
    r.maps.removeAttribute('href');
    r.maps.setAttribute('aria-disabled', 'true');
    r.copy.disabled = true;
  }

  const last = t.trail[t.trail.length - 1];
  const key = `${t.trail.length}:${last ? last.t : 0}`;
  if (key !== v.trailKey) {
    v.trailKey = key;
    r.trailSummary.textContent = `Breadcrumbs (${t.trail.length})`;
    const items = t.trail.slice().reverse().map((c) => {
      const li = document.createElement('li');
      const time = document.createElement('span');
      time.textContent = timeFmt(c.t);
      const pos = document.createElement('span');
      pos.textContent = formatLatLon(c.lat, c.lon);
      li.append(time, pos);
      return li;
    });
    r.trailList.replaceChildren(...items);
  }
}

function renderCards(now, me) {
  const list = [...store.trekkers.values()].map((t) => ({ t, rel: relation(t, me), stale: isStale(t, now) }));
  list.sort((a, b) =>
    (b.t.sos - a.t.sos) || (a.stale - b.stale) ||
    ((a.rel?.dist ?? Infinity) - (b.rel?.dist ?? Infinity)) || (a.t.src - b.t.src));
  el.empty.hidden = list.length > 0;

  const keep = new Set();
  list.forEach(({ t, rel, stale }, i) => {
    keep.add(t.src);
    const v = ensureCard(t.src);
    updateCard(v, t, rel, stale, me, now);
    if (el.cards.children[i] !== v.root) el.cards.insertBefore(v.root, el.cards.children[i] ?? null);
  });
  for (const [src, v] of cardViews) {
    if (!keep.has(src)) { v.root.remove(); cardViews.delete(src); }
  }
}

async function copyCoords(src) {
  const t = store.trekkers.get(src);
  if (!t || t.lat == null) return;
  const text = formatLatLon(t.lat, t.lon);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall back below */ }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { /* ignore */ }
  }
  toast(ok ? `Copied ${text}` : `Copy failed: ${text}`);
}

/* ============================================================ the rest */

function renderBanner(now, me) {
  const sos = store.activeSos();
  el.banner.hidden = sos.length === 0;
  const keep = new Set();
  for (const t of sos) {
    keep.add(t.src);
    let row = bannerRows.get(t.src);
    if (!row) {
      const rowEl = document.createElement('div');
      rowEl.className = 'sos-row';
      const text = document.createElement('span');
      text.className = 'sos-text';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn sos-silence';
      btn.addEventListener('click', () => silence(t.src));
      rowEl.append(text, btn);
      el.banner.append(rowEl);
      row = { row: rowEl, text, btn };
      bannerRows.set(t.src, row);
    }
    const rel = relation(t, me);
    let msg = `SOS: ${t.name}`;
    if (rel) msg += `, ${formatDistance(rel.dist)} ${compassText(rel.bearing)}`;
    else if (t.lat == null) msg += ', position unknown';
    if (isStale(t, now)) msg += ' (STALE)';
    row.text.textContent = msg;
    const silenced = state.silenced.has(sosKey(t));
    row.btn.textContent = silenced ? 'Silenced' : 'Silence';
    row.btn.disabled = silenced;
  }
  for (const [src, row] of bannerRows) {
    if (!keep.has(src)) { row.row.remove(); bannerRows.delete(src); }
  }
}

function renderTop(now, me) {
  const labels = {
    idle: 'Not connected',
    connecting: 'Connecting…',
    connected: `Connected · ${state.device?.name || 'pendant'}`,
    retrying: 'Pendant lost · retrying…',
    lost: 'Disconnected',
    demo: 'Demo mode',
  };
  el.connText.textContent = labels[state.conn];
  el.connDot.dataset.state = state.conn;

  const btn = {
    idle: ['Connect', false], connecting: ['Connecting…', true], retrying: ['Retrying…', true],
    connected: ['Disconnect', false], lost: ['Reconnect', false], demo: ['Exit demo', false],
  }[state.conn];
  el.connBtn.textContent = btn[0];
  el.connBtn.disabled = btn[1];
  el.connBtn.classList.toggle('primary', state.conn === 'idle' || state.conn === 'lost');

  let meText;
  if (!me) meText = state.geoError ? `Me: no GPS (${state.geoError})` : 'Me: waiting for GPS…';
  else if (me.source === 'pendant') meText = 'Me: pendant GPS';
  else if (me.source === 'phone') meText = `Me: phone GPS ±${Math.round(me.acc ?? 0)} m`;
  else meText = `Me: last known, ${formatAgo(now - (me.at ?? now))}`;
  if (store.own?.battery != null) meText += ` · 🔋${store.own.battery}%`;
  el.meText.textContent = meText;
}

function renderHint() {
  let text;
  let warn = false;
  if (state.compass === 'ok') {
    if (state.tilted) { text = 'Hold phone flat'; warn = true; }
    else text = `Heading ${Math.round(state.heading)}° ${compassText(state.heading)}`;
  } else if (state.compass === 'waiting') {
    text = 'Looking for compass…';
  } else {
    text = needsOrientationPermission && !state.compassAsked
      ? 'Tap to enable compass · north is up'
      : 'No compass on this phone · north is up';
    warn = true;
  }
  if (el.hint.textContent !== text) el.hint.textContent = text;
  el.hint.classList.toggle('warn', warn);
}

function renderMySos() {
  if (hold) return; // don't fight the hold animation
  const canUse = state.conn === 'connected' || DEMO;
  el.mySos.disabled = !canUse || state.sosBusy;
  el.mySos.classList.toggle('sent', state.mySos);
  let label;
  if (state.sosBusy) label = 'Sending…';
  else if (state.mySos) label = canUse ? 'SOS SENT · tap to cancel' : 'SOS SENT · reconnect to cancel';
  else label = canUse ? 'Hold 2 s for SOS' : 'Connect pendant to use SOS';
  el.mySosLabel.textContent = label;
}

function renderStats() {
  const s = store.stats;
  let txt = `Packets ${s.received} · duplicates dropped ${s.duplicates}`;
  if (s.outOfOrder) txt += ` · late ${s.outOfOrder}`;
  if (s.invalid) txt += ` · bad ${s.invalid}`;
  el.stats.textContent = txt;
}

function renderAll() {
  const now = Date.now();
  const me = myPosition(now);
  renderTop(now, me);
  renderBanner(now, me);
  renderCards(now, me);
  renderHint();
  renderMySos();
  renderStats();
  updateBuzz(now);
  state.dirty = true;
}

function scheduleUi() {
  state.dirty = true;
  if (state.uiQueued) return;
  state.uiQueued = true;
  requestAnimationFrame(() => { state.uiQueued = false; renderAll(); });
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3500);
}

/* ============================================================ wake lock */

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock || document.visibilityState !== 'visible') return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    state.wakeLock = lock;
    lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
  } catch { /* battery saver or not allowed */ }
}

function releaseWakeLock() {
  const lock = state.wakeLock;
  state.wakeLock = null;
  lock?.release().catch(() => {});
}

/* ========================================================== persistence */

function loadSaved() {
  if (DEMO) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) store.restore(JSON.parse(raw));
  } catch { /* private mode or corrupt data */ }
}

function save() {
  if (DEMO) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store.snapshot())); } catch { /* ignore */ }
}

el.clearBtn.addEventListener('click', () => {
  if (!confirm('Clear all trekkers and breadcrumbs from this phone?')) return;
  store.clear();
  state.silenced.clear();
  state.lastOwnSosFlag = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  renderAll();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (state.conn === 'connected' || DEMO) requestWakeLock();
    scheduleUi();
  } else {
    save();
  }
});
window.addEventListener('pagehide', save);
window.addEventListener('resize', () => { state.dirty = true; });

/* ================================================================ start */

if (DEMO) {
  el.demoLink.textContent = 'Exit demo';
  el.demoLink.href = location.pathname;
  el.clearBtn.hidden = true;
}

loadSaved();
initCompass();
renderAll();
requestAnimationFrame(frame);
setInterval(renderAll, 1000);
setInterval(save, 15_000);

if (DEMO) {
  state.demo = startDemo({ onPacket: handleBytes, speed: DEMO_SPEED });
  requestWakeLock();
  window.trekRadar = { store, state }; // handy for debugging and the smoke test
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered:', err));
}
