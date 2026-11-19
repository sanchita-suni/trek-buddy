// Service worker: precaches the whole app so it runs with no network.
// Serves from cache first, then refreshes the cache in the background when online,
// so a new deploy shows up on the next launch. Bump CACHE to force a clean re-install.
const CACHE = 'trek-radar-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './core.js',
  './demo.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreSearch so "./?demo=1" is served from the cached "./"
    const cached = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req)
      .then((res) => {
        if (res.ok && url.search === '') cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }
    const res = await refresh;
    if (res) return res;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('Offline and not cached', { status: 503, statusText: 'Offline' });
  })());
});
