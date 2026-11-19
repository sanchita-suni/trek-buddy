// Run from the radar/ folder:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePacket, encodePacket, Deduper, TrekkerStore, seqIsOlder,
  haversine, initialBearing, compassText, formatDistance, formatAgo, formatHops,
  geoUri, niceRange, angleDiff, smoothAngle, headingFromAlpha, rssiBars, isStale,
  TYPE, FLAG, TRAIL_LEN,
} from '../core.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ±${tol}, got ${actual}`);

const hex = (s) => Uint8Array.from(s.trim().split(/\s+/), (h) => parseInt(h, 16));

/* ---------------------------------------------------------------- parser */

test('parsePacket decodes a hand-written little-endian vector', () => {
  // group 7, src 2, seq 0x1234, type SOS, ttl 2, lat -33.856784, lon 151.215297,
  // battery 75, flags SOS|LOW_BATTERY, rssi -97, snr4 -10
  const bytes = hex('07 02 34 12 01 02 F0 62 FB FD C1 5C 03 09 4B 05 9F F6');
  const p = parsePacket(bytes);
  assert.equal(p.group, 7);
  assert.equal(p.src, 2);
  assert.equal(p.seq, 0x1234);
  assert.equal(p.type, TYPE.SOS);
  assert.equal(p.ttl, 2);
  assert.equal(p.hops, 1);
  near(p.lat, -33.856784, 1e-9);
  near(p.lon, 151.215297, 1e-9);
  assert.equal(p.battery, 75);
  assert.equal(p.flags, 0x05);
  assert.equal(p.sos, true);
  assert.equal(p.lowBattery, true);
  assert.equal(p.fall, false);
  assert.equal(p.noFix, false);
  assert.equal(p.rssi, -97);
  assert.equal(p.snr, -2.5);
  assert.equal(p.own, false);
});

test('parsePacket accepts DataView, ArrayBuffer and offset views', () => {
  const bytes = encodePacket({ src: 9, seq: 65535, lat: 46.5, lon: -7.25, rssi: -60 });
  const padded = new Uint8Array(30);
  padded.set(bytes, 5);
  for (const input of [bytes, bytes.buffer, new DataView(bytes.buffer), new DataView(padded.buffer, 5, 18)]) {
    const p = parsePacket(input);
    assert.equal(p.src, 9);
    assert.equal(p.seq, 65535);
    near(p.lat, 46.5, 1e-9);
    near(p.lon, -7.25, 1e-9);
  }
});

test('parsePacket rejects wrong sizes', () => {
  assert.equal(parsePacket(new Uint8Array(17)), null);
  assert.equal(parsePacket(new Uint8Array(19)), null);
  assert.equal(parsePacket('nope'), null);
});

test('NO_FIX flag makes lat/lon null but keeps everything else', () => {
  const p = parsePacket(encodePacket({ src: 3, lat: 12.5, lon: 77.5, battery: 40, flags: FLAG.NO_FIX | FLAG.SOS, rssi: -100 }));
  assert.equal(p.lat, null);
  assert.equal(p.lon, null);
  assert.equal(p.noFix, true);
  assert.equal(p.sos, true);
  assert.equal(p.battery, 40);
});

test('RSSI 0 marks own packets; hops = 3 - ttl', () => {
  assert.equal(parsePacket(encodePacket({ src: 1, rssi: 0, lat: 1, lon: 1 })).own, true);
  assert.equal(parsePacket(encodePacket({ src: 1, rssi: -1, lat: 1, lon: 1 })).own, false);
  assert.equal(parsePacket(encodePacket({ src: 1, ttl: 3 })).hops, 0);
  assert.equal(parsePacket(encodePacket({ src: 1, ttl: 0 })).hops, 3);
});

/* ---------------------------------------------------------------- dedupe */

test('Deduper drops same (src, seq), keeps different src or seq', () => {
  const d = new Deduper(120_000);
  assert.equal(d.isDuplicate(2, 10, 0), false);
  assert.equal(d.isDuplicate(2, 10, 1000), true);
  assert.equal(d.isDuplicate(3, 10, 1000), false);
  assert.equal(d.isDuplicate(2, 11, 1000), false);
});

test('Deduper forgets entries after the window (pendant reboot reuses seqs)', () => {
  const d = new Deduper(1000);
  assert.equal(d.isDuplicate(2, 0, 0), false);
  assert.equal(d.isDuplicate(2, 0, 500), true);
  assert.equal(d.isDuplicate(2, 0, 2000), false);
  assert.equal(d.size, 1);
});

test('seqIsOlder handles uint16 wrap', () => {
  assert.equal(seqIsOlder(5, 10), true);
  assert.equal(seqIsOlder(10, 5), false);
  assert.equal(seqIsOlder(65530, 3), true);
  assert.equal(seqIsOlder(3, 65530), false);
  assert.equal(seqIsOlder(7, 7), false);
});

/* ----------------------------------------------------------------- store */

const pkt = (f) => parsePacket(encodePacket({ rssi: -90, ...f }));

test('store: duplicate relayed copy is dropped and counted', () => {
  const s = new TrekkerStore();
  assert.equal(s.ingest(pkt({ src: 2, seq: 1, lat: 10, lon: 10 }), 0).status, 'ok');
  assert.equal(s.ingest(pkt({ src: 2, seq: 1, lat: 10, lon: 10, ttl: 2, rssi: -110 }), 100).status, 'duplicate');
  assert.equal(s.stats.duplicates, 1);
  assert.equal(s.trekkers.get(2).hops, 0);
});

test('store: own packets (RSSI 0) go to store.own, not the trekker list', () => {
  const s = new TrekkerStore();
  const r = s.ingest(pkt({ src: 1, seq: 1, lat: 10, lon: 10, rssi: 0 }), 0);
  assert.equal(r.own, true);
  assert.equal(s.own.src, 1);
  assert.equal(s.trekkers.size, 0);
});

test('store: NO_FIX keeps last position but updates battery, last-seen and SOS', () => {
  const s = new TrekkerStore();
  s.ingest(pkt({ src: 2, seq: 1, lat: 10, lon: 20, battery: 80 }), 1000);
  const r = s.ingest(pkt({ src: 2, seq: 2, lat: 0, lon: 0, battery: 70, flags: FLAG.NO_FIX | FLAG.SOS }), 5000);
  const t = s.trekkers.get(2);
  assert.equal(t.lat, 10);
  assert.equal(t.lon, 20);
  assert.equal(t.fixAt, 1000);
  assert.equal(t.lastSeen, 5000);
  assert.equal(t.battery, 70);
  assert.equal(t.noFix, true);
  assert.equal(t.sos, true);
  assert.equal(r.sosStarted, true);
});

test('store: SOS start/clear events and episode counter', () => {
  const s = new TrekkerStore();
  s.ingest(pkt({ src: 2, seq: 1, lat: 1, lon: 1 }), 0);
  let r = s.ingest(pkt({ src: 2, seq: 2, lat: 1, lon: 1, type: TYPE.SOS, flags: FLAG.SOS }), 1000);
  assert.equal(r.sosStarted, true);
  assert.equal(s.trekkers.get(2).sosEpisode, 1);
  r = s.ingest(pkt({ src: 2, seq: 3, lat: 1, lon: 1, type: TYPE.SOS, flags: FLAG.SOS }), 2000);
  assert.equal(r.sosStarted, false);
  r = s.ingest(pkt({ src: 2, seq: 4, lat: 1, lon: 1 }), 3000);
  assert.equal(r.sosCleared, true);
  assert.deepEqual(s.activeSos(), []);
  s.ingest(pkt({ src: 2, seq: 5, lat: 1, lon: 1, flags: FLAG.SOS }), 4000);
  assert.equal(s.trekkers.get(2).sosEpisode, 2);
});

test('store: a late older packet cannot re-raise a cancelled SOS', () => {
  const s = new TrekkerStore();
  s.ingest(pkt({ src: 2, seq: 10, lat: 1, lon: 1, flags: FLAG.SOS }), 0);
  s.ingest(pkt({ src: 2, seq: 11, lat: 1, lon: 1 }), 1000);
  const r = s.ingest(pkt({ src: 2, seq: 9, lat: 1, lon: 1, flags: FLAG.SOS }), 1500);
  assert.equal(r.status, 'old');
  assert.equal(s.trekkers.get(2).sos, false);
});

test('store: ACK packets are ignored', () => {
  const s = new TrekkerStore();
  assert.equal(s.ingest(pkt({ src: 2, seq: 1, type: TYPE.ACK }), 0).status, 'ignored');
  assert.equal(s.trekkers.size, 0);
});

test('store: breadcrumbs capped at 20, newest last', () => {
  const s = new TrekkerStore();
  for (let i = 0; i < 30; i++) s.ingest(pkt({ src: 2, seq: i, lat: 10 + i * 0.001, lon: 10 }), i * 30_000);
  const trail = s.trekkers.get(2).trail;
  assert.equal(trail.length, TRAIL_LEN);
  near(trail.at(-1).lat, 10.029, 1e-9);
  near(trail[0].lat, 10.010, 1e-9);
});

test('store: snapshot/restore round-trips positions and drops SOS state', () => {
  const a = new TrekkerStore();
  a.ingest(pkt({ src: 1, seq: 1, lat: 5, lon: 6, rssi: 0 }), 0);
  a.ingest(pkt({ src: 2, seq: 1, lat: 5.01, lon: 6, flags: FLAG.SOS, battery: 50 }), 0);
  const b = new TrekkerStore();
  assert.equal(b.restore(JSON.parse(JSON.stringify(a.snapshot()))), true);
  assert.equal(b.own.src, 1);
  const t = b.trekkers.get(2);
  assert.equal(t.lat, 5.01);
  assert.equal(t.battery, 50);
  assert.equal(t.sos, false);
  assert.equal(t.trail.length, 1);
  assert.equal(b.restore({ v: 99 }), false);
  assert.equal(b.restore(null), false);
});

test('isStale after 90 s', () => {
  assert.equal(isStale({ lastSeen: 0 }, 90_000), false);
  assert.equal(isStale({ lastSeen: 0 }, 90_001), true);
  assert.equal(isStale({ lastSeen: null }, 0), true);
});

/* -------------------------------------------------------------- geometry */

test('haversine: known distances', () => {
  assert.equal(haversine(10, 20, 10, 20), 0);
  near(haversine(0, 0, 1, 0), 111_195, 1, '1° of latitude');
  near(haversine(0, 0, 0, 1), 111_195, 1, '1° of longitude at the equator');
  near(haversine(51.5074, -0.1278, 48.8566, 2.3522), 343_560, 1000, 'London–Paris');
  near(haversine(0, 0, 0, 180), Math.PI * 6_371_008.8, 1, 'half the equator');
  // Short trekking distance: 300 m north
  near(haversine(32.0, 77.0, 32.0 + 300 / 111_195, 77.0), 300, 0.5, '300 m north');
});

test('initialBearing: cardinal directions and a real pair', () => {
  near(initialBearing(0, 0, 1, 0), 0, 1e-9, 'north');
  near(initialBearing(0, 0, 0, 1), 90, 1e-9, 'east');
  near(initialBearing(0, 0, -1, 0), 180, 1e-9, 'south');
  near(initialBearing(0, 0, 0, -1), 270, 1e-9, 'west');
  near(initialBearing(0, 0, 1, 1), 45, 0.01, 'north-east');
  near(initialBearing(51.5074, -0.1278, 48.8566, 2.3522), 148.1, 0.5, 'London→Paris');
  const b = initialBearing(10, 10, 10, 10.0001);
  assert.ok(b >= 0 && b < 360);
});

test('compassText: 8-point names', () => {
  assert.equal(compassText(0), 'N');
  assert.equal(compassText(22), 'N');
  assert.equal(compassText(23), 'NE');
  assert.equal(compassText(90), 'E');
  assert.equal(compassText(225), 'SW');
  assert.equal(compassText(338), 'N');
  assert.equal(compassText(-45), 'NW');
});

test('angle helpers', () => {
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(350, 10), -20);
  near(smoothAngle(350, 10, 0.5), 0, 1e-9);
  assert.equal(headingFromAlpha(0), 0);
  assert.equal(headingFromAlpha(90), 270);
  assert.equal(headingFromAlpha(270, 90), 180);
});

/* ------------------------------------------------------------ formatting */

test('formatDistance switches to km at 1 km', () => {
  assert.equal(formatDistance(0), '0 m');
  assert.equal(formatDistance(340.4), '340 m');
  assert.equal(formatDistance(999.4), '999 m');
  assert.equal(formatDistance(999.6), '1.0 km');
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(NaN), '—');
});

test('formatAgo / formatHops', () => {
  assert.equal(formatAgo(12_400), '12 s ago');
  assert.equal(formatAgo(-50), '0 s ago');
  assert.equal(formatAgo(125_000), '2 min ago');
  assert.equal(formatAgo(3 * 3600_000), '3 h ago');
  assert.equal(formatHops(0), 'Direct');
  assert.equal(formatHops(1), '1 hop');
  assert.equal(formatHops(2), '2 hops');
});

test('geoUri matches the Organic Maps format', () => {
  assert.equal(geoUri(32.2432, 77.1892, 'Trekker 2'),
    'geo:32.243200,77.189200?q=32.243200,77.189200(Trekker%202)');
});

test('niceRange fits the farthest trekker', () => {
  assert.equal(niceRange(0), 50);
  assert.equal(niceRange(300), 500);
  assert.equal(niceRange(1200), 1500);
  for (const d of [1, 49, 333, 999, 4321, 87_000]) assert.ok(niceRange(d) >= d);
});

test('rssiBars', () => {
  assert.equal(rssiBars(0), 4);
  assert.equal(rssiBars(-85), 4);
  assert.equal(rssiBars(-95), 3);
  assert.equal(rssiBars(-105), 2);
  assert.equal(rssiBars(-115), 1);
  assert.equal(rssiBars(-125), 0);
  assert.equal(rssiBars(null), 0);
});
