# Trek Buddy Radar

An offline Android web app (PWA) that connects to your own Trek Buddy pendant over Web Bluetooth. It shows a compass radar with the distance and direction to every other trekker in the group.

- No maps and no network once installed. Every file is local and the service worker caches all of them.
- No build step and no dependencies. It's plain HTML, CSS and ES modules.
- Needs **Chrome on Android**. Web Bluetooth isn't available on iOS or in Firefox.

```
radar/
├── index.html             page layout + card template
├── style.css              dark, high-contrast styles
├── app.js                 Bluetooth, compass, GPS fallback, radar drawing, cards, SOS, wake lock, storage
├── core.js                packet parser, dedupe, haversine/bearing, formatting, trekker store (no DOM)
├── demo.js                fake 18-byte packets for ?demo=1, sent through the same parser
├── sw.js                  service worker (precaches everything)
├── manifest.webmanifest   PWA manifest
├── icons/                 icon-192.png, icon-512.png (made by tools/make-icons.mjs)
├── tools/make-icons.mjs   regenerates the icons, no dependencies
└── tests/
    ├── core.test.mjs      node --test: parser, dedupe, haversine, bearing, formatting
    └── smoke.mjs          headless Chrome/Edge run of ?demo=1, checks for console errors
```

## Using it

1. Tap **Connect** and pick `TrekBuddy-<id>` from the list. Android asks for Bluetooth and Location permission, and **Location must be switched on** for Bluetooth scanning.
2. The radar rotates with the phone. Hold the phone flat (the app tells you if it isn't). If the phone has no compass, north stays at the top and the app says so.
3. Each trekker gets a card. The big arrow points toward them relative to where the phone is facing. The card also shows the distance, compass direction, last-seen time, battery, hop count and LoRa signal. A card greys out and gets a STALE badge after 90 s without a packet.
4. If anyone raises an **SOS**, a red banner appears and the phone vibrates. **Silence** stops the vibration for that SOS only. The banner stays until their pendant clears the flag.
5. **My SOS**: press and hold the bottom button for 2 s to send. Tap it again and confirm to cancel.
6. **Open in Organic Maps** opens a `geo:` link, so Organic Maps (with offline maps downloaded) can navigate to that trekker.

My position comes from the phone's GPS while it is updating (about once a second, and it works offline), so the distance drops smoothly as you walk. If the phone has no fix, the app uses my own pendant's packets (the ones with RSSI 0), which arrive every 30 s. The other trekkers' positions still update every 30 s, because that's how often their pendants send.

The app saves the last known positions and breadcrumbs in `localStorage`, so the screen isn't empty after a reload. **Clear list** removes them.

## Demo mode (no hardware)

Open `index.html?demo=1`, or tap **Demo mode** at the bottom of the page. The demo builds real 18-byte packets and sends them through the same parser as Bluetooth:

| Demo time | What happens |
|-----------|--------------|
| always | My pendant (node 1) stays at a fixed spot. Trekker 2 walks a 300 m circle around me. Trekker 3 stands still about 1.2 km SW, one hop away, with low battery |
| 8 s | A relayed **duplicate** of a Trekker 2 packet (same src + seq) is dropped. The footer counts it |
| 12 s | Trekker 3 sends one packet with the **NO GPS FIX** flag. Its position doesn't move |
| 20 s to 60 s | Trekker 2 raises **SOS**, then clears it |

Add `&speed=4` to run the timeline four times faster.

## Tests

From the `radar/` folder (needs Node 18 or later; the smoke test needs Node 22 or later):

```sh
node --test                 # unit tests for core.js
node tests/smoke.mjs [dir]  # headless browser run of ?demo=1; saves screenshots to [dir]
```

The smoke test finds Chrome or Edge on its own. If it can't, set `BROWSER=/path/to/chrome`.

## Developing locally (with a real phone)

Web Bluetooth only runs on **HTTPS** or **localhost**. You can make the phone treat your laptop's server as localhost:

1. On the laptop:
   ```sh
   cd radar
   python -m http.server 8000
   ```
2. On the phone, turn on **Developer options → USB debugging** and connect it to the laptop with a USB cable.
3. In desktop Chrome, open `chrome://inspect/#devices`. Click **Port forwarding…** and add `8000` → `localhost:8000`, then tick **Enable port forwarding**.
4. On the phone, open Chrome at `http://localhost:8000`. Web Bluetooth now works, and you can debug the page from `chrome://inspect` on the laptop.

The service worker serves the cached copy first and refreshes it in the background. After editing a file, reload twice, or tick **Application → Service workers → Update on reload** in DevTools.

## Deploying to GitHub Pages (to install on phones)

1. Push this repository to GitHub.
2. In the repo, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, then branch `main` and folder `/ (root)`, and save.
3. After a minute the app is at `https://<user>.github.io/<repo>/radar/`.
4. On each phone, while online, open that URL in **Chrome** once. Then go to **⋮ → Add to Home screen → Install**.
5. From then on, open it from the home screen icon. It works with no signal.

To push an update to phones, change a file and also bump `CACHE` in `sw.js` (for example `trek-radar-v2`). Phones pick up the new version the next time they open the app with a connection.

## Bluetooth protocol (from the pendant firmware)

- Advertised name `TrekBuddy-<NODE_ID>`; service `6e400001-b5a3-f393-e0a9-e50e24dc7e01`
- `…0002` NOTIFY: 18 bytes, little-endian, packed:
  `group u8 | src u8 | seq u16 | type u8 | ttl u8 | lat i32 ×1e6 | lon i32 ×1e6 | battery u8 | flags u8 | rssi i8 | snr×4 i8`
  - type: 0 LOCATION, 1 SOS. Hops = 3 − ttl.
  - flags: 0x01 SOS, 0x02 fall, 0x04 low battery, 0x08 no GPS fix (lat/lon invalid)
  - rssi = 0 means this is the connected pendant's own packet.
- `…0003` WRITE: one byte. `0x01` starts SOS, `0x00` cancels it.

The app drops duplicates by (src, seq) within a 2-minute window. It ignores a late, older relayed copy, so a cancelled SOS can't come back.
