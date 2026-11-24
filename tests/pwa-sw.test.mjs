import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function loadServiceWorkerEnv({ seedCaches = {} } = {}) {
  const swCode = fs.readFileSync(path.join(REPO_ROOT, 'docs/sw.js'), 'utf8');
  const listeners = new Map();
  const eventsOrder = [];
  const cacheMap = new Map(
    Object.entries(seedCaches).map(([k, v]) => [k, new Map(Object.entries(v))])
  );

  const cachesApi = {
    async open(name) {
      if (!cacheMap.has(name)) cacheMap.set(name, new Map());
      const bucket = cacheMap.get(name);
      return {
        async put(reqOrKey, res) {
          const k = typeof reqOrKey === 'string' ? reqOrKey : reqOrKey.url;
          bucket.set(k, res);
        }
      };
    },
    async keys() {
      return Array.from(cacheMap.keys());
    },
    async delete(name) {
      eventsOrder.push(`delete:${name}`);
      return cacheMap.delete(name);
    },
    async match(reqOrUrl, opts = {}) {
      const targetUrl = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
      for (const bucket of cacheMap.values()) {
        if (bucket.has(targetUrl)) return bucket.get(targetUrl);
        if (opts?.ignoreSearch) {
          const cleanTarget = targetUrl.split('?')[0];
          for (const [k, v] of bucket.entries()) {
            const resolved = k.startsWith('./')
              ? new URL(k.slice(2), 'https://chih-kai-wang.github.io/native-read/').toString()
              : k;
            if (resolved.split('?')[0] === cleanTarget || k.split('?')[0] === cleanTarget) {
              return v;
            }
          }
        }
      }
      return null;
    }
  };

  let fetchImpl = async () => new Response('ok', { status: 200 });
  const timeoutQueue = [];

  class MockRequest {
    constructor(input, init = {}) {
      this.url = typeof input === 'string' ? input : input.url;
      this.method = init.method || 'GET';
      this.mode = init.mode || 'cors';
      this.cache = init.cache || 'default';
    }
  }

  class MockResponse {
    constructor(body = '', init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.type = init.type || 'basic';
    }
    clone() {
      return new MockResponse(this.body, { status: this.status, type: this.type });
    }
  }

  const selfObj = {
    location: { origin: 'https://chih-kai-wang.github.io', pathname: '/native-read/sw.js' },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    async skipWaiting() {
      eventsOrder.push('skipWaiting');
    },
    clients: {
      async claim() {
        eventsOrder.push('clientsClaim');
      }
    }
  };

  const context = {
    self: selfObj,
    caches: cachesApi,
    Request: MockRequest,
    Response: MockResponse,
    URL,
    AbortController,
    console,
    fetch: (req, opts) => fetchImpl(req, opts),
    setTimeout(fn, ms) {
      const id = timeoutQueue.length + 1;
      timeoutQueue.push({ fn, ms, cleared: false, id });
      return id;
    },
    clearTimeout(id) {
      const hit = timeoutQueue.find((t) => t.id === id);
      if (hit) hit.cleared = true;
    }
  };

  vm.runInNewContext(swCode, context, { filename: 'docs/sw.js' });
  return {
    listeners,
    eventsOrder,
    cacheMap,
    timeoutQueue,
    setFetch(fn) { fetchImpl = fn; }
  };
}

test('install awaits precache with cache:no-cache before calling skipWaiting', async () => {
  const env = loadServiceWorkerEnv();
  const seenCacheModes = [];
  env.setFetch(async (req) => {
    seenCacheModes.push(req.cache);
    return new (class { constructor() { this.ok = true; this.type = 'basic'; } clone() { return this; } })();
  });

  let waitedPromise = null;
  env.listeners.get('install')({
    waitUntil(p) {
      waitedPromise = p;
    }
  });
  assert.ok(waitedPromise, 'install calls event.waitUntil');
  assert.equal(env.eventsOrder.includes('skipWaiting'), false, 'skipWaiting must NOT run before precache resolves');
  await waitedPromise;
  assert.equal(env.eventsOrder.includes('skipWaiting'), true, 'skipWaiting ran inside waitUntil after precache');
  assert.ok(seenCacheModes.every((m) => m === 'no-cache'), 'precache bypasses HTTP cache with no-cache');
});

test('activate deletes stale caches before calling clients.claim', async () => {
  const env = loadServiceWorkerEnv({
    seedCaches: {
      'nativeread-pwa-old-v1': { './app.js': 'old' }
    }
  });

  let waitedPromise = null;
  env.listeners.get('activate')({
    waitUntil(p) {
      waitedPromise = p;
    }
  });
  await waitedPromise;
  assert.equal(env.cacheMap.has('nativeread-pwa-old-v1'), false, 'old cache deleted');
  const delIdx = env.eventsOrder.indexOf('delete:nativeread-pwa-old-v1');
  const claimIdx = env.eventsOrder.indexOf('clientsClaim');
  assert.ok(delIdx !== -1 && claimIdx > delIdx, 'clients.claim runs after deleting old caches');
});

test('cross-origin LLM API fetch is passed through untouched', () => {
  const env = loadServiceWorkerEnv();
  let responded = false;
  env.listeners.get('fetch')({
    request: { url: 'https://api.openai.com/v1/chat/completions', method: 'POST', mode: 'cors' },
    respondWith() { responded = true; }
  });
  env.listeners.get('fetch')({
    request: { url: 'https://generativelanguage.googleapis.com/v1beta/models', method: 'GET', mode: 'cors' },
    respondWith() { responded = true; }
  });
  assert.equal(responded, false);
});

test('network timeout falls back to ignoreSearch / index shell cache offline', async () => {
  const cachedShell = { status: 200, ok: true, body: 'cached-shell' };
  const env = loadServiceWorkerEnv({
    seedCaches: {
      'nativeread-pwa-v2.8.0': {
        'https://chih-kai-wang.github.io/native-read/index.html': cachedShell,
        './index.html': cachedShell
      }
    }
  });

  env.setFetch((_req, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      reject(new Error('Aborted by 4s Lie-Fi timeout'));
    });
  }));

  let responsePromise = null;
  env.listeners.get('fetch')({
    request: {
      url: 'https://chih-kai-wang.github.io/native-read/index.html?url=https://arxiv.org/abs/1',
      method: 'GET',
      mode: 'navigate'
    },
    respondWith(p) {
      responsePromise = p;
    }
  });

  assert.equal(env.timeoutQueue.length, 1);
  assert.equal(env.timeoutQueue[0].ms, 4000);
  env.timeoutQueue[0].fn();

  const resolved = await responsePromise;
  assert.equal(resolved, cachedShell);
});
