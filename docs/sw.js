const CACHE_NAME = 'nativeread-pwa-v2.6.1';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './pdf-layout.mjs',
  './providers.js',
  './manifest.webmanifest',
  './nativeread.user.js',
  './icons/icon-16.png',
  './icons/icon-48.png',
  './icons/icon-128.png',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return Promise.resolve();
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  // Only cache same-origin app shell assets; let LLM API calls and external PDFs go directly to network
  if (url.origin !== self.location.origin) {
    return;
  }

  const isImmutableVendor = url.pathname.includes('/vendor/') || url.pathname.includes('/icons/');

  if (isImmutableVendor) {
    // Cache-First for immutable PDF.js and icons
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // Network-First for HTML, app.js, app.css, and nativeread.user.js so updates apply immediately, with offline cache fallback
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
