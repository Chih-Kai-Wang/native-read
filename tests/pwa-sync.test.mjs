import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('docs/index.html exposes mobile post-install sync card and 1-tap paste/copy controls', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'docs/index.html'), 'utf8');
  for (const id of [
    'installSyncStatusCard',
    'btnInstallApplySync',
    'btnInstallCopySync',
    'pwaSyncImportInput',
    'pwaSyncImportBtn',
    'pwaSyncCopyBtn'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `docs/index.html must expose #${id}`);
  }
});

test('docs/app.js defers #nr_sync scrub until after load, sets syncedAt, and never leaks apiKey in sync events', () => {
  const appJs = fs.readFileSync(path.join(REPO_ROOT, 'docs/app.js'), 'utf8');
  const match = appJs.match(
    /function encodeBase64UrlUtf8[\s\S]*?function checkAndApplyNrSyncHash\(\)[\s\S]*?\n\}/
  );
  assert.ok(match, 'Could not locate sync helper block in docs/app.js');

  assert.ok(appJs.includes('scheduleScrubNrSyncHash'), 'docs/app.js defines delayed hash scrub');
  assert.ok(
    /checkAndApplyNrSyncHash\(\)[\s\S]*?finally\s*\{\s*[\s\S]*?scheduleScrubNrSyncHash\(\)/.test(match[0]),
    'checkAndApplyNrSyncHash delegates cleanup to scheduleScrubNrSyncHash instead of synchronous scrub'
  );
  const dispatchBody = match[0].match(/function dispatchPwaSyncEvent\([\s\S]*?\n\}/);
  assert.ok(dispatchBody, 'dispatchPwaSyncEvent helper exists');
  assert.equal(
    /apiKey|rawKey|\bk\b/.test(dispatchBody[0]),
    false,
    'dispatchPwaSyncEvent must never include API key fields'
  );

  // Execute sync helpers in an isolated VM context
  const providersCode = fs.readFileSync(path.join(REPO_ROOT, 'docs/providers.js'), 'utf8')
    .replace(/export\s+const\s+PROVIDER_PRESETS\s*=/, 'const PROVIDER_PRESETS =');
  const store = {};
  const dispatchedEvents = [];
  const loadListeners = [];
  let replaceStateCalls = 0;

  const samplePayload = Buffer.from(JSON.stringify({
    p: 'openai',
    r: 'openai',
    k: 'sk-pwa-sync-test-001',
    m: 'gpt-4o-mini',
    l: 'zh-TW'
  })).toString('base64url');

  const ctx = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setTimeout: (fn) => { fn(); return 1; },
    TARGET_LANGUAGES: { 'zh-TW': { id: 'zh-TW' }, 'zh-CN': { id: 'zh-CN' }, custom: { id: 'custom' } },
    isLocalEndpoint: (u) => /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(String(u || '')),
    validateApiKey: (k) => ({ ok: /^[\x21-\x7E]*$/.test(String(k || '').trim()), cleanKey: String(k || '').trim(), error: '' }),
    normalizeProviderProfiles: (raw, active) => ({
      ...(raw || {}),
      ...(active?.apiKey ? { [active.providerId]: { protocol: active.protocol, baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model } } : {})
    }),
    loadSettings: () => (store.kct_settings_v1 ? JSON.parse(store.kct_settings_v1) : { providerProfiles: {} }),
    saveSettings: (patch) => {
      const next = { ...(store.kct_settings_v1 ? JSON.parse(store.kct_settings_v1) : {}), ...patch };
      store.kct_settings_v1 = JSON.stringify(next);
      return next;
    },
    history: {
      replaceState() {
        replaceStateCalls += 1;
        ctx.window.location.hash = '';
      }
    },
    document: { readyState: 'loading' },
    window: null
  };
  ctx.window = {
    location: {
      pathname: '/native-read/',
      search: '',
      hash: `#nr_sync=${samplePayload}`
    },
    addEventListener(type, fn) {
      if (type === 'load') loadListeners.push(fn);
    },
    dispatchEvent(ev) {
      dispatchedEvents.push(ev);
    }
  };
  ctx.globalThis = ctx;

  vm.runInNewContext(`${providersCode}\n${match[0]}`, ctx);

  const synced = ctx.checkAndApplyNrSyncHash();
  assert.equal(synced, true, 'checkAndApplyNrSyncHash imports valid hash');
  assert.equal(replaceStateCalls, 0, 'Hash is NOT scrubbed synchronously before document load completes');
  assert.ok(ctx.window.location.hash.includes('nr_sync='), 'Hash remains available for Userscript document-idle boot');

  const saved = JSON.parse(store.kct_settings_v1);
  assert.equal(saved.apiKey, 'sk-pwa-sync-test-001');
  assert.ok(typeof saved.syncedAt === 'number' && saved.syncedAt > 0, 'Persisted syncedAt timestamp');
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0].type, 'nativeread:pwa-settings-synced');
  assert.equal(JSON.stringify(dispatchedEvents[0].detail).includes('sk-pwa-sync-test-001'), false, 'Sync event never exposes API key');

  // Fire window load listeners -> scheduled scrub runs now
  assert.equal(loadListeners.length, 1);
  loadListeners[0]();
  assert.equal(replaceStateCalls, 1, 'Hash scrubbed cleanly after load event');
  assert.equal(ctx.window.location.hash, '');

  const generatedUrl = ctx.buildMobileSyncUrlFromSettings(saved);
  assert.ok(generatedUrl.startsWith('https://chih-kai-wang.github.io/native-read/#nr_sync='), 'Builds shareable sync URL');
  assert.ok(ctx.extractNrSyncTokenFromInput(generatedUrl).length > 10, 'Extracts token back from full URL');
});
