import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function loadConfig(initialStorage = {}, { setDelayMs = 0 } = {}) {
  const code = fs.readFileSync(path.join(REPO_ROOT, 'shared/config.js'), 'utf8');
  const store = { ...initialStorage };
  const context = {
    globalThis: null,
    console,
    URL,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: { id: 'native-read-test-ext' },
      storage: {
        local: {
          async get(key) {
            if (typeof key === 'string') {
              return key in store ? { [key]: store[key] } : {};
            }
            return { ...store };
          },
          async set(obj) {
            if (setDelayMs > 0) {
              await new Promise((r) => setTimeout(r, setDelayMs));
            }
            Object.assign(store, obj);
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(code, context, { filename: 'shared/config.js' });
  return { KCTConfig: context.KCTConfig, store };
}

test('endpoint normalizers preserve query strings, subpaths, and protocols', () => {
  const { KCTConfig } = loadConfig();

  assert.equal(
    KCTConfig.normalizeOpenAIEndpoint('https://myres.openai.azure.com/openai/deployments/gpt4o?api-version=2024-06-01'),
    'https://myres.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-06-01'
  );
  assert.equal(
    KCTConfig.normalizeGeminiEndpoint('https://generativelanguage.googleapis.com/v1alpha', 'gemini-3.5-flash-lite'),
    'https://generativelanguage.googleapis.com/v1alpha/models/gemini-3.5-flash-lite:generateContent'
  );
  assert.equal(
    KCTConfig.normalizeAnthropicEndpoint('https://proxy.example.com/anthropic/v1?tier=pro'),
    'https://proxy.example.com/anthropic/v1/messages?tier=pro'
  );
  assert.equal(
    KCTConfig.normalizeAnthropicEndpoint('https://api.anthropic.com'),
    'https://api.anthropic.com/v1/messages'
  );
  assert.equal(
    KCTConfig.buildListModelsUrl({ protocol: 'openai', baseUrl: 'http://127.0.0.1:11434' }),
    'http://127.0.0.1:11434/v1/models'
  );
  assert.equal(
    KCTConfig.buildListModelsUrl({
      protocol: 'openai',
      baseUrl: 'https://myres.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-06-01'
    }),
    ''
  );
  assert.equal(
    KCTConfig.buildListModelsUrl({
      protocol: 'openai',
      baseUrl: 'https://proxy.example.com/v1/chat/completions?tenant=acme'
    }),
    'https://proxy.example.com/v1/models?tenant=acme'
  );
  assert.equal(
    KCTConfig.buildListModelsUrl({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1alpha'
    }),
    'https://generativelanguage.googleapis.com/v1alpha/models?pageSize=1000'
  );
});

test('validateApiKey & buildProviderAuthHeaders reject non-ASCII / whitespace keys', () => {
  const { KCTConfig } = loadConfig();

  assert.equal(KCTConfig.sanitizeApiKey('  Bearer \u200Bsk-dummy-123\r\n '), 'sk-dummy-123');
  assert.equal(KCTConfig.validateApiKey('sk-dummy-valid_99').ok, true);

  const bad = KCTConfig.validateApiKey('sk-金鑰-123');
  assert.equal(bad.ok, false);

  assert.throws(
    () => KCTConfig.buildProviderAuthHeaders({ protocol: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'sk-壞金鑰'),
    (err) => err?.errorCode === 'INVALID_API_KEY_CHARS'
  );
});

test('isLocalEndpoint, isInjectableUrl, and isRemotePdfUrl handle edge cases', () => {
  const { KCTConfig } = loadConfig();

  assert.equal(KCTConfig.isLocalEndpoint('http://localhost:11434/v1'), true);
  assert.equal(KCTConfig.isLocalEndpoint('http://127.0.0.1:8080'), true);
  assert.equal(KCTConfig.isLocalEndpoint('http://[::1]:11434/v1'), true);
  assert.equal(KCTConfig.isLocalEndpoint('https://evil.example/localhost'), false);

  assert.equal(KCTConfig.isInjectableUrl('https://arxiv.org/abs/2401.00001'), true);
  assert.equal(KCTConfig.isInjectableUrl('https://addons.mozilla.org/en-US/firefox/addon/x/'), false);
  assert.equal(KCTConfig.isInjectableUrl('chromewebstore.google.com'), false);
  assert.equal(KCTConfig.isInjectableUrl('CHROME://settings'), false);

  assert.equal(KCTConfig.isRemotePdfUrl('https://openreview.net/pdf?id=abcXYZ123'), true);
  assert.equal(KCTConfig.isRemotePdfUrl('https://arxiv.org/pdf/2401.00001'), true);
  assert.equal(KCTConfig.isRemotePdfUrl('https://example.com/DOCS/REPORT.PDF?dl=1'), true);
  assert.equal(KCTConfig.isRemotePdfUrl('https://example.com/article.html'), false);
});

test('formatApiError prioritizes explicit HTTP 401/403/404/429 over overload prose', () => {
  const { KCTConfig } = loadConfig();

  const auth401 = KCTConfig.formatApiError('HTTP 401: high demand capacity exceeded, invalid api key');
  assert.equal(auth401.retryable, false);
  assert.match(auth401.shortMsg, /API Key 驗證失敗/);

  const auth403 = KCTConfig.formatApiError('HTTP_403: forbidden even though overloaded');
  assert.equal(auth403.retryable, false);
  assert.match(auth403.detailMsg, /403/);

  const notFound = KCTConfig.formatApiError('HTTP 404: model overloaded or missing');
  assert.equal(notFound.retryable, false);
  assert.match(notFound.shortMsg, /404/);

  const dailyQuota = KCTConfig.formatApiError('已達單日免費配額上限（Quota exceeded）');
  assert.match(dailyQuota.shortMsg, /上限/);

  const timeout = KCTConfig.formatApiError({ message: 'request aborted', errorCode: 'TIMEOUT' });
  assert.equal(timeout.retryable, true);
});

test('saveSettings serializes concurrent writes without clobbering sibling fields', async () => {
  const { KCTConfig, store } = loadConfig({}, { setDelayMs: 25 });
  await KCTConfig.saveSettings({ targetLang: 'zh-TW', displayMode: 'replace' });

  await Promise.all([
    KCTConfig.saveSettings({ targetLang: 'ja' }),
    KCTConfig.saveSettings({ displayMode: 'bilingual' })
  ]);

  assert.equal(store.kct_settings_v1.targetLang, 'ja');
  assert.equal(store.kct_settings_v1.displayMode, 'bilingual');
});

test('cache-db.js handles hung openDB timeout cleanly without unhandled rejection', async () => {
  const timers = [];
  const cacheCode = fs.readFileSync(path.join(REPO_ROOT, 'shared/cache-db.js'), 'utf8');
  const ctx = {
    globalThis: null,
    console,
    indexedDB: {
      open() {
        return {};
      }
    },
    setTimeout(fn) {
      const id = timers.length + 1;
      timers.push(fn);
      return id;
    },
    clearTimeout() {}
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(cacheCode, ctx, { filename: 'shared/cache-db.js' });

  const statsPromise = ctx.KCTCacheDB.stats();
  assert.ok(timers.length >= 1, 'openDB armed timeout watchdog');
  timers.forEach((fn) => fn());
  const stats = await statsPromise;
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), { entries: 0, bytes: 0 });
});

test('cache-db.js recovers from QuotaExceededError by evicting oldest fraction and retrying', async () => {
  const cacheCode = fs.readFileSync(path.join(REPO_ROOT, 'shared/cache-db.js'), 'utf8');
  const rows = new Map([
    ['k1', { key: 'k1', zh: '一', ts: 100 }],
    ['k2', { key: 'k2', zh: '二', ts: 200 }],
    ['k3', { key: 'k3', zh: '三', ts: 300 }]
  ]);
  let failNextPut = true;

  const mockDb = {
    close() {},
    transaction(_storeName, _mode) {
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            put(item) {
              const putReq = { error: null, onerror: null, onsuccess: null };
              if (failNextPut) {
                failNextPut = false;
                const qErr = new Error('QuotaExceededError');
                qErr.name = 'QuotaExceededError';
                putReq.error = qErr;
                tx.error = qErr;
                queueMicrotask(() => {
                  putReq.onerror?.({ target: putReq });
                  tx.onerror?.({ target: tx });
                });
                return putReq;
              }
              rows.set(item.key, item);
              return putReq;
            },
            count() {
              const req = { result: rows.size, onsuccess: null, onerror: null };
              queueMicrotask(() => req.onsuccess?.({ target: req }));
              return req;
            },
            index() {
              return {
                openCursor() {
                  const sorted = Array.from(rows.values()).sort((a, b) => a.ts - b.ts);
                  let i = 0;
                  const curReq = { result: null, onsuccess: null, onerror: null };
                  const advance = () => {
                    if (i < sorted.length) {
                      const rec = sorted[i];
                      curReq.result = {
                        value: rec,
                        delete() {
                          rows.delete(rec.key);
                          return { onerror: null };
                        },
                        continue() { i += 1; queueMicrotask(advance); }
                      };
                    } else {
                      curReq.result = null;
                    }
                    curReq.onsuccess?.({ target: curReq });
                  };
                  queueMicrotask(advance);
                  return curReq;
                }
              };
            }
          };
        }
      };
      queueMicrotask(() => {
        if (!tx.error) tx.oncomplete?.({ target: tx });
      });
      return tx;
    }
  };

  const ctx = {
    globalThis: null,
    console,
    setTimeout,
    clearTimeout,
    indexedDB: {
      open() {
        const req = { result: mockDb, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => req.onsuccess?.({ target: req }));
        return req;
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(cacheCode, ctx, { filename: 'shared/cache-db.js' });

  await ctx.KCTCacheDB.putMany([{ key: 'k4', zh: '四', ts: 400 }]);
  assert.equal(rows.has('k1'), false, 'Oldest entry evicted on QuotaExceededError');
  assert.equal(rows.get('k4')?.zh, '四', 'Retried put succeeded after eviction');
});

test('cache-db.js uses chunked getAll for stats() and getAllKeys for eviction when supported', async () => {
  const cacheCode = fs.readFileSync(path.join(REPO_ROOT, 'shared/cache-db.js'), 'utf8');
  const rows = new Map();
  let expectedBytes = 0;
  for (let i = 0; i < 505; i++) {
    const key = `k_${String(i).padStart(4, '0')}`;
    const zh = `譯_${i}`;
    rows.set(key, { key, zh, ts: 1000 + i });
    expectedBytes += key.length + zh.length * 2 + 24;
  }

  let failNextPut = false;
  let getAllCalls = 0;
  let getAllKeysCalls = 0;

  const mockDb = {
    close() {},
    transaction(_storeName, _mode) {
      let pendingReqs = 0;
      let completeScheduled = false;
      const scheduleMaybeComplete = () => {
        if (completeScheduled) return;
        completeScheduled = true;
        queueMicrotask(() => {
          completeScheduled = false;
          if (pendingReqs === 0 && !tx.error) {
            tx.oncomplete?.({ target: tx });
          }
        });
      };
      const runReq = (fn) => {
        pendingReqs += 1;
        queueMicrotask(() => {
          fn();
          pendingReqs -= 1;
          if (pendingReqs === 0) scheduleMaybeComplete();
        });
      };
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            openCursor() {
              throw new Error('openCursor must not be called when getAll/getAllKeys are available');
            },
            getAll(range, count) {
              getAllCalls += 1;
              const req = { result: null, onsuccess: null, onerror: null };
              const sortedKeys = Array.from(rows.keys()).sort();
              const filtered = range && range._lower !== undefined
                ? sortedKeys.filter((k) => (range._open ? k > range._lower : k >= range._lower))
                : sortedKeys;
              const sliceKeys = typeof count === 'number' ? filtered.slice(0, count) : filtered;
              req.result = sliceKeys.map((k) => rows.get(k));
              runReq(() => req.onsuccess?.({ target: req }));
              return req;
            },
            put(item) {
              const putReq = { error: null, onerror: null, onsuccess: null };
              if (failNextPut) {
                failNextPut = false;
                const qErr = new Error('QuotaExceededError');
                qErr.name = 'QuotaExceededError';
                putReq.error = qErr;
                tx.error = qErr;
                runReq(() => {
                  putReq.onerror?.({ target: putReq });
                  tx.onerror?.({ target: tx });
                });
                return putReq;
              }
              rows.set(item.key, item);
              scheduleMaybeComplete();
              return putReq;
            },
            delete(pk) {
              rows.delete(pk);
              scheduleMaybeComplete();
              return { onerror: null };
            },
            count() {
              const req = { result: rows.size, onsuccess: null, onerror: null };
              runReq(() => req.onsuccess?.({ target: req }));
              return req;
            },
            index() {
              return {
                openCursor() {
                  throw new Error('index.openCursor must not be called when getAllKeys is available');
                },
                getAllKeys(_range, count) {
                  getAllKeysCalls += 1;
                  const req = { result: null, onsuccess: null, onerror: null };
                  const sorted = Array.from(rows.values()).sort((a, b) => a.ts - b.ts);
                  req.result = (typeof count === 'number' ? sorted.slice(0, count) : sorted).map((r) => r.key);
                  runReq(() => req.onsuccess?.({ target: req }));
                  return req;
                }
              };
            }
          };
        }
      };
      return tx;
    }
  };

  const ctx = {
    globalThis: null,
    console,
    setTimeout,
    clearTimeout,
    IDBKeyRange: {
      lowerBound(lower, open = false) {
        return { _lower: lower, _open: open };
      }
    },
    indexedDB: {
      open() {
        const req = { result: mockDb, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => req.onsuccess?.({ target: req }));
        return req;
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(cacheCode, ctx, { filename: 'shared/cache-db.js' });

  const stats = await ctx.KCTCacheDB.stats();
  assert.equal(getAllCalls, 2, 'stats() scanned 505 entries in 2 chunks of 500');
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), { entries: 505, bytes: expectedBytes });

  failNextPut = true;
  await ctx.KCTCacheDB.putMany([{ key: 'k_new', zh: '新條目', ts: 9999 }]);
  assert.equal(getAllKeysCalls, 1, 'QuotaExceededError eviction used tsIndex.getAllKeys once');
  assert.equal(rows.has('k_0000'), false, 'Oldest key deleted via store.delete');
  assert.equal(rows.get('k_new')?.zh, '新條目', 'New entry persisted after batched eviction');
});
