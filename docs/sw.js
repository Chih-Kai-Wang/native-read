const CACHE_NAME = 'nativeread-pwa-v2.8.5';
const NETWORK_FIRST_TIMEOUT_MS = 4000;

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
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(
        APP_SHELL_ASSETS.map((asset) =>
          fetch(new Request(asset, { cache: 'no-cache' }))
            .then((res) => (res && res.ok ? cache.put(asset, res) : undefined))
            .catch(() => undefined)
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : Promise.resolve()))
      ))
      .then(() => self.clients.claim())
  );
});

async function fetchWithTimeout(req, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(req, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function matchOfflineFallback(req) {
  const exact = await caches.match(req);
  if (exact) return exact;
  const ignoreQuery = await caches.match(req, { ignoreSearch: true });
  if (ignoreQuery) return ignoreQuery;
  if (req.mode === 'navigate') {
    const shell = await caches.match('./index.html');
    if (shell) return shell;
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  // Only cache same-origin HTTP(S) app shell assets; let LLM API calls and external PDFs pass through
  if (url.origin !== self.location.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return;
  }

  const isImmutableVendor = url.pathname.includes('/vendor/') || url.pathname.includes('/icons/');

  if (isImmutableVendor) {
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

  // Network-First with Lie-Fi timeout and offline/query fallback for HTML, JS, CSS, and userscript
  event.respondWith(
    fetchWithTimeout(req, NETWORK_FIRST_TIMEOUT_MS)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await matchOfflineFallback(req);
        if (cached) return cached;
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      })
  );
});
