import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function loadServiceWorker({ initialSettings = {}, fetchImpl, tabsById = {}, tabsList = null, executeScriptImpl } = {}) {
  const configCode = fs.readFileSync(path.join(REPO_ROOT, 'shared/config.js'), 'utf8');
  const swCode = fs.readFileSync(path.join(REPO_ROOT, 'background/service-worker.js'), 'utf8');
  const store = { ...initialSettings };
  let onMessageListener = null;
  const onConnectListeners = [];
  const cacheMap = new Map();
  const createdTabs = [];
  let fileSchemeAllowed = false;

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
        onConnect: { addListener(fn) { onConnectListeners.push(fn); } },
        onMessage: { addListener(fn) { onMessageListener = fn; } }
      },
      extension: {
        isAllowedFileSchemeAccess(cb) { if (typeof cb === 'function') cb(fileSchemeAllowed); }
      },
      contextMenus: {
        create() {},
        removeAll(cb) { if (typeof cb === 'function') cb(); },
        onClicked: noopEvent()
      },
      commands: { onCommand: noopEvent() },
      tabs: {
        onUpdated: noopEvent(),
        onRemoved: noopEvent(),
        async get(id) {
          if (!(id in tabsById)) throw new Error('Tab not found');
          return tabsById[id];
        },
        async query() {
          return Array.isArray(tabsList) ? tabsList : Object.values(tabsById);
        },
        async create(props) {
          createdTabs.push(props);
          return { id: 900 + createdTabs.length, ...props };
        }
      },
      scripting: {
        async executeScript(opts) {
          return executeScriptImpl ? executeScriptImpl(opts) : [];
        }
      },
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
    createdTabs,
    setFileSchemeAllowed(val) { fileSchemeAllowed = Boolean(val); },
    setFetch(fn) { currentFetch = fn; },
    sendMessage(message, sender = { id: 'native-read-test-ext' }) {
      return new Promise((resolve) => {
        const keepAsync = onMessageListener(message, sender, resolve);
        if (keepAsync !== true) resolve(undefined);
      });
    },
    getOnConnect: () => (port) => {
      for (const fn of onConnectListeners) fn(port);
    }
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

test('hasPdfSignature validates %PDF- magic, openPdfViewer attaches tabId / preserves fileAccess=denied, and kct-pdf-fetch blocks untrusted senders', async () => {
  const { context, createdTabs, getOnConnect } = loadServiceWorker();

  const validBytes = Buffer.from('%PDF-1.7\n1 0 obj');
  const leadingWsBytes = Buffer.from('  \n\r\t%PDF-1.4\n');
  const htmlBytes = Buffer.from('<!DOCTYPE html><html><body>Login</body></html>');
  assert.equal(context.hasPdfSignature(validBytes), true);
  assert.equal(context.hasPdfSignature(leadingWsBytes), true);
  assert.equal(context.hasPdfSignature(htmlBytes), false);

  await context.openPdfViewer('https://arxiv.org/pdf/2501.00001', { id: 42, index: 3, windowId: 1 });
  assert.equal(
    createdTabs[0].url,
    'chrome-extension://native-read-test-ext/viewer/pdf-viewer.html?src=https%3A%2F%2Farxiv.org%2Fpdf%2F2501.00001&tabId=42'
  );

  const fileMeta = await context.openPdfViewer('file:///tmp/paper.pdf', { id: 43, index: 4, windowId: 1 });
  assert.equal(fileMeta.fileAccessAllowed, false);
  assert.equal(
    createdTabs[1].url,
    'chrome-extension://native-read-test-ext/viewer/pdf-viewer.html?fileAccess=denied&name=paper.pdf'
  );

  let disconnected = false;
  const untrustedPort = {
    name: 'kct-pdf-fetch',
    sender: { url: 'https://evil.example/page.html', tab: { id: 99 } },
    onDisconnect: { addListener() {} },
    onMessage: { addListener() {} },
    postMessage() { throw new Error('must not post to untrusted sender'); },
    disconnect() { disconnected = true; }
  };
  getOnConnect()(untrustedPort);
  assert.equal(disconnected, true, 'kct-pdf-fetch immediately disconnects non-extension senders');
});

test('OPEN_PDF_VIEWER prefers explicit message.tabId over sender.tab for detectFromTab', async () => {
  const executeCalls = [];
  const { sendMessage, createdTabs } = loadServiceWorker({
    tabsById: {
      77: { id: 77, index: 2, windowId: 1, url: 'https://paper.example/abs' },
      88: { id: 88, index: 3, windowId: 1, url: 'chrome-extension://native-read-test-ext/popup/popup.html' }
    },
    executeScriptImpl: (opts) => {
      executeCalls.push(opts);
      return [
        {
          frameId: 0,
          result: {
            isPdf: false,
            url: 'https://paper.example/abs',
            origin: 'https://paper.example',
            detectedHref: 'https://paper.example/protected.pdf'
          }
        }
      ];
    }
  });

  const senderFromExtensionTab = {
    id: 'native-read-test-ext',
    url: 'chrome-extension://native-read-test-ext/popup/popup.html',
    tab: { id: 88, index: 3, windowId: 1, url: 'chrome-extension://native-read-test-ext/popup/popup.html' }
  };
  const res = await sendMessage(
    { type: 'OPEN_PDF_VIEWER', tabId: 77, detectFromTab: true },
    senderFromExtensionTab
  );

  assert.equal(res.ok, true);
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0]?.target?.tabId, 77);
  assert.equal(createdTabs.length, 1);
  assert.equal(
    createdTabs[0].url,
    'chrome-extension://native-read-test-ext/viewer/pdf-viewer.html?src=https%3A%2F%2Fpaper.example%2Fprotected.pdf&tabId=77'
  );
});

test('trySyncFromOpenTrustedPwaTabs bridges valid PWA settings while ignoring untrusted origins, localhost & stale data', async () => {
  const evilPayload = JSON.stringify({
    providerId: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-evil-pwa-tab',
    model: 'gpt-4o-mini',
    syncedAt: 9999999999999
  });
  const localPayload = JSON.stringify({
    providerId: 'ollama',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama-dummy',
    model: 'qwen2.5',
    syncedAt: 9999999999999
  });
  const trustedPayload = JSON.stringify({
    providerId: 'gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIza-trusted-open-tab-77',
    model: 'gemini-3.5-flash-lite',
    targetLang: 'zh-TW',
    syncedAt: 1700000500000
  });

  let execCalls = 0;
  const { context, store } = loadServiceWorker({
    tabsList: [
      { id: 100, url: 'https://evil.example/native-read/' },
      { id: 101, url: 'https://chih-kai-wang.github.io/native-read/' }
    ],
    executeScriptImpl: ({ target }) => {
      execCalls += 1;
      if (target.tabId === 100) return [{ result: evilPayload }];
      if (target.tabId === 101) return [{ result: execCalls === 1 ? trustedPayload : localPayload }];
      return [];
    }
  });

  const imported = await context.trySyncFromOpenTrustedPwaTabs();
  assert.equal(imported, true);
  assert.equal(execCalls, 1, 'Never executes script on untrusted tab 100');
  assert.equal(store.kct_settings_v1.apiKey, 'AIza-trusted-open-tab-77');
  assert.equal(store.kct_settings_v1.syncedAt, 1700000500000);

  // Stale timestamp (<= stored syncedAt) does not overwrite
  const staleRes = await context.tryImportFromTrustedPwaTab(101, 'https://chih-kai-wang.github.io/native-read/');
  assert.equal(staleRes, false);

  // Localhost baseUrl in trusted PWA is ignored for extension auto-sync
  const freshLocalEnv = loadServiceWorker({
    tabsList: [{ id: 102, url: 'https://chih-kai-wang.github.io/native-read/' }],
    executeScriptImpl: () => [{ result: localPayload }]
  });
  const localImported = await freshLocalEnv.context.trySyncFromOpenTrustedPwaTabs();
  assert.equal(localImported, false);
  assert.equal(freshLocalEnv.store.kct_settings_v1, undefined);
});

test('IMPORT_SYNC_PAYLOAD accepts valid sync URL from extension sender, rejects partial payload without key, and blocks untrusted senders', async () => {
  const { sendMessage, store } = loadServiceWorker();
  const validToken = Buffer.from(JSON.stringify({
    p: 'deepseek',
    r: 'openai',
    k: 'sk-ds-imported-sync-88',
    m: 'deepseek-chat',
    l: 'zh-CN'
  })).toString('base64url');

  const okRes = await sendMessage({
    type: 'IMPORT_SYNC_PAYLOAD',
    raw: `https://chih-kai-wang.github.io/native-read/#nr_sync=${validToken}`
  });
  assert.equal(okRes.ok, true);
  assert.equal(store.kct_settings_v1.providerId, 'deepseek');
  assert.equal(store.kct_settings_v1.apiKey, 'sk-ds-imported-sync-88');

  const partialToken = Buffer.from(JSON.stringify({
    u: 'https://attacker.example/v1',
    m: 'hijacked-model'
  })).toString('base64url');
  const badRes = await sendMessage({
    type: 'IMPORT_SYNC_PAYLOAD',
    raw: `#nr_sync=${partialToken}`
  });
  assert.equal(badRes.ok, false);
  assert.equal(store.kct_settings_v1.apiKey, 'sk-ds-imported-sync-88');

  const untrustedRes = await sendMessage(
    { type: 'IMPORT_SYNC_PAYLOAD', raw: `#nr_sync=${validToken}` },
    { url: 'https://untrusted.example/page.html', tab: { id: 55 } }
  );
  assert.equal(untrustedRes.ok, false);
});
