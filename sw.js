// Service worker: guarda la app en el teléfono para que abra al instante.
// Al publicar cambios, suba el número de VERSION.
const VERSION = 'burbujas-v9';
const ARCHIVOS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' evita copiar archivos viejos de la caché del navegador.
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      cache.addAll(ARCHIVOS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Archivos de la app: responde desde la copia local y la actualiza en segundo plano,
// consultando siempre al servidor (sin la caché del navegador).
// Las peticiones a la API (POST a script.google.com) no pasan por aquí.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
