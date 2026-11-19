// Demo mode (?demo=1): builds real 18-byte packets and hands them to the same
// handler the BLE notifications use. Timeline in demo seconds (scaled by ?speed=N):
//   - my pendant (node 1) fixed at DEMO_HOME, own packets (RSSI 0)
//   - Trekker 2 walks a 300 m circle around me, direct link
//   - Trekker 2 raises SOS at 20 s, clears it at 60 s
//   - Trekker 3 stands ~1.2 km SW, 1 hop, low battery; one packet at 12 s has NO_FIX
//   - at 8 s, one relayed duplicate of a Trekker 2 packet (same src + seq)
import { encodePacket, TYPE, FLAG } from './core.js';

export const DEMO_HOME = Object.freeze({ lat: 32.243200, lon: 77.189200 });
export const DEMO_SCRIPT = Object.freeze({
  sosStart: 20, sosEnd: 60, noFixAt: 12, duplicateAt: 8, circleRadius: 300, circlePeriod: 120,
});

const M_PER_DEG = 111_320;
function offset(base, northM, eastM) {
  return {
    lat: base.lat + northM / M_PER_DEG,
    lon: base.lon + eastM / (M_PER_DEG * Math.cos((base.lat * Math.PI) / 180)),
  };
}
const TREKKER3 = offset(DEMO_HOME, -850, -850);

export function startDemo({ onPacket, speed = 1, clock = () => performance.now() }) {
  const S = DEMO_SCRIPT;
  const t0 = clock();
  const seqs = new Map();
  const nextSeq = (src) => {
    const s = ((seqs.get(src) ?? 99) + 1) & 0xffff;
    seqs.set(src, s);
    return s;
  };
  const due = { me: 0, t2: 0.3, t3: 0.6 };
  let ownSos = false;
  let sentNoFix = false;
  let sentDuplicate = false;

  const send = (fields) => {
    const bytes = encodePacket({ group: 7, ttl: 3, ...fields });
    onPacket(new DataView(bytes.buffer));
    return bytes;
  };

  function tick() {
    const t = ((clock() - t0) / 1000) * speed;

    if (t >= due.me) {
      send({
        src: 1, seq: nextSeq(1), type: ownSos ? TYPE.SOS : TYPE.LOCATION, ...DEMO_HOME,
        battery: 88, flags: ownSos ? FLAG.SOS : 0, rssi: 0, snr: 0,
      });
      due.me = t + (ownSos ? 5 : 10);
    }

    if (t >= due.t2) {
      const sos = t >= S.sosStart && t < S.sosEnd;
      const a = (t / S.circlePeriod) * 2 * Math.PI;
      const pos = offset(DEMO_HOME, S.circleRadius * Math.cos(a), S.circleRadius * Math.sin(a));
      const bytes = send({
        src: 2, seq: nextSeq(2), type: sos ? TYPE.SOS : TYPE.LOCATION, ...pos,
        battery: 64, flags: sos ? FLAG.SOS : 0, rssi: -84 - Math.round(6 * Math.sin(a * 3)), snr: 7.5,
      });
      if (!sentDuplicate && t >= S.duplicateAt) {
        // Same packet heard again via a relay: same src + seq, one hop, weaker signal.
        sentDuplicate = true;
        const copy = bytes.slice();
        const dv = new DataView(copy.buffer);
        dv.setUint8(5, 2);
        dv.setInt8(16, -109);
        dv.setInt8(17, -8);
        onPacket(dv);
      }
      due.t2 = t + (sos ? 2 : 3);
    }

    if (t >= due.t3) {
      const noFix = !sentNoFix && t >= S.noFixAt;
      if (noFix) sentNoFix = true;
      send({
        src: 3, seq: nextSeq(3), ttl: 2, ...(noFix ? { lat: 0, lon: 0 } : TREKKER3),
        battery: 12, flags: FLAG.LOW_BATTERY | (noFix ? FLAG.NO_FIX : 0), rssi: -114, snr: -6.25,
      });
      due.t3 = t + 6;
    }
  }

  const timer = setInterval(tick, 200);
  tick();

  return {
    /** Simulates writing 0x01 / 0x00 to the SOS characteristic. */
    setOwnSos(on) { ownSos = !!on; due.me = 0; tick(); },
    stop() { clearInterval(timer); },
  };
}
