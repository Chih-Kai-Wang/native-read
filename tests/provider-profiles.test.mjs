import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function loadConfig(initialStorage = {}) {
  const code = fs.readFileSync(path.join(REPO_ROOT, 'shared/config.js'), 'utf8');
  const store = { ...initialStorage };
  const context = {
    globalThis: null,
    console,
    URL,
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

test('v1 -> v6 migration forces autoTranslate=false and seeds active providerProfiles', async () => {
  const { KCTConfig } = loadConfig({
    kct_settings_v1: {
      settingsSchemaVersion: 1,
      autoTranslate: true,
      displayMode: 'bilingual',
      providerId: 'gemini',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gem-dummy-token-001',
      model: 'gemini-3.5-flash-lite',
      targetLang: 'zh-TW',
      batchSize: 8
    }
  });

  assert.equal(KCTConfig.DEFAULT_SETTINGS.settingsSchemaVersion, 6);
  const migrated = await KCTConfig.getSettings();
  assert.equal(migrated.settingsSchemaVersion, 6);
  assert.equal(migrated.autoTranslate, false);
  assert.equal(migrated.displayMode, 'replace');
  assert.equal(migrated.batchSize, 20);
  assert.equal(migrated.fallbackProviderId, '');
  assert.equal(migrated.providerProfiles.gemini.apiKey, 'gem-dummy-token-001');
  assert.equal(migrated.providerProfiles.gemini.model, 'gemini-3.5-flash-lite');
});

test('v5 -> v6 migration preserves autoTranslate=true and migrates active profile', async () => {
  const { KCTConfig } = loadConfig({
    kct_settings_v1: {
      settingsSchemaVersion: 5,
      autoTranslate: true,
      providerId: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'ds-dummy-token-002',
      model: 'deepseek-chat'
    }
  });

  const migrated = await KCTConfig.getSettings();
  assert.equal(migrated.settingsSchemaVersion, 6);
  assert.equal(migrated.autoTranslate, true);
  assert.equal(migrated.providerProfiles.deepseek.apiKey, 'ds-dummy-token-002');
  assert.equal(migrated.providerProfiles.deepseek.model, 'deepseek-chat');
  assert.equal(migrated.fallbackProviderId, '');
});

test('switchActiveProviderSettings stashes current profile, restores target, and never leaks keys', () => {
  const { KCTConfig } = loadConfig();
  const base = {
    ...KCTConfig.DEFAULT_SETTINGS,
    providerId: 'gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'gem-dummy-token-003',
    model: 'gemini-3.5-flash-lite',
    fallbackProviderId: 'deepseek',
    providerProfiles: {
      gemini: {
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gem-dummy-token-003',
        model: 'gemini-3.5-flash-lite'
      },
      deepseek: {
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'ds-dummy-token-004',
        model: 'deepseek-chat'
      }
    }
  };

  const toDeepSeek = KCTConfig.switchActiveProviderSettings(base, 'deepseek');
  assert.equal(toDeepSeek.providerId, 'deepseek');
  assert.equal(toDeepSeek.protocol, 'openai');
  assert.equal(toDeepSeek.apiKey, 'ds-dummy-token-004');
  assert.equal(toDeepSeek.model, 'deepseek-chat');
  assert.equal(toDeepSeek.providerProfiles.gemini.apiKey, 'gem-dummy-token-003');
  assert.equal(toDeepSeek.fallbackProviderId, '');

  const toGroqFresh = KCTConfig.switchActiveProviderSettings(toDeepSeek, 'groq');
  assert.equal(toGroqFresh.providerId, 'groq');
  assert.equal(toGroqFresh.apiKey, '');
  assert.equal(toGroqFresh.providerProfiles.gemini.apiKey, 'gem-dummy-token-003');
  assert.equal(toGroqFresh.providerProfiles.deepseek.apiKey, 'ds-dummy-token-004');
});

test('removeProviderProfile removes non-active profile and guards active profile', () => {
  const { KCTConfig } = loadConfig();
  const settings = {
    ...KCTConfig.DEFAULT_SETTINGS,
    providerId: 'gemini',
    apiKey: 'gem-dummy-token-005',
    model: 'gemini-3.5-flash-lite',
    fallbackProviderId: 'openai',
    providerProfiles: {
      gemini: {
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gem-dummy-token-005',
        model: 'gemini-3.5-flash-lite'
      },
      openai: {
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'oai-dummy-token-006',
        model: 'gpt-4o-mini'
      }
    }
  };

  const afterRemoveActive = KCTConfig.removeProviderProfile(settings, 'gemini');
  assert.ok(afterRemoveActive.providerProfiles.gemini);

  const afterRemoveFallback = KCTConfig.removeProviderProfile(settings, 'openai');
  assert.equal(afterRemoveFallback.providerProfiles.openai, undefined);
  assert.equal(afterRemoveFallback.fallbackProviderId, '');
  assert.ok(afterRemoveFallback.providerProfiles.gemini);
});

test('listSavedProviders reports active, fallback, ready, and local Ollama profiles accurately', () => {
  const { KCTConfig } = loadConfig();
  const settings = {
    ...KCTConfig.DEFAULT_SETTINGS,
    providerId: 'gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'gem-dummy-token-007',
    model: 'gemini-3.5-flash-lite',
    fallbackProviderId: 'ollama',
    providerProfiles: {
      gemini: {
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gem-dummy-token-007',
        model: 'gemini-3.5-flash-lite'
      },
      ollama: {
        protocol: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'qwen2.5:7b'
      }
    }
  };

  const list = KCTConfig.listSavedProviders(settings);
  assert.equal(list.length, 2);
  const gem = list.find((p) => p.providerId === 'gemini');
  const oll = list.find((p) => p.providerId === 'ollama');
  assert.equal(gem.isActive, true);
  assert.equal(gem.isFallback, false);
  assert.equal(gem.isReady, true);
  assert.equal(oll.isActive, false);
  assert.equal(oll.isFallback, true);
  assert.equal(oll.isLocal, true);
  assert.equal(oll.hasKey, false);
  assert.equal(oll.isReady, true);
});

test('resolveFallbackSettings returns null unless configured, distinct, and ready', () => {
  const { KCTConfig } = loadConfig();
  const base = {
    ...KCTConfig.DEFAULT_SETTINGS,
    providerId: 'gemini',
    apiKey: 'gem-dummy-token-008',
    model: 'gemini-3.5-flash-lite',
    fallbackProviderId: '',
    providerProfiles: {
      gemini: {
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gem-dummy-token-008',
        model: 'gemini-3.5-flash-lite'
      },
      deepseek: {
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'ds-dummy-token-009',
        model: 'deepseek-chat'
      },
      openai: {
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini'
      }
    }
  };

  assert.equal(KCTConfig.resolveFallbackSettings(base), null);
  assert.equal(KCTConfig.resolveFallbackSettings({ ...base, fallbackProviderId: 'gemini' }), null);
  assert.equal(KCTConfig.resolveFallbackSettings({ ...base, fallbackProviderId: 'openai' }), null);

  const fb = KCTConfig.resolveFallbackSettings({ ...base, fallbackProviderId: 'deepseek' });
  assert.ok(fb);
  assert.equal(fb.providerId, 'deepseek');
  assert.equal(fb.protocol, 'openai');
  assert.equal(fb.apiKey, 'ds-dummy-token-009');
  assert.equal(fb.model, 'deepseek-chat');
  assert.equal(fb.fallbackProviderId, '');
});

test('formatApiError handles 503 high demand, 429 rate limit, 401 auth, timeout, and NO_API_KEY', () => {
  const { KCTConfig } = loadConfig();

  const f503 = KCTConfig.formatApiError(
    'HTTP 503: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
    503
  );
  assert.equal(f503.retryable, true);
  assert.equal(f503.suggestSwitch, true);
  assert.ok(f503.shortMsg.includes('503'));
  assert.ok(f503.shortMsg.length < 30);

  const f429 = KCTConfig.formatApiError('HTTP 429: RESOURCE_EXHAUSTED', 429);
  assert.equal(f429.retryable, true);
  assert.equal(f429.suggestSwitch, true);
  assert.ok(f429.shortMsg.includes('429'));

  const f401 = KCTConfig.formatApiError('HTTP 401: Incorrect API key provided', 401);
  assert.equal(f401.retryable, false);
  assert.equal(f401.suggestSwitch, true);
  assert.ok(f401.shortMsg.length > 0 && f401.shortMsg.length < 30);
  assert.ok(f401.detailMsg.includes('401'));

  const fNet = KCTConfig.formatApiError('TypeError: Failed to fetch timeout');
  assert.equal(fNet.retryable, true);
  assert.equal(fNet.suggestSwitch, true);

  const fNoKey = KCTConfig.formatApiError('請先設定 API Key', 0, 'NO_API_KEY');
  assert.equal(fNoKey.retryable, false);
  assert.equal(fNoKey.suggestSwitch, true);
});
