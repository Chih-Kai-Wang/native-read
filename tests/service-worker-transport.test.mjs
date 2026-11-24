import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function loadServiceWorker({ initialSettings = {}, fetchImpl } = {}) {
  const configCode = fs.readFileSync(path.join(REPO_ROOT, 'shared/config.js'), 'utf8');
  const swCode = fs.readFileSync(path.join(REPO_ROOT, 'background/service-worker.js'), 'utf8');
  const store = { ...initialSettings };
  let onMessageListener = null;
  let onConnectListener = null;
  const cacheMap = new Map();

  let currentFetch = fetchImpl || (async () => new Response('{}', { status: 200 }));

  const noopEvent = () => ({ addListener() {}, removeListener() {} });

  const context = {
    globalThis: null,
    console,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    DOMException,
    Headers,
    Request,
    Response,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout: (fn, ms, ...a) => setTimeout(fn, ms >= 300 ? 15 : ms, ...a),
    clearTimeout,
    fetch: (...args) => currentFetch(...args),
    importScripts() {},
    chrome: {
      runtime: {
        id: 'native-read-test-ext',
        getURL: (p) => `chrome-extension://native-read-test-ext/${String(p || '').replace(/^\//, '')}`,
        onInstalled: noopEvent(),
        onStartup: noopEvent(),
        onConnect: { addListener(fn) { onConnectListener = fn; } },
        onMessage: { addListener(fn) { onMessageListener = fn; } }
      },
      contextMenus: {
        create() {},
        removeAll(cb) { if (typeof cb === 'function') cb(); },
        onClicked: noopEvent()
      },
      commands: { onCommand: noopEvent() },
      tabs: { onUpdated: noopEvent() },
      permissions: { async contains() { return true; } },
      storage: {
        local: {
          async get(key) {
            if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
            return { ...store };
          },
          async set(obj) {
            Object.assign(store, obj);
          },
          async remove(key) {
            delete store[key];
          }
        }
      }
    }
  };
  context.globalThis = context;

  vm.runInNewContext(configCode, context, { filename: 'shared/config.js' });
  context.KCTCacheDB = {
    DB_NAME: 'kct_cache_db_v2',
    STORE_NAME: 'entries',
    MAX_ENTRIES: 20000,
    async getMany(keys) {
      const out = new Map();
      for (const k of keys) {
        if (cacheMap.has(k)) out.set(k, cacheMap.get(k));
      }
      return out;
    },
    async putMany(entries) {
      for (const e of entries) {
        if (e?.key && e?.zh) cacheMap.set(e.key, e.zh);
      }
    },
    async stats() {
      return { entries: cacheMap.size, bytes: cacheMap.size * 32 };
    },
    async clear() {
      cacheMap.clear();
    }
  };

  vm.runInNewContext(swCode, context, { filename: 'background/service-worker.js' });

  return {
    context,
    store,
    setFetch(fn) { currentFetch = fn; },
    sendMessage(message, sender = { id: 'native-read-test-ext' }) {
      return new Promise((resolve) => {
        const keepAsync = onMessageListener(message, sender, resolve);
        if (keepAsync !== true) resolve(undefined);
      });
    },
    getOnConnect: () => onConnectListener
  };
}

test('getProviderPacingKey isolates providers and redactAllKeys redacts profile keys', () => {
  const { context } = loadServiceWorker();
  const geminiKey = context.getProviderPacingKey({
    providerId: 'gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.5-flash-lite'
  });
  const deepseekKey = context.getProviderPacingKey({
    providerId: 'deepseek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  });
  assert.notEqual(geminiKey, deepseekKey);

  const redacted = context.redactAllKeys(
    'Failed primary sk-primary-secret-111 and fallback AIzaSyDummyFallbackSecretKey222',
    {
      apiKey: 'sk-primary-secret-111',
      providerProfiles: {
        gemini: { apiKey: 'AIzaSyDummyFallbackSecretKey222' }
      }
    }
  );
  assert.equal(redacted.includes('sk-primary-secret-111'), false);
  assert.equal(redacted.includes('AIzaSyDummyFallbackSecretKey222'), false);
  assert.match(redacted, /\[REDACTED\]/);
});

test('abortableSleep rejects immediately when signal aborts', async () => {
  const configCode = fs.readFileSync(path.join(REPO_ROOT, 'shared/config.js'), 'utf8');
  assert.ok(configCode.length > 0);
  const { context } = loadServiceWorker();
  const ac = new AbortController();
  const t0 = Date.now();
  const p = context.abortableSleep(5000, ac.signal);
  setTimeout(() => ac.abort(), 5);
  await assert.rejects(p, (err) => err?.name === 'AbortError');
  assert.ok(Date.now() - t0 < 500, 'abortableSleep resolved/rejected promptly on abort');
});

test('per-provider pacing isolates DeepSeek 429 cooldown from Gemini requests', async () => {
  const { sendMessage, setFetch } = loadServiceWorker({
    initialSettings: {
      kct_settings_v1: {
        settingsSchemaVersion: 6,
        providerId: 'deepseek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'ds-dummy-001',
        model: 'deepseek-chat',
        targetLang: 'zh-TW',
        providerProfiles: {
          deepseek: { protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'ds-dummy-001', model: 'deepseek-chat' },
          gemini: { protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIzaDummyGeminiKey002', model: 'gemini-3.5-flash-lite' }
        }
      }
    }
  });

  // Primary DeepSeek hits transient 429 rate limit -> records adaptive backoff on DeepSeek's pacing key only
  setFetch(async () => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 429, headers: { 'Retry-After': '10' } }));
  const r1 = await sendMessage({
    type: 'TRANSLATE_BATCH',
    items: [{ key: 'k_ds', text: 'DeepSeek request text' }]
  });
  assert.equal(r1.ok, false);

  // Gemini request goes straight to fetch immediately without waiting on DeepSeek's 429 cooldown
  setFetch(async () => new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ translations: [{ id: 0, zh: '雙子譯文' }] }) }] } }] }),
    { status: 200 }
  ));
  const t0 = Date.now();
  const switchedResp = await sendMessage({
    type: 'TEST_CONNECTION',
    settings: {
      providerId: 'gemini',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaDummyGeminiKey002',
      model: 'gemini-3.5-flash-lite'
    }
  });
  assert.equal(switchedResp.ok, true);
  assert.ok(Date.now() - t0 < 500, 'Gemini request bypassed unrelated provider cooldown');
});

test('NETWORK_ERROR on primary fails over cleanly to configured fallback provider', async () => {
  const seenUrls = [];
  const { sendMessage } = loadServiceWorker({
    initialSettings: {
      kct_settings_v1: {
        settingsSchemaVersion: 6,
        providerId: 'openai',
        protocol: 'openai',
        baseUrl: 'https://primary-down.example.com/v1',
        apiKey: 'sk-primary-001',
        model: 'gpt-4o-mini',
        fallbackProviderId: 'deepseek',
        providerProfiles: {
          openai: { protocol: 'openai', baseUrl: 'https://primary-down.example.com/v1', apiKey: 'sk-primary-001', model: 'gpt-4o-mini' },
          deepseek: { protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-fallback-002', model: 'deepseek-chat' }
        }
      }
    },
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      if (String(url).includes('primary-down.example.com')) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 0, zh: '備援譯文' }] }) } }] }),
        { status: 200 }
      );
    }
  });

  const res = await sendMessage({
    type: 'TRANSLATE_BATCH',
    items: [{ key: 'fb1', text: 'Fallback should recover this sentence cleanly.' }]
  });
  assert.equal(res.ok, true);
  assert.equal(res.results.fb1.zh, '備援譯文');
  assert.equal(res.fallbackUsed.providerId, 'deepseek');
  assert.ok(seenUrls.some((u) => u.includes('api.deepseek.com')), 'Request reached fallback endpoint');
});

test('handleListModels supports OpenRouter publicModelList without an API key', async () => {
  const { sendMessage } = loadServiceWorker({
    fetchImpl: async () => new Response(
      JSON.stringify({ data: [{ id: 'google/gemini-2.5-flash' }, { id: 'anthropic/claude-sonnet-4' }] }),
      { status: 200 }
    )
  });

  const res = await sendMessage({
    type: 'LIST_MODELS',
    settings: {
      providerId: 'openrouter',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: ''
    }
  });
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(res.models)), ['anthropic/claude-sonnet-4', 'google/gemini-2.5-flash']);
});

test('tryImportNrSyncFromUrl accepts anthropic and rejects invalid payloads', async () => {
  const { context, store } = loadServiceWorker();
  const validPayload = Buffer.from(JSON.stringify({
    p: 'anthropic',
    r: 'anthropic',
    k: 'sk-ant-dummy-valid-token-99',
    m: 'claude-sonnet-4-6',
    l: 'zh-TW'
  })).toString('base64url');

  const ok = await context.tryImportNrSyncFromUrl(`https://chih-kai-wang.github.io/native-read/#nr_sync=${validPayload}`);
  assert.equal(ok, true);
  assert.equal(store.kct_settings_v1.protocol, 'anthropic');
  assert.equal(store.kct_settings_v1.model, 'claude-sonnet-4-6');

  const badKeyPayload = Buffer.from(JSON.stringify({
    p: 'openai',
    r: 'openai',
    k: 'sk-非ASCII金鑰',
    u: 'https://api.openai.com/v1',
    m: 'gpt-4o-mini'
  })).toString('base64url');
  const bad = await context.tryImportNrSyncFromUrl(`https://chih-kai-wang.github.io/native-read/#nr_sync=${badKeyPayload}`);
  assert.equal(bad, false);
});
