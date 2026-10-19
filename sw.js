// Offline app shell: cache-first for the app's own files; Google APIs always go to the network.
const CACHE = 'surveykit-field-4.0.1';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/calc.js', 'js/naming.js', 'js/projzip.js', 'js/store.js', 'js/session.js', 'js/sync.js', 'js/drive.js', 'js/gis.js',
  'vendor/fflate.js', 'data/options.json', 'data/tolerances.json'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;           // Drive / Google sign-in: network only
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match('index.html'))));
});
