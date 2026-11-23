import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { PROVIDER_PRESETS } from './providers.js';
import {
  shouldTranslatePdfText,
  protectInlineMath,
  restoreMathPlaceholders,
  cleanLatexMathInText,
  isUntranslatedEcho,
  isOverlayNoOp,
  extractPdfParagraphs,
  sampleParagraphColors,
  refineMaxHeightWithCanvasInk
} from './pdf-layout.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';

// ============================================================
// 1. Shared Configuration, Provider Presets & Typography Stacks
// ============================================================
const SETTINGS_KEY = 'kct_settings_v1';
const DB_NAME = 'kct_cache_db_v2';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const MAX_CACHE_ENTRIES = 20000;

// Generated from shared/config.js by scripts/build-mobile.js (single source of truth).

const LATIN_FONTS = {
  serifFontStack: 'Georgia, "Noto Serif", "Times New Roman", serif',
  sansFontStack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif',
  monoFontStack: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
};

const TARGET_LANGUAGES = {
  'zh-TW': {
    id: 'zh-TW',
    label: '繁體中文（台灣）',
    shortLabel: '繁中',
    promptName: 'Traditional Chinese (Taiwanese Mandarin phrasing and terminology)',
    serifFontStack: '"Songti TC", "Noto Serif TC", "PMingLiU", serif',
    sansFontStack: '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif',
    monoFontStack: '"PingFang TC", "Noto Sans TC", monospace'
  },
  'zh-CN': {
    id: 'zh-CN',
    label: '简体中文',
    shortLabel: '简中',
    promptName: 'Simplified Chinese (Mainland China phrasing)',
    serifFontStack: '"Songti SC", "Noto Serif SC", "SimSun", serif',
    sansFontStack: '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
    monoFontStack: '"PingFang SC", "Noto Sans SC", monospace'
  },
  ja: {
    id: 'ja',
    label: '日本語',
    shortLabel: '日本語',
    promptName: 'Japanese (natural technical Japanese)',
    serifFontStack: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
    sansFontStack: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif',
    monoFontStack: '"Hiragino Sans", "Noto Sans JP", monospace'
  },
  ko: {
    id: 'ko',
    label: '한국어',
    shortLabel: '한국어',
    promptName: 'Korean (natural technical Korean)',
    serifFontStack: '"AppleMyungjo", "Batang", "Noto Serif KR", serif',
    sansFontStack: '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif',
    monoFontStack: '"Apple SD Gothic Neo", "Noto Sans KR", monospace'
  },
  es: {
    id: 'es',
    label: 'Español',
    shortLabel: 'ES',
    promptName: 'Spanish (neutral technical Spanish)',
    ...LATIN_FONTS
  },
  fr: {
    id: 'fr',
    label: 'Français',
    shortLabel: 'FR',
    promptName: 'French (natural technical French)',
    ...LATIN_FONTS
  },
  de: {
    id: 'de',
    label: 'Deutsch',
    shortLabel: 'DE',
    promptName: 'German (natural technical German)',
    ...LATIN_FONTS
  },
  vi: {
    id: 'vi',
    label: 'Tiếng Việt',
    shortLabel: 'VI',
    promptName: 'Vietnamese (natural technical Vietnamese)',
    ...LATIN_FONTS
  },
  pt: {
    id: 'pt',
    label: 'Português',
    shortLabel: 'PT',
    promptName: 'Portuguese (natural technical Portuguese)',
    ...LATIN_FONTS
  },
  custom: {
    id: 'custom',
    label: '自訂語言...',
    shortLabel: '自訂',
    promptName: '',
    ...LATIN_FONTS
  }
};

const DEFAULT_GLOSSARY = [
  'overfitting -> 過度擬合',
  'underfitting -> 擬合不足',
  'cross-validation -> 交叉驗證',
  'validation set -> 驗證集',
  'validation data -> 驗證資料',
  'training set -> 訓練集',
  'training data -> 訓練資料',
  'test set -> 測試集',
  'feature engineering -> 特徵工程',
  'gradient boosting -> 梯度提升',
  'random forest -> 隨機森林',
  'decision tree -> 決策樹',
  'mean absolute error (MAE) -> 平均絕對誤差 (MAE)',
  'RMSE -> 均方根誤差 (RMSE)',
  'target leakage -> 目標洩漏',
  'data leakage -> 資料洩漏',
  'pipeline -> 管線 (Pipeline)',
  'function -> 函式',
  'hyperparameter -> 超參數'
].join('\n');

const DEFAULT_SETTINGS = {
  settingsSchemaVersion: 5,
  targetLang: 'zh-TW',
  customTargetLang: '',
  thinkingEffort: 'fastest',
  typographyMatch: 'native',
  providerId: 'gemini',
  protocol: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  temperature: 0.2,
  batchSize: 18,
  maxBatchChars: 5000,
  customGlossary: DEFAULT_GLOSSARY
};

const ZOOM_STEPS = [0.75, 0.85, 1.0, 1.15, 1.25, 1.5, 1.75];

function hashText(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (c + i) & 0xffff;
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}_${str.length}`;
}

function sanitizeApiKey(rawKey) {
  return String(rawKey || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
}

function resolveTargetLanguage(settings) {
  const id = settings?.targetLang || 'zh-TW';
  if (id === 'custom') {
    const customName = String(settings?.customTargetLang || '').trim();
    return {
      id: 'custom',
      label: customName || '自訂語言',
      shortLabel: customName ? customName.slice(0, 4) : '自訂',
      promptName: customName || 'Traditional Chinese (Taiwan)',
      isCustom: true,
      ...LATIN_FONTS
    };
  }
  return TARGET_LANGUAGES[id] || TARGET_LANGUAGES['zh-TW'];
}

function normalizeOpenAIEndpoint(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (clean.endsWith('/chat/completions')) return clean;
  if (/\/(v\d+|openai|compatible-mode\/v1|api\/paas\/v\d+)$/i.test(clean)) {
    return `${clean}/chat/completions`;
  }
  return `${clean}/v1/chat/completions`;
}

function normalizeGeminiEndpoint(baseUrl, model) {
  const clean = String(baseUrl || 'https://generativelanguage.googleapis.com/v1beta')
    .trim()
    .replace(/\/+$/, '');
  const m = String(model || 'gemini-3.5-flash-lite').trim().replace(/^models\//, '');
  if (clean.includes(':generateContent') || clean.includes(':streamGenerateContent')) {
    return clean;
  }
  if (/\/v1(beta)?$/i.test(clean)) {
    return `${clean}/models/${encodeURIComponent(m)}:generateContent`;
  }
  return `${clean}/v1beta/models/${encodeURIComponent(m)}:generateContent`;
}

// ---- Provider helpers kept in sync with shared/config.js (Anthropic Messages API + Azure OpenAI) ----
function isAzureOpenAIEndpoint(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;
  try {
    const { hostname } = new URL(baseUrl.trim());
    const host = hostname.toLowerCase();
    return (
      host.endsWith('.openai.azure.com') ||
      host.endsWith('.services.ai.azure.com') ||
      host.endsWith('.cognitiveservices.azure.com')
    );
  } catch (_) {
    return false;
  }
}

function normalizeAnthropicEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return 'https://api.anthropic.com/v1/messages';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '';
  }
  const clean = parsed.toString().replace(/\/+$/, '');
  if (clean.endsWith('/v1/messages')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/messages`;
  return `${clean}/v1/messages`;
}

function buildProviderAuthHeaders(settings, cleanKey) {
  const headers = { 'Content-Type': 'application/json' };
  const protocol = settings?.protocol || 'openai';
  const key = String(cleanKey || '').trim();

  if (protocol === 'gemini') {
    if (key) headers['x-goog-api-key'] = key;
    return headers;
  }

  if (protocol === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2026-10-21';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    return headers;
  }

  if (key) {
    if (isAzureOpenAIEndpoint(settings?.baseUrl)) {
      headers['api-key'] = key;
    } else {
      headers['Authorization'] = `Bearer ${key}`;
    }
  }
  return headers;
}

function resolveAnthropicEffort(model, thinkingEffort) {
  const m = String(model || '').trim();
  const supportsEffort =
    /^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:5|[6-9])(?:[-.]|$)/.test(m) ||
    /^claude-(?:opus-4-[5-9]|sonnet-4-6|opus-4-6)(?:[-.]|$)/.test(m);
  if (!supportsEffort) return '';

  const map = {
    fastest: 'low',
    balanced: 'medium',
    deep: 'high'
  };
  return map[thinkingEffort] || '';
}

function buildAnthropicMessagesBody(
  settings,
  messages,
  { stream = false, maxTokens = 16000, image = null } = {}
) {
  const systemParts = [];
  const convMessages = [];

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const role = msg.role;
      const text = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
      if (!text.trim()) continue;

      if (role === 'system') {
        systemParts.push(text);
      } else if (role === 'user' || role === 'assistant') {
        convMessages.push({ role, content: text });
      }
    }
  }

  if (image && image.base64 && image.mimeType) {
    let lastUserIdx = -1;
    for (let i = convMessages.length - 1; i >= 0; i--) {
      if (convMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx !== -1) {
      const cleanBase64 = String(image.base64).replace(/^data:[^;]+;base64,/, '');
      const textContent = convMessages[lastUserIdx].content;
      convMessages[lastUserIdx] = {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: String(image.mimeType).trim(),
              data: cleanBase64
            }
          },
          {
            type: 'text',
            text: textContent
          }
        ]
      };
    }
  }

  const model = String(settings?.model || '').trim();
  const body = {
    model,
    max_tokens: Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : 16000,
    messages: convMessages
  };

  if (systemParts.length > 0) {
    body.system = systemParts.join('\n\n');
  }

  if (stream) {
    body.stream = true;
  }

  const effort = resolveAnthropicEffort(model, settings?.thinkingEffort);
  if (effort) {
    body.output_config = { effort };
  }

  return body;
}

function extractAnthropicStreamDelta(eventObj) {
  const result = { text: '', error: '', stopReason: '' };
  if (!eventObj || typeof eventObj !== 'object') return result;

  try {
    if (
      eventObj.type === 'content_block_delta' &&
      eventObj.delta?.type === 'text_delta' &&
      typeof eventObj.delta.text === 'string'
    ) {
      result.text = eventObj.delta.text;
    } else if (eventObj.type === 'error') {
      result.error = String(
        eventObj.error?.message || eventObj.error?.type || 'Anthropic Stream Error'
      );
    } else if (eventObj.type === 'message_delta') {
      if (typeof eventObj.delta?.stop_reason === 'string') {
        result.stopReason = eventObj.delta.stop_reason;
      }
    }
  } catch (_) {
    // Never throw
  }

  return result;
}

function resolveEndpoint(settings) {
  if (settings?.protocol === 'gemini') {
    return normalizeGeminiEndpoint(settings.baseUrl, settings.model);
  }
  if (settings?.protocol === 'anthropic') {
    return normalizeAnthropicEndpoint(settings.baseUrl);
  }
  return normalizeOpenAIEndpoint(settings?.baseUrl);
}

function resolveStreamEndpoint(settings) {
  const endpoint = resolveEndpoint(settings);
  if (!endpoint) return '';
  if (settings?.protocol === 'gemini') {
    const streamUrl = endpoint.includes(':streamGenerateContent')
      ? endpoint
      : endpoint.replace(':generateContent', ':streamGenerateContent');
    try {
      const parsed = new URL(streamUrl);
      parsed.searchParams.set('alt', 'sse');
      return parsed.toString();
    } catch (_) {
      return streamUrl.includes('?') ? `${streamUrl}&alt=sse` : `${streamUrl}?alt=sse`;
    }
  }
  return endpoint;
}

function resolveThinkingConfig(model, effort = 'fastest') {
  const norm = String(model || '').replace(/^models\//i, '').trim().toLowerCase();
  if (!norm) return null;
  const mode = effort === 'balanced' || effort === 'deep' ? effort : 'fastest';

  if (/^gemini-(?:3\.5-flash-lite|3\.6-flash|3-flash|3\.1-flash-lite)/.test(norm)) {
    if (mode === 'fastest') return { thinkingLevel: 'MINIMAL' };
    if (mode === 'balanced') return { thinkingLevel: 'LOW' };
    return { thinkingLevel: 'MEDIUM' };
  }
  if (/^gemini-(?:3\.8-flash|4-|3\.1-pro|3-pro)/.test(norm)) {
    if (mode === 'deep') return { thinkingLevel: 'MEDIUM' };
    return { thinkingLevel: 'LOW' };
  }
  if (/^gemini-2\.5-flash(?:-lite)?(?:$|[-.])/.test(norm)) {
    if (mode === 'fastest') return { thinkingBudget: 0 };
    if (mode === 'balanced') return { thinkingBudget: 512 };
    return { thinkingBudget: 2048 };
  }
  return null;
}

// ============================================================
// 2. Settings Storage & #nr_sync Zero-Typing Sync Decoder
// ============================================================
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...partial };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch (_) {}
  return next;
}

function decodeBase64UrlJson(b64url) {
  const base64 = String(b64url || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = base64 + '==='.slice((base64.length + 3) % 4);
  const binStr = atob(padded);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  const jsonStr = new TextDecoder().decode(bytes);
  return JSON.parse(jsonStr);
}

function checkAndApplyNrSyncHash() {
  const hash = String(window.location.hash || '');
  if (!hash.includes('nr_sync=')) return false;

  const match = hash.match(/(?:^|[#&])nr_sync=([^&]+)/);
  if (!match || !match[1]) return false;

  try {
    const payload = decodeBase64UrlJson(decodeURIComponent(match[1]));
    if (!payload || typeof payload !== 'object') return false;

    const providerId = payload.providerId || payload.p || 'gemini';
    const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.gemini;
    const protocol = payload.protocol || payload.r || preset.protocol || 'gemini';
    const baseUrl = payload.baseUrl || payload.u || preset.baseUrl;
    const apiKey = sanitizeApiKey(payload.apiKey ?? payload.k ?? '');
    const model = payload.model || payload.m || preset.defaultModel;
    const targetLang = payload.targetLang || payload.l || 'zh-TW';
    const customTargetLang = payload.customTargetLang ?? payload.c ?? '';
    const thinkingEffort = payload.thinkingEffort || payload.e || 'fastest';
    const typographyMatch = payload.typographyMatch || payload.t || 'native';

    saveSettings({
      providerId,
      protocol,
      baseUrl,
      apiKey,
      model,
      targetLang,
      customTargetLang,
      thinkingEffort,
      typographyMatch
    });

    // Scrub sensitive hash from address bar and browser history
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return true;
  } catch (err) {
    console.warn('[NativeRead] Failed to decode #nr_sync payload:', err);
    return false;
  }
}

// ============================================================
// 3. IndexedDB Persistent Cache (kct_cache_db_v2)
// ============================================================
let dbPromise = null;

function openCacheDB() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.objectStoreNames.contains(STORE_NAME)
          ? req.transaction.objectStore(STORE_NAME)
          : db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        if (!store.indexNames.contains('ts')) {
          store.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    } catch (err) {
      dbPromise = null;
      reject(err);
    }
  });
  return dbPromise;
}

async function cacheGetMany(keys) {
  const out = new Map();
  if (!Array.isArray(keys) || keys.length === 0) return out;
  try {
    const db = await openCacheDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      for (const k of keys) {
        const req = store.get(k);
        req.onsuccess = () => {
          if (req.result && typeof req.result.zh === 'string' && req.result.zh.trim()) {
            out.set(k, req.result.zh);
          }
        };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(out);
    });
  } catch (_) {
    return out;
  }
}

async function cachePutMany(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  try {
    const db = await openCacheDB();
    const now = Date.now();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      entries.forEach((entry, idx) => {
        if (entry?.key && entry?.zh) {
          store.put({ key: entry.key, zh: entry.zh, ts: now + idx });
        }
      });
      const countReq = store.count();
      countReq.onsuccess = () => {
        let overflow = (countReq.result || 0) - MAX_CACHE_ENTRIES;
        if (overflow > 0) {
          const curReq = store.index('ts').openCursor(null, 'next');
          curReq.onsuccess = () => {
            const cursor = curReq.result;
            if (cursor && overflow > 0) {
              cursor.delete();
              overflow -= 1;
              if (overflow > 0) cursor.continue();
            }
          };
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (_) {}
}

async function cacheCount() {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  } catch (_) {
    return 0;
  }
}

async function cacheClear() {
  try {
    const db = await openCacheDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (_) {}
}

function buildCacheSignature(settings) {
  const lang = resolveTargetLanguage(settings);
  const glossaryHash = hashText(String(settings.customGlossary || '').trim());
  const customLang = lang.id === 'custom' ? String(settings.customTargetLang || '').trim() : '';
  const effort = settings.thinkingEffort || 'fastest';
  return `${settings.protocol}:${settings.model}:${effort}:${lang.id}:${customLang}:${glossaryHash}`;
}

// ============================================================
// 4. Direct Browser-to-LLM SSE Streaming & NDJSON Parser
// ============================================================
function buildLanguageGuidance(lang) {
  if (lang.id === 'zh-TW') {
    return [
      '目標語言：繁體中文（台灣慣用語與台灣繁體字形）。',
      '用語規範：請使用自然道地的台灣用語（例如：資料、欄位、函式、參數、迴圈、模型、特徵、驗證集、過度擬合、管線、程式碼、執行、錯誤訊息），切勿混用簡體字或中國大陸慣用語。'
    ].join('\n');
  }
  if (lang.id === 'zh-CN') {
    return '目标语言：简体中文（自然流利的中国大陆表达与技术术语）。';
  }
  return `Target language: ${lang.promptName}. Translate accurately using natural, idiomatic phrasing in that language.`;
}

function buildStreamSystemPrompt(settings, title = '') {
  const lang = resolveTargetLanguage(settings);
  const glossary = String(settings.customGlossary || '').trim();
  const glossarySection = (glossary && (lang.id === 'zh-TW' || lang.id === 'zh-CN'))
    ? `\n參考術語表：\n${glossary}\n`
    : '';
  return [
    'Expert technical & academic translator for whitepapers, AI/ML papers, software documentation, and web articles.',
    title ? `Document topic: ${String(title).slice(0, 120)}` : '',
    buildLanguageGuidance(lang),
    'Rules:',
    '1. Keep atomic placeholders [[C0]] (code), [[M0]] (math/citations), [[L0]] (untranslatable link) verbatim; keep code identifiers, math formulas, variables, URLs, and standard abbreviations (MAE, RMSE, AUC, LLM, API, Transformer) intact.',
    '2. Output STRICT NDJSON: exactly ONE JSON object per line in the format {"i":0,"t":"..."} matching every input index `i`, in order.',
    '3. NO markdown code fences (no ```), NO surrounding array [...], NO extra commentary.',
    '4. NEVER leave natural-language prose untranslated or echo the source text even if it starts with formulas or [[M0]] placeholders; ALWAYS translate all prose sentences into the target language.',
    glossarySection
  ].filter(Boolean).join('\n');
}

function extractNdjsonEntriesFromObject(obj) {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;
  const pushEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const rawIdx = entry.i ?? entry.id ?? entry.index;
    const rawText = typeof entry.t === 'string'
      ? entry.t
      : typeof entry.zh === 'string'
        ? entry.zh
        : typeof entry.translation === 'string'
          ? entry.translation
          : null;
    if (rawIdx !== undefined && rawText !== null) {
      const idx = Number(rawIdx);
      if (Number.isInteger(idx) && idx >= 0 && rawText.trim()) {
        results.push({ idx, text: rawText.trim() });
      }
    }
  };
  if (Array.isArray(obj)) {
    for (const it of obj) pushEntry(it);
  } else if (Array.isArray(obj.translations)) {
    for (const it of obj.translations) pushEntry(it);
  } else {
    pushEntry(obj);
  }
  return results;
}

function parseNdjsonLine(rawLine) {
  let clean = String(rawLine || '').trim();
  if (!clean || clean.startsWith('```') || clean === '[' || clean === ']' || clean === '],') {
    return [];
  }
  if (clean.startsWith('[') && clean.includes('{')) clean = clean.slice(1).trim();
  if (clean.endsWith(',')) clean = clean.slice(0, -1).trim();
  if (clean.endsWith(']') && !clean.startsWith('[')) clean = clean.slice(0, -1).trim();
  if (!clean) return [];

  try {
    return extractNdjsonEntriesFromObject(JSON.parse(clean));
  } catch (_) {
    const results = [];
    let start = clean.indexOf('{');
    while (start !== -1) {
      let depth = 0;
      let inStr = false;
      let escaped = false;
      let end = -1;
      for (let i = start; i < clean.length; i++) {
        const ch = clean[i];
        if (inStr) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) break;
      try {
        results.push(...extractNdjsonEntriesFromObject(JSON.parse(clean.slice(start, end + 1))));
      } catch (_) {}
      start = clean.indexOf('{', end + 1);
    }
    return results;
  }
}

function extractStreamTextDelta(protocol, chunkObj) {
  if (!chunkObj || typeof chunkObj !== 'object') return '';
  if (protocol === 'gemini') {
    const parts = chunkObj?.candidates?.[0]?.content?.parts || [];
    let out = '';
    for (const part of parts) {
      if (part && !part.thought && typeof part.text === 'string') {
        out += part.text;
      }
    }
    return out;
  }
  if (protocol === 'anthropic') {
    if (chunkObj.type === 'message' && Array.isArray(chunkObj.content)) {
      return chunkObj.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    }
    return extractAnthropicStreamDelta(chunkObj).text;
  }
  const choice = chunkObj?.choices?.[0];
  if (!choice) return '';
  if (typeof choice?.delta?.content === 'string') return choice.delta.content;
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  return '';
}

function buildGeminiRequestBody(settings, messages) {
  const systemMsg = messages.find((m) => m.role === 'system');
  const userMsgs = messages.filter((m) => m.role !== 'system');
  const normModel = String(settings.model || '').replace(/^models\//i, '').trim().toLowerCase();
  const isGemini3Or4 = /^gemini-(?:3|4)(?:[.\-]|$)/.test(normModel);

  const generationConfig = {};
  if (!isGemini3Or4) {
    generationConfig.temperature = Number(settings.temperature ?? 0.2);
  }
  const thinkingConfig = resolveThinkingConfig(settings.model, settings.thinkingEffort || 'fastest');
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const body = {
    contents: userMsgs.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    generationConfig
  };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }
  return body;
}

function buildOpenAIRequestBody(settings, endpoint, messages, stream = true) {
  const model = String(settings.model || '').trim();
  const isReasoning = /^o[134](?:-|$)|deepseek-reasoner|^r1\b/i.test(model);
  const body = {
    model,
    messages,
    stream: Boolean(stream)
  };
  if (!isReasoning) {
    body.temperature = Number(settings.temperature ?? 0.2);
  }
  if ((settings.thinkingEffort || 'fastest') === 'fastest' && /^qwen3/i.test(model) && /dashscope/i.test(endpoint)) {
    body.enable_thinking = false;
  }
  return body;
}

async function streamTranslateBatchWithCache(
  settings,
  items,
  docTitle,
  onItem,
  signal,
  { allowEchoRetry = true } = {}
) {
  if (!items || items.length === 0) return;

  const cleanKey = sanitizeApiKey(settings.apiKey);
  if (!cleanKey && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.baseUrl || '')) {
    const err = new Error('請先在「⚙ 模型與 API 設定」填入 API Key（或從電腦端掃描 QR Code 同步）');
    err.errorCode = 'NO_API_KEY';
    throw err;
  }
  if (!String(settings.model || '').trim()) {
    const err = new Error('請先在「⚙ 模型與 API 設定」選擇模型（服務商已不再預設猜測的模型名稱）');
    err.errorCode = 'NO_MODEL';
    throw err;
  }

  const langInfo = resolveTargetLanguage(settings);
  const sig = buildCacheSignature(settings);
  const cacheKeys = items.map((it) => `${sig}::${it.key}`);
  const cachedHits = await cacheGetMany(cacheKeys);

  const uncachedItems = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const hit = cachedHits.get(cacheKeys[i]);
    if (hit && !isUntranslatedEcho(item.text, hit, langInfo.id)) {
      onItem(item.key, hit, true);
    } else {
      uncachedItems.push(item);
    }
  }

  if (uncachedItems.length === 0) return;

  const endpoint = resolveStreamEndpoint(settings);
  const payload = uncachedItems.map((it, idx) => ({ i: idx, text: it.text }));
  const messages = [
    { role: 'system', content: buildStreamSystemPrompt(settings, docTitle) },
    { role: 'user', content: JSON.stringify(payload) }
  ];

  const headers = buildProviderAuthHeaders(settings, cleanKey);
  let bodyObj;
  if (settings.protocol === 'gemini') {
    bodyObj = buildGeminiRequestBody(settings, messages);
  } else if (settings.protocol === 'anthropic') {
    bodyObj = buildAnthropicMessagesBody(settings, messages, { stream: true, maxTokens: 32000 });
  } else {
    bodyObj = buildOpenAIRequestBody(settings, endpoint, messages, true);
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
    signal
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200) || response.statusText}`);
  }

  const emittedIndices = new Set();
  const toCache = [];
  const echoedItems = [];

  const handleDecodedLine = (line) => {
    const entries = parseNdjsonLine(line);
    for (const entry of entries) {
      if (entry.idx >= 0 && entry.idx < uncachedItems.length && !emittedIndices.has(entry.idx)) {
        emittedIndices.add(entry.idx);
        const item = uncachedItems[entry.idx];
        const isEcho = isUntranslatedEcho(item.text, entry.text, langInfo.id);
        if (isEcho && allowEchoRetry) {
          echoedItems.push(item);
          continue;
        }
        onItem(item.key, entry.text, false);
        if (!isEcho) {
          toCache.push({ key: `${sig}::${item.key}`, zh: entry.text });
        }
      }
    }
  };

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!response.body || (contentType.includes('application/json') && !contentType.includes('event-stream'))) {
    const data = await response.json();
    const fullText = Array.isArray(data)
      ? data.map((c) => extractStreamTextDelta(settings.protocol, c)).join('')
      : extractStreamTextDelta(settings.protocol, data);
    for (const line of String(fullText || '').split('\n')) {
      handleDecodedLine(line);
    }
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let ndjsonBuffer = '';

    const processSseLine = (rawSseLine) => {
      const line = rawSseLine.trim();
      if (!line.startsWith('data:')) return;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') return;
      try {
        const chunkObj = JSON.parse(dataStr);
        const delta = extractStreamTextDelta(settings.protocol, chunkObj);
        if (delta) {
          ndjsonBuffer += delta;
          let nlIdx;
          while ((nlIdx = ndjsonBuffer.indexOf('\n')) !== -1) {
            const completeLine = ndjsonBuffer.slice(0, nlIdx);
            ndjsonBuffer = ndjsonBuffer.slice(nlIdx + 1);
            handleDecodedLine(completeLine);
          }
        }
      } catch (_) {}
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = sseBuffer.indexOf('\n')) !== -1) {
        const sseLine = sseBuffer.slice(0, nl);
        sseBuffer = sseBuffer.slice(nl + 1);
        processSseLine(sseLine);
      }
    }
    if (sseBuffer.trim()) processSseLine(sseBuffer);
    if (ndjsonBuffer.trim()) handleDecodedLine(ndjsonBuffer);
  }

  if (toCache.length > 0) {
    await cachePutMany(toCache);
    updateCacheCountUI();
  }

  if (echoedItems.length > 0 && allowEchoRetry && !signal?.aborted) {
    await streamTranslateBatchWithCache(settings, echoedItems, docTitle, onItem, signal, {
      allowEchoRetry: false
    });
  }
}

// ============================================================
// 5. DOM References & App State
// ============================================================
const dom = {
  syncBanner: document.getElementById('syncBanner'),
  syncBannerText: document.getElementById('syncBannerText'),
  syncBannerClose: document.getElementById('syncBannerClose'),

  globalStatusBadge: document.getElementById('globalStatusBadge'),
  globalStatusText: document.getElementById('globalStatusText'),
  globalLangSelect: document.getElementById('globalLangSelect'),

  tabPanels: {
    pdf: document.getElementById('tab-pdf'),
    web: document.getElementById('tab-web'),
    install: document.getElementById('tab-install'),
    settings: document.getElementById('tab-settings')
  },
  navButtons: Array.from(document.querySelectorAll('.nr-nav-tab')),

  // PDF Tab
  pdfModeSegmented: document.getElementById('pdfModeSegmented'),
  pdfPageIndicator: document.getElementById('pdfPageIndicator'),
  pdfZoomOutBtn: document.getElementById('pdfZoomOutBtn'),
  pdfZoomResetBtn: document.getElementById('pdfZoomResetBtn'),
  pdfZoomInBtn: document.getElementById('pdfZoomInBtn'),
  pdfOpenFileTopBtn: document.getElementById('pdfOpenFileTopBtn'),
  pdfFileInput: document.getElementById('pdfFileInput'),
  pdfEmptyState: document.getElementById('pdfEmptyState'),
  pdfEmptyOpenBtn: document.getElementById('pdfEmptyOpenBtn'),
  pdfUrlForm: document.getElementById('pdfUrlForm'),
  pdfUrlInput: document.getElementById('pdfUrlInput'),
  pdfLoadingState: document.getElementById('pdfLoadingState'),
  pdfLoadingTitle: document.getElementById('pdfLoadingTitle'),
  pdfLoadingSub: document.getElementById('pdfLoadingSub'),
  pdfErrorState: document.getElementById('pdfErrorState'),
  pdfErrorTitle: document.getElementById('pdfErrorTitle'),
  pdfErrorDetail: document.getElementById('pdfErrorDetail'),
  pdfRetryUrlBtn: document.getElementById('pdfRetryUrlBtn'),
  pdfErrorOpenFileBtn: document.getElementById('pdfErrorOpenFileBtn'),
  pdfOpenSourceBtn: document.getElementById('pdfOpenSourceBtn'),
  pdfPagesContainer: document.getElementById('pdfPagesContainer'),

  // Web Tab
  webModeSegmented: document.getElementById('webModeSegmented'),
  webFontSegmented: document.getElementById('webFontSegmented'),
  webUrlForm: document.getElementById('webUrlForm'),
  webUrlInput: document.getElementById('webUrlInput'),
  webRawInput: document.getElementById('webRawInput'),
  webClearRawBtn: document.getElementById('webClearRawBtn'),
  webTranslateRawBtn: document.getElementById('webTranslateRawBtn'),
  webArticleCard: document.getElementById('webArticleCard'),
  webArticleSource: document.getElementById('webArticleSource'),
  webArticleProgress: document.getElementById('webArticleProgress'),
  webArticleTitle: document.getElementById('webArticleTitle'),
  webArticleBody: document.getElementById('webArticleBody'),

  // Install Tab
  bookmarkletCodeBox: document.getElementById('bookmarkletCodeBox'),
  copyBookmarkletBtn: document.getElementById('copyBookmarkletBtn'),

  // Settings Tab
  settingsForm: document.getElementById('settingsForm'),
  setProvider: document.getElementById('setProvider'),
  setProviderHint: document.getElementById('setProviderHint'),
  setApiKey: document.getElementById('setApiKey'),
  toggleApiKeyVisBtn: document.getElementById('toggleApiKeyVisBtn'),
  setModel: document.getElementById('setModel'),
  modelChipsRow: document.getElementById('modelChipsRow'),
  setBaseUrl: document.getElementById('setBaseUrl'),
  setTargetLang: document.getElementById('setTargetLang'),
  customLangField: document.getElementById('customLangField'),
  setCustomTargetLang: document.getElementById('setCustomTargetLang'),
  setThinkingEffort: document.getElementById('setThinkingEffort'),
  setTypographyMatch: document.getElementById('setTypographyMatch'),
  setGlossary: document.getElementById('setGlossary'),
  testApiBtn: document.getElementById('testApiBtn'),
  clearCacheBtn: document.getElementById('clearCacheBtn'),
  cacheCountLabel: document.getElementById('cacheCountLabel'),
  settingsTestResult: document.getElementById('settingsTestResult'),

  // Compare Sheet
  comparePopover: document.getElementById('comparePopover'),
  compareOrigText: document.getElementById('compareOrigText'),
  compareTransText: document.getElementById('compareTransText'),
  copyOrigBtn: document.getElementById('copyOrigBtn'),
  copyTransBtn: document.getElementById('copyTransBtn'),
  compareCloseBtn: document.getElementById('compareCloseBtn')
};

const state = {
  settings: loadSettings(),
  activeTab: 'pdf',
  pdfMode: 'overlay',
  zoom: 1.0,
  baseFitScale: 1.0,
  docLoadToken: 0,
  translationEpoch: 0,

  pdfDoc: null,
  numPages: 0,
  currentPage: 1,
  docTitle: '',
  sourceUrl: '',
  defaultPageWidth: 612,
  defaultPageHeight: 792,

  pages: new Map(),
  translations: new Map(),
  mathPlaceholdersByKey: new Map(),
  skippedEchoKeys: new Set(),
  cachedKeys: new Set(),
  lastError: '',
  lastErrorCode: '',

  renderObserver: null,
  pageTrackObserver: null,
  activeAbortControllers: new Set(),

  activeCompareAnchor: null,
  activeComparePara: null,

  webAbortController: null
};

// ============================================================
// 6. Navigation, Banner & Global Status UI
// ============================================================
function showSyncBanner(message) {
  dom.syncBannerText.textContent = message;
  dom.syncBanner.hidden = false;
}

function switchTab(tabId) {
  if (!dom.tabPanels[tabId]) return;
  state.activeTab = tabId;
  for (const [id, panel] of Object.entries(dom.tabPanels)) {
    const active = id === tabId;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  }
  for (const btn of dom.navButtons) {
    btn.classList.toggle('is-active', btn.dataset.tab === tabId);
  }
  closeComparePopover();
}

function setGlobalStatus(statusState, text) {
  dom.globalStatusBadge.dataset.state = statusState;
  dom.globalStatusText.textContent = text;
  dom.globalStatusText.title = text;
}

function applyRootLanguageFonts(settings) {
  const lang = resolveTargetLanguage(settings);
  document.documentElement.style.setProperty('--nr-font-serif', lang.serifFontStack);
  document.documentElement.style.setProperty('--nr-font-sans', lang.sansFontStack);
  document.documentElement.style.setProperty('--nr-font-mono', lang.monoFontStack);
}

function populateLanguageDropdowns() {
  const currentLang = state.settings.targetLang || 'zh-TW';
  for (const selectEl of [dom.globalLangSelect, dom.setTargetLang]) {
    selectEl.replaceChildren();
    for (const [id, info] of Object.entries(TARGET_LANGUAGES)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id === 'custom' && state.settings.customTargetLang
        ? `自訂 (${state.settings.customTargetLang})`
        : info.label;
      selectEl.appendChild(opt);
    }
    selectEl.value = TARGET_LANGUAGES[currentLang] ? currentLang : 'zh-TW';
  }
}

// ============================================================
// 7. PDF Reader & Geometric Paragraph Engine (Tab 1)
// ============================================================
function showPdfStage(stage) {
  dom.pdfEmptyState.hidden = stage !== 'empty';
  dom.pdfLoadingState.hidden = stage !== 'loading';
  dom.pdfErrorState.hidden = stage !== 'error';
  dom.pdfPagesContainer.hidden = stage !== 'pages';
}

function computeOverlayBox(para, viewport) {
  const padX = para.isCompactLabel ? 1.5 : 2.5;
  const padY = para.isCompactLabel ? 0.5 : 1.0;
  const left = Math.max(0, para.x - padX);
  const top = Math.max(0, para.y - padY);
  const width = Math.min(viewport.width - left, para.w + padX * 2);
  const minHeight = para.h + padY * 2;
  const maxHeight = Math.max(minHeight, para.maxAllowedHeight + padY);
  return { left, top, width, minHeight, maxHeight };
}

function updatePdfStatusBadge() {
  if (state.lastError) {
    setGlobalStatus('error', state.lastError);
    return;
  }
  if (!state.pdfDoc) {
    setGlobalStatus('idle', '就緒');
    return;
  }
  let total = 0;
  let translated = 0;
  let active = 0;
  for (const pageRec of state.pages.values()) {
    if (pageRec.translationInFlight) active += 1;
    for (const para of pageRec.translatableParagraphs || []) {
      total += 1;
      if (state.translations.has(para.key) || state.skippedEchoKeys.has(para.key)) translated += 1;
    }
  }
  if (active > 0) {
    setGlobalStatus('streaming', total > 0 ? `翻譯中 ${translated}/${total}` : '串流翻譯中...');
  } else if (translated > 0) {
    setGlobalStatus('done', `已譯 ${translated} 段`);
  } else {
    setGlobalStatus('idle', `共 ${state.numPages} 頁`);
  }
}

function setPdfMode(nextMode) {
  if (!['overlay', 'split', 'original'].includes(nextMode)) return;
  state.pdfMode = nextMode;
  dom.tabPanels.pdf.dataset.mode = nextMode;
  closeComparePopover();

  for (const btn of dom.pdfModeSegmented.querySelectorAll('.nr-seg-btn')) {
    const active = btn.dataset.mode === nextMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  if (nextMode === 'overlay') {
    requestAnimationFrame(() => {
      for (const pageRec of state.pages.values()) {
        if (!pageRec.needsOverlayRefit || !pageRec.viewport) continue;
        pageRec.needsOverlayRefit = false;
        for (const para of pageRec.translatableParagraphs || []) {
          const el = pageRec.overlayById.get(para.id);
          if (!el) continue;
          const box = computeOverlayBox(para, pageRec.viewport);
          fitOverlayTypography(el, para, box.maxHeight, box.width);
        }
      }
    });
  }
}

// PDF extraction/math/sampling helpers live in ./pdf-layout.mjs

function fitOverlayTypography(el, para, maxHeight, boxWidth) {
  const startScale = para.isHeading ? 0.96 : 0.94;
  const minFs = Math.max(7.5, para.fontSize * 0.58);
  let fs = Math.max(minFs, para.fontSize * startScale);
  let lh = para.lineCount === 1 ? 1.24 : Math.max(1.22, Math.min(1.46, para.avgLineHeightRatio));

  el.style.fontSize = `${fs.toFixed(2)}px`;
  el.style.lineHeight = lh.toFixed(2);
  el.style.maxHeight = '';
  el.classList.remove('is-clipped');

  const fits = () => el.scrollHeight <= maxHeight + 1 && el.scrollWidth <= boxWidth + 2;
  let guard = 0;
  while (!fits() && fs > minFs + 0.15 && guard < 18) {
    fs = Math.max(minFs, fs * 0.92);
    if (lh > 1.18) lh = Math.max(1.18, lh - 0.03);
    el.style.fontSize = `${fs.toFixed(2)}px`;
    el.style.lineHeight = lh.toFixed(2);
    guard += 1;
  }
  if (el.scrollHeight > maxHeight + 2) {
    el.style.maxHeight = `${Math.ceil(maxHeight)}px`;
    el.classList.add('is-clipped');
  }
}

function renderParagraphOverlay(pageRec, para, zh) {
  if (!pageRec.overlayLayer || !pageRec.viewport) return;
  const langInfo = resolveTargetLanguage(state.settings);
  const cleanedZh = cleanLatexMathInText(zh);
  const targetLangId = state.settings?.targetLang || 'zh-TW';

  if (isUntranslatedEcho(para.text, cleanedZh, targetLangId) || isOverlayNoOp(para.text, cleanedZh)) {
    const staleEl = pageRec.overlayById.get(para.id);
    if (staleEl) {
      staleEl.remove();
      pageRec.overlayById.delete(para.id);
    }
    return;
  }

  const box = computeOverlayBox(para, pageRec.viewport);

  let el = pageRec.overlayById.get(para.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'nr-pdf-para';
    el.dataset.paraId = String(para.id);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleComparePopover(el, para, state.translations.get(para.key) || cleanedZh);
    });
    pageRec.overlayLayer.appendChild(el);
    pageRec.overlayById.set(para.id, el);
  }

  const colors = para.colors || { bg: '#ffffff', fg: '#111827', isDarkBg: false };
  el.textContent = cleanedZh;
  el.style.left = `${box.left.toFixed(1)}px`;
  el.style.top = `${box.top.toFixed(1)}px`;
  el.style.width = `${box.width.toFixed(1)}px`;
  el.style.minHeight = `${box.minHeight.toFixed(1)}px`;
  el.style.backgroundColor = colors.bg;
  el.style.color = colors.fg;
  el.style.fontFamily = para.isSerif ? langInfo.serifFontStack : langInfo.sansFontStack;
  el.style.fontWeight = (para.isBold || para.isHeading) ? '700' : '400';
  el.style.textAlign = (para.lineCount === 1 && para.isCentered && (para.isHeading || para.isBold)) ? 'center' : '';
  el.classList.toggle('is-dark-bg', Boolean(colors.isDarkBg));
  el.classList.toggle('is-compact-label', Boolean(para.isCompactLabel));

  if (state.pdfMode !== 'overlay') {
    pageRec.needsOverlayRefit = true;
  } else {
    fitOverlayTypography(el, para, box.maxHeight, box.width);
  }
}

function buildSplitCardSkeleton(pageRec) {
  const body = pageRec.splitBody;
  if (!body) return;
  body.replaceChildren();
  pageRec.splitElById.clear();

  const langInfo = resolveTargetLanguage(state.settings);
  if (pageRec.translatableParagraphs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'nr-split-empty';
    empty.textContent = '此頁無可翻譯正文段落。';
    body.appendChild(empty);
    pageRec.splitStatusEl.textContent = '無需翻譯';
    return;
  }

  for (const para of pageRec.translatableParagraphs) {
    const pEl = document.createElement(para.isHeading ? 'h3' : 'p');
    pEl.className = 'nr-split-para is-pending';
    if (para.isHeading) pEl.classList.add('is-heading');
    pEl.style.fontFamily = para.isSerif ? langInfo.serifFontStack : langInfo.sansFontStack;
    pEl.textContent = para.text;
    pEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const translated = state.translations.get(para.key);
      if (translated) toggleComparePopover(pEl, para, translated);
    });
    body.appendChild(pEl);
    pageRec.splitElById.set(para.id, pEl);
  }

  pageRec.splitStatusEl.textContent = `待翻譯 0 / ${pageRec.translatableParagraphs.length}`;
}

function updateSplitParagraph(pageRec, para, zh) {
  const pEl = pageRec.splitElById.get(para.id);
  if (!pEl) return;
  const langInfo = resolveTargetLanguage(state.settings);
  pEl.textContent = cleanLatexMathInText(zh);
  pEl.classList.remove('is-pending');
  pEl.style.fontFamily = para.isSerif ? langInfo.serifFontStack : langInfo.sansFontStack;

  const doneCount = pageRec.translatableParagraphs.reduce(
    (acc, item) => acc + ((state.translations.has(item.key) || state.skippedEchoKeys.has(item.key)) ? 1 : 0),
    0
  );
  const total = pageRec.translatableParagraphs.length;
  pageRec.splitStatusEl.textContent = doneCount >= total
    ? `已完成 ${total} 段`
    : `翻譯中 ${doneCount} / ${total}`;
}

function applyTranslationToPage(pageRec, key, zh) {
  const matched = pageRec.paragraphsByKey.get(key);
  if (!matched) return;
  for (const para of matched) {
    renderParagraphOverlay(pageRec, para, zh);
    updateSplitParagraph(pageRec, para, zh);
  }
}

function closeComparePopover() {
  dom.comparePopover.hidden = true;
  if (state.activeCompareAnchor) {
    state.activeCompareAnchor.classList.remove('is-active-compare');
    state.activeCompareAnchor = null;
  }
  state.activeComparePara = null;
}

function toggleComparePopover(anchorEl, para, translatedText) {
  if (state.activeCompareAnchor === anchorEl && !dom.comparePopover.hidden) {
    closeComparePopover();
    return;
  }
  if (state.activeCompareAnchor) {
    state.activeCompareAnchor.classList.remove('is-active-compare');
  }
  state.activeCompareAnchor = anchorEl;
  state.activeComparePara = { orig: para.text, trans: translatedText };
  anchorEl.classList.add('is-active-compare');

  const langInfo = resolveTargetLanguage(state.settings);
  dom.compareOrigText.textContent = para.text;
  dom.compareTransText.textContent = translatedText;
  dom.compareTransText.style.fontFamily = para.isSerif ? langInfo.serifFontStack : langInfo.sansFontStack;
  dom.comparePopover.hidden = false;
}

function buildPageBatches(items) {
  const maxCount = Math.max(1, Number(state.settings?.batchSize || 18));
  const maxChars = Math.max(800, Number(state.settings?.maxBatchChars || 5000));
  const batches = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    if (current.length >= maxCount || (current.length > 0 && chars + item.text.length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function translatePageParagraphs(pageRec, epoch) {
  if (epoch !== state.translationEpoch) return;
  if (pageRec.translationInFlight || pageRec.translatedEpoch === epoch) return;

  const targetLangId = state.settings?.targetLang || 'zh-TW';
  const viewportWidth = pageRec.viewport?.width || 600;
  const translatable = pageRec.allParagraphs.filter((para) =>
    shouldTranslatePdfText(para.text, targetLangId, {
      isHeading: para.isHeading,
      isMono: para.isMono,
      lineCount: para.lineCount,
      widthRatio: para.w / Math.max(1, viewportWidth),
      mathFontRatio: para.mathFontRatio,
      isCentered: para.isCentered,
      endsWithEqNum: para.endsWithEqNum
    })
  );

  pageRec.translatableParagraphs = translatable;
  pageRec.paragraphsByKey.clear();
  for (const para of translatable) {
    if (!pageRec.paragraphsByKey.has(para.key)) {
      pageRec.paragraphsByKey.set(para.key, []);
    }
    pageRec.paragraphsByKey.get(para.key).push(para);
  }

  buildSplitCardSkeleton(pageRec);

  if (translatable.length === 0) {
    pageRec.translatedEpoch = epoch;
    updatePdfStatusBadge();
    return;
  }

  const uncachedByKey = new Map();
  const reqKeyToParaKey = new Map();
  for (const para of translatable) {
    const existing = state.translations.get(para.key);
    if (existing) {
      applyTranslationToPage(pageRec, para.key, existing);
      continue;
    }
    if (state.skippedEchoKeys.has(para.key)) {
      const pEl = pageRec.splitElById.get(para.id);
      if (pEl) pEl.classList.remove('is-pending');
      continue;
    }
    const protectedRes = protectInlineMath(para.text);
    para.mathPlaceholders = protectedRes.placeholders;
    if (protectedRes.placeholders.size > 0) {
      state.mathPlaceholdersByKey.set(para.key, protectedRes.placeholders);
    }
    if (!uncachedByKey.has(para.key)) {
      const reqKey = protectedRes.placeholders.size > 0
        ? `${para.key}_m${hashText(protectedRes.text)}`
        : para.key;
      reqKeyToParaKey.set(reqKey, para.key);
      uncachedByKey.set(para.key, { key: reqKey, text: protectedRes.text });
    }
  }

  const toRequest = Array.from(uncachedByKey.values());
  if (toRequest.length === 0) {
    pageRec.translatedEpoch = epoch;
    updatePdfStatusBadge();
    return;
  }

  pageRec.translationInFlight = true;
  state.lastError = '';
  updatePdfStatusBadge();

  const controller = new AbortController();
  state.activeAbortControllers.add(controller);

  const markEchoSettledOnPages = (key) => {
    for (const p of state.pages.values()) {
      const matched = p.paragraphsByKey.get(key);
      if (!matched) continue;
      for (const mp of matched) {
        const sEl = p.splitElById.get(mp.id);
        if (sEl) sEl.classList.remove('is-pending');
      }
      const done = p.translatableParagraphs.reduce(
        (acc, it) => acc + ((state.translations.has(it.key) || state.skippedEchoKeys.has(it.key)) ? 1 : 0),
        0
      );
      if (p.splitStatusEl) {
        const total = p.translatableParagraphs.length;
        p.splitStatusEl.textContent = done >= total ? `已完成 ${total} 段` : `翻譯中 ${done} / ${total}`;
      }
    }
  };

  const onItemArrived = (reqKey, zh, cached) => {
    if (epoch !== state.translationEpoch) return;
    const key = reqKeyToParaKey.get(reqKey) || reqKey;
    let samplePara = pageRec.paragraphsByKey.get(key)?.[0] || null;
    if (!samplePara) {
      for (const other of state.pages.values()) {
        const hit = other.paragraphsByKey.get(key)?.[0];
        if (hit) {
          samplePara = hit;
          break;
        }
      }
    }
    const placeholders = state.mathPlaceholdersByKey.get(key) || samplePara?.mathPlaceholders;
    const restored = restoreMathPlaceholders(zh, placeholders);
    const cleanZh = cleanLatexMathInText(restored);
    if (samplePara && isUntranslatedEcho(samplePara.text, cleanZh, targetLangId)) {
      state.skippedEchoKeys.add(key);
      markEchoSettledOnPages(key);
      updatePdfStatusBadge();
      return;
    }
    state.translations.set(key, cleanZh);
    if (cached) state.cachedKeys.add(key);
    applyTranslationToPage(pageRec, key, cleanZh);
    for (const other of state.pages.values()) {
      if (other !== pageRec && other.paragraphsByKey.has(key)) {
        applyTranslationToPage(other, key, cleanZh);
      }
    }
    updatePdfStatusBadge();
  };

  try {
    const batches = buildPageBatches(toRequest);
    for (const batch of batches) {
      if (epoch !== state.translationEpoch) return;
      await streamTranslateBatchWithCache(
        state.settings,
        batch,
        state.docTitle,
        onItemArrived,
        controller.signal
      );
    }
    if (epoch === state.translationEpoch) {
      pageRec.translatedEpoch = epoch;
    }
  } catch (err) {
    if (controller.signal.aborted || epoch !== state.translationEpoch) return;
    state.lastError = err?.message || '翻譯失敗';
    state.lastErrorCode = err?.errorCode || '';
  } finally {
    state.activeAbortControllers.delete(controller);
    pageRec.translationInFlight = false;
    updatePdfStatusBadge();
  }
}

async function renderAndTranslatePage(pageNum, { forceCanvas = false } = {}) {
  const pageRec = state.pages.get(pageNum);
  const pdfDoc = state.pdfDoc;
  if (!pageRec || !pdfDoc) return;

  const loadToken = state.docLoadToken;
  const targetScale = state.baseFitScale * state.zoom;
  const needsCanvas = forceCanvas || !pageRec.rendered || Math.abs(pageRec.renderedScale - targetScale) > 0.005;

  if (needsCanvas) {
    const renderSeq = (pageRec.renderSeq || 0) + 1;
    pageRec.renderSeq = renderSeq;

    if (pageRec.renderTask) {
      try {
        pageRec.renderTask.cancel();
        await pageRec.renderTask.promise.catch(() => {});
      } catch (_) {}
      pageRec.renderTask = null;
      if (renderSeq !== pageRec.renderSeq || loadToken !== state.docLoadToken) return;
    }

    try {
      const pdfPage = await pdfDoc.getPage(pageNum);
      if (renderSeq !== pageRec.renderSeq || loadToken !== state.docLoadToken) return;

      const viewport = pdfPage.getViewport({ scale: targetScale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.25);

      pageRec.sheetEl.style.width = `${viewport.width}px`;
      pageRec.sheetEl.style.height = `${viewport.height}px`;

      const canvas = pageRec.canvasEl;
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const renderTask = pdfPage.render({ canvasContext: ctx, viewport });
      pageRec.renderTask = renderTask;
      await renderTask.promise;
      if (renderSeq !== pageRec.renderSeq || loadToken !== state.docLoadToken) return;

      pageRec.renderTask = null;
      pageRec.rendered = true;
      pageRec.renderedScale = targetScale;
      pageRec.viewport = viewport;
      pageRec.loaderEl.hidden = true;

      let pageImageData = null;
      try {
        pageImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch (_) {}

      const textContent = await pdfPage.getTextContent();
      if (renderSeq !== pageRec.renderSeq || loadToken !== state.docLoadToken) return;

      const paragraphs = extractPdfParagraphs(textContent, viewport, {
        commonObjs: pdfPage.commonObjs,
        transformFn: pdfjsLib.Util.transform,
        hashFn: hashText
      });
      for (let i = 0; i < paragraphs.length; i++) {
        paragraphs[i].id = `p${pageNum}_${i}`;
        paragraphs[i].colors = sampleParagraphColors(
          pageImageData,
          paragraphs[i],
          viewport.width,
          viewport.height,
          canvas.width,
          canvas.height
        );
      }
      refineMaxHeightWithCanvasInk(
        pageImageData,
        paragraphs,
        viewport.width,
        viewport.height,
        canvas.width,
        canvas.height
      );

      pageRec.allParagraphs = paragraphs;
      pageRec.overlayLayer.replaceChildren();
      pageRec.overlayById.clear();

      if (pageRec.translatedEpoch === state.translationEpoch || pageRec.translationInFlight) {
        const targetLangId = state.settings?.targetLang || 'zh-TW';
        pageRec.translatableParagraphs = paragraphs.filter((para) =>
          shouldTranslatePdfText(para.text, targetLangId, {
            isHeading: para.isHeading,
            isMono: para.isMono,
            lineCount: para.lineCount,
            widthRatio: para.w / Math.max(1, viewport.width),
            mathFontRatio: para.mathFontRatio,
            isCentered: para.isCentered,
            endsWithEqNum: para.endsWithEqNum
          })
        );
        pageRec.paragraphsByKey.clear();
        for (const para of pageRec.translatableParagraphs) {
          if (!pageRec.paragraphsByKey.has(para.key)) {
            pageRec.paragraphsByKey.set(para.key, []);
          }
          pageRec.paragraphsByKey.get(para.key).push(para);
          para.mathPlaceholders = state.mathPlaceholdersByKey.get(para.key) || protectInlineMath(para.text).placeholders;
          const zh = state.translations.get(para.key);
          if (zh) renderParagraphOverlay(pageRec, para, zh);
        }
        return;
      }
    } catch (err) {
      if (err?.name === 'RenderingCancelledException') return;
      console.warn(`[NativeRead PWA PDF] Page ${pageNum} render error:`, err);
      return;
    }
  }

  await translatePageParagraphs(pageRec, state.translationEpoch);
}

function buildPdfPageShells(numPages, defaultWidth, defaultHeight) {
  dom.pdfPagesContainer.replaceChildren();
  state.pages.clear();

  const cssW = Math.round(defaultWidth * state.baseFitScale * state.zoom);
  const cssH = Math.round(defaultHeight * state.baseFitScale * state.zoom);
  const frag = document.createDocumentFragment();

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const row = document.createElement('section');
    row.className = 'nr-page-row';
    row.dataset.pageNum = String(pageNum);

    const canvasCol = document.createElement('div');
    canvasCol.className = 'nr-page-canvas-col';

    const sheet = document.createElement('div');
    sheet.className = 'nr-page-sheet';
    sheet.style.width = `${cssW}px`;
    sheet.style.height = `${cssH}px`;

    const canvas = document.createElement('canvas');
    canvas.className = 'nr-pdf-canvas';

    const overlayLayer = document.createElement('div');
    overlayLayer.className = 'nr-overlay-layer';

    const loader = document.createElement('div');
    loader.className = 'nr-page-loader';
    loader.textContent = `第 ${pageNum} 頁載入中...`;

    const badge = document.createElement('div');
    badge.className = 'nr-page-num-badge';
    badge.textContent = `P. ${pageNum}`;

    sheet.append(canvas, overlayLayer, loader, badge);
    canvasCol.appendChild(sheet);

    const splitCol = document.createElement('div');
    splitCol.className = 'nr-page-split-col';

    const splitCard = document.createElement('article');
    splitCard.className = 'nr-split-card';

    const splitHeader = document.createElement('div');
    splitHeader.className = 'nr-split-card-header';

    const splitTitle = document.createElement('span');
    splitTitle.textContent = `第 ${pageNum} 頁 · 譯文`;

    const splitStatus = document.createElement('span');
    splitStatus.className = 'nr-split-page-status';
    splitStatus.textContent = '等待捲動至此頁...';

    splitHeader.append(splitTitle, splitStatus);

    const splitBody = document.createElement('div');
    splitBody.className = 'nr-split-card-body';

    splitCard.append(splitHeader, splitBody);
    splitCol.appendChild(splitCard);

    row.append(canvasCol, splitCol);
    frag.appendChild(row);

    state.pages.set(pageNum, {
      pageNum,
      rowEl: row,
      sheetEl: sheet,
      canvasEl: canvas,
      overlayLayer,
      loaderEl: loader,
      splitBody,
      splitStatusEl: splitStatus,
      rendered: false,
      renderedScale: 0,
      renderTask: null,
      viewport: null,
      allParagraphs: [],
      translatableParagraphs: [],
      paragraphsByKey: new Map(),
      overlayById: new Map(),
      splitElById: new Map(),
      translatedEpoch: -1,
      translationInFlight: false,
      isVisible: false
    });
  }

  dom.pdfPagesContainer.appendChild(frag);
}

function setupPdfObservers() {
  if (state.renderObserver) state.renderObserver.disconnect();
  if (state.pageTrackObserver) state.pageTrackObserver.disconnect();

  state.renderObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNum = Number(entry.target.dataset.pageNum);
        const pageRec = state.pages.get(pageNum);
        if (!pageRec) continue;
        pageRec.isVisible = entry.isIntersecting;
        if (entry.isIntersecting) {
          renderAndTranslatePage(pageNum);
        }
      }
    },
    { rootMargin: '450px 0px', threshold: 0.01 }
  );

  state.pageTrackObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const p = Number(entry.target.dataset.pageNum);
          dom.pdfPageIndicator.hidden = false;
          dom.pdfPageIndicator.textContent = `${p} / ${state.numPages}`;
        }
      }
    },
    { rootMargin: '-20% 0px -60% 0px', threshold: 0.1 }
  );

  for (const pageRec of state.pages.values()) {
    state.renderObserver.observe(pageRec.rowEl);
    state.pageTrackObserver.observe(pageRec.rowEl);
  }
}

function hasPdfMagicHeader(uint8) {
  const limit = Math.min(uint8.length, 1024);
  for (let i = 0; i <= limit - 5; i++) {
    if (
      uint8[i] === 0x25 &&
      uint8[i + 1] === 0x50 &&
      uint8[i + 2] === 0x44 &&
      uint8[i + 3] === 0x46 &&
      uint8[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

async function openPdfFromArrayBuffer(arrayBuffer, { title, sourceUrl = '' }) {
  const loadToken = ++state.docLoadToken;
  state.translationEpoch += 1;
  for (const c of state.activeAbortControllers) c.abort();
  state.activeAbortControllers.clear();
  closeComparePopover();

  if (state.pdfDoc) {
    try {
      await state.pdfDoc.destroy();
    } catch (_) {}
    state.pdfDoc = null;
  }

  state.translations.clear();
  state.mathPlaceholdersByKey.clear();
  state.skippedEchoKeys.clear();
  state.cachedKeys.clear();
  state.lastError = '';
  state.docTitle = title || 'PDF Document';
  state.sourceUrl = sourceUrl;

  showPdfStage('loading');
  dom.pdfLoadingTitle.textContent = '正在解析 PDF 文件...';
  dom.pdfLoadingSub.textContent = state.docTitle;

  try {
    const bytes = new Uint8Array(arrayBuffer);
    if (!hasPdfMagicHeader(bytes)) {
      throw new Error('所載入的資料不是有效的 PDF 檔案。');
    }

    const loadingTask = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
    const pdfDoc = await loadingTask.promise;
    if (loadToken !== state.docLoadToken) {
      pdfDoc.destroy().catch(() => {});
      return;
    }

    state.pdfDoc = pdfDoc;
    state.numPages = pdfDoc.numPages;

    const firstPage = await pdfDoc.getPage(1);
    if (loadToken !== state.docLoadToken) return;

    const baseViewport = firstPage.getViewport({ scale: 1.0 });
    state.defaultPageWidth = baseViewport.width;
    state.defaultPageHeight = baseViewport.height;

    const availW = Math.min(840, Math.max(310, window.innerWidth - 28));
    state.baseFitScale = Math.max(0.48, Math.min(1.55, availW / Math.max(200, baseViewport.width)));
    state.zoom = 1.0;
    dom.pdfZoomResetBtn.textContent = '100%';

    buildPdfPageShells(pdfDoc.numPages, baseViewport.width, baseViewport.height);
    showPdfStage('pages');
    dom.pdfPageIndicator.hidden = false;
    dom.pdfPageIndicator.textContent = `1 / ${pdfDoc.numPages}`;
    updatePdfStatusBadge();
    setupPdfObservers();
  } catch (err) {
    if (loadToken !== state.docLoadToken) return;
    showPdfError('無法解析此 PDF 文件', err?.message || 'PDF 檔案可能已損毀或受密碼保護。', Boolean(sourceUrl));
  }
}

const PDF_FETCH_TIMEOUT_MS = 15000;

function extractGoogleDriveFileId(url) {
  if (!url || typeof url !== 'string') return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return '';
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'drive.google.com' && host !== 'docs.google.com') return '';
  const m = (parsed.pathname || '').match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  const qId = parsed.searchParams.get('id');
  if (qId && /^[a-zA-Z0-9_-]{10,}$/.test(qId)) return qId;
  return '';
}

function resolvePdfSourceUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const gdriveId = extractGoogleDriveFileId(url);
  if (gdriveId) {
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(gdriveId)}`;
  }
  return url;
}

function showPdfError(title, detail, canRetry, openUrl = '') {
  let safeOpenUrl = '';
  if (openUrl && typeof openUrl === 'string') {
    try {
      const parsed = new URL(openUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        safeOpenUrl = parsed.toString();
      }
    } catch (_) {}
  }

  state.pdfOpenSourceUrl = safeOpenUrl;
  showPdfStage('error');
  dom.pdfErrorTitle.textContent = title;
  dom.pdfErrorDetail.textContent = detail;
  dom.pdfRetryUrlBtn.hidden = !canRetry;
  if (dom.pdfOpenSourceBtn) {
    dom.pdfOpenSourceBtn.hidden = !safeOpenUrl;
  }
}

async function loadPdfFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (_) {
    showPdfError('PDF 連結無效', `無法辨識網址：${rawUrl || ''}`, false);
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    showPdfError('PDF 連結無效', '僅支援 http:// 或 https:// 開頭的 PDF 網址。', false);
    return;
  }

  const originalUrl = parsed.toString();
  const gdriveId = extractGoogleDriveFileId(originalUrl);
  const fetchUrl = resolvePdfSourceUrl(originalUrl);

  state.sourceUrl = originalUrl;
  showPdfStage('loading');
  dom.pdfLoadingTitle.textContent = '正在下載 PDF 文件...';
  dom.pdfLoadingSub.textContent = originalUrl;

  const controller = new AbortController();
  state.activeAbortControllers.add(controller);
  let timedOut = false;
  const timerId = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort();
    } catch (_) {}
  }, PDF_FETCH_TIMEOUT_MS);

  let buf;
  try {
    const res = await fetch(fetchUrl, { signal: controller.signal });
    if (!res.ok) {
      const httpErr = new Error(`HTTP ${res.status}`);
      httpErr.httpStatus = res.status;
      throw httpErr;
    }
    buf = await res.arrayBuffer();
  } catch (err) {
    if (controller.signal.aborted && !timedOut) {
      return;
    }
    if (timedOut) {
      showPdfError(
        '下載 PDF 逾時（超過 15 秒）',
        '伺服器回應過慢或檔案較大導致下載逾時。\n請點擊「重試網址」，或點擊「在新分頁開啟 PDF」將檔案下載至裝置後，再選擇本機 PDF 檔案。',
        true,
        originalUrl
      );
      return;
    }
    const reason = err?.httpStatus ? `伺服器回應 HTTP ${err.httpStatus}` : '受網站 CORS 跨域限制或網路連線中斷影響';
    showPdfError(
      '無法直接從此網址下載 PDF',
      `${reason}，瀏覽器無法直接讀取此檔案。\n請點擊下方「在新分頁開啟 PDF」，將 PDF 下載至手機或電腦後，再點擊「改選本機 PDF 檔案」即可進行原位翻譯。`,
      true,
      originalUrl
    );
    return;
  } finally {
    clearTimeout(timerId);
    state.activeAbortControllers.delete(controller);
  }

  if (controller.signal.aborted && !timedOut) {
    return;
  }

  if (!buf || !hasPdfMagicHeader(new Uint8Array(buf))) {
    const detail = gdriveId
      ? 'Google 雲端硬碟回傳了網頁而非 PDF 本體（常見於未開放「知道連結的任何人」權限、需要登入，或大型檔案觸發防毒掃描確認頁）。\n請點擊「在新分頁開啟 PDF」手動下載檔案後，再改選本機 PDF 檔案。'
      : '此網址回傳的內容不是有效的 PDF 檔案（可能是網頁、登入畫面或下載確認頁）。\n請點擊「在新分頁開啟 PDF」手動下載檔案後，再改選本機 PDF 檔案。';
    showPdfError('下載的內容不是 PDF 檔案', detail, true, originalUrl);
    return;
  }

  let fileName = '';
  if (gdriveId) {
    fileName = `GoogleDrive_${gdriveId.slice(0, 8)}.pdf`;
  } else {
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() || '';
    if (lastSegment) {
      try {
        fileName = decodeURIComponent(lastSegment);
      } catch (_) {
        fileName = lastSegment;
      }
    } else {
      fileName = parsed.hostname;
    }
  }

  try {
    await openPdfFromArrayBuffer(buf, { title: fileName, sourceUrl: originalUrl });
  } catch (err) {
    showPdfError(
      '無法開啟 PDF 檔案',
      `PDF 解析失敗（${err?.message || '檔案可能已損毀或受密碼保護'}）。\n請嘗試點擊「在新分頁開啟 PDF」確認檔案是否正常。`,
      true,
      originalUrl
    );
  }
}

async function loadPdfFromFile(file) {
  if (!file) return;
  showPdfStage('loading');
  dom.pdfLoadingTitle.textContent = '正在讀取手機 PDF 檔案...';
  dom.pdfLoadingSub.textContent = file.name;
  try {
    const buf = await file.arrayBuffer();
    await openPdfFromArrayBuffer(buf, { title: file.name.replace(/\.pdf$/i, '') });
  } catch (err) {
    showPdfError('無法讀取 PDF 檔案', err?.message || '讀取失敗', false);
  }
}

function stepPdfZoom(dir) {
  let idx = ZOOM_STEPS.findIndex((v) => Math.abs(v - state.zoom) < 0.02);
  if (idx === -1) idx = 2;
  const nextIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + dir));
  applyPdfZoom(ZOOM_STEPS[nextIdx]);
}

function applyPdfZoom(nextZoom) {
  state.zoom = nextZoom;
  dom.pdfZoomResetBtn.textContent = `${Math.round(state.zoom * 100)}%`;
  dom.pdfZoomOutBtn.disabled = state.zoom <= ZOOM_STEPS[0] + 0.001;
  dom.pdfZoomInBtn.disabled = state.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001;
  closeComparePopover();
  if (!state.pdfDoc) return;
  const nextScale = state.baseFitScale * state.zoom;
  const vh = window.innerHeight || 800;
  for (const pageRec of state.pages.values()) {
    pageRec.sheetEl.style.width = `${Math.round(state.defaultPageWidth * nextScale)}px`;
    pageRec.sheetEl.style.height = `${Math.round(state.defaultPageHeight * nextScale)}px`;
    const rect = pageRec.rowEl.getBoundingClientRect();
    const nearViewport = pageRec.isVisible || (rect.bottom >= -500 && rect.top <= vh + 500);
    if (nearViewport) {
      renderAndTranslatePage(pageRec.pageNum, { forceCanvas: true });
    } else {
      pageRec.rendered = false;
    }
  }
}

function abortAllActiveRequests() {
  for (const ctrl of state.activeAbortControllers) {
    try {
      ctrl.abort();
    } catch (_) {}
  }
  state.activeAbortControllers.clear();
}

function resetAndRetranslatePdf() {
  if (!state.pdfDoc) return;
  state.translationEpoch += 1;
  abortAllActiveRequests();
  closeComparePopover();
  state.translations.clear();
  state.mathPlaceholdersByKey.clear();
  state.skippedEchoKeys.clear();
  state.cachedKeys.clear();
  state.totalParagraphs = 0;
  state.translatedParagraphs = 0;
  state.lastError = '';
  state.lastErrorCode = '';

  for (const pageRec of state.pages.values()) {
    pageRec.translatedEpoch = -1;
    pageRec.translationRunSeq = (pageRec.translationRunSeq || 0) + 1;
    pageRec.translationInFlight = false;
    pageRec.overlayLayer.replaceChildren();
    pageRec.overlayById.clear();
    pageRec.splitBody.replaceChildren();
    pageRec.splitElById.clear();
    if (pageRec.splitStatusEl) pageRec.splitStatusEl.textContent = '重新翻譯中...';
  }
  updatePdfStatusBadge();

  const vh = window.innerHeight || 800;
  for (const pageRec of state.pages.values()) {
    const rect = pageRec.rowEl.getBoundingClientRect();
    const nearViewport = pageRec.isVisible || (rect.bottom >= -500 && rect.top <= vh + 500);
    if (nearViewport) {
      renderAndTranslatePage(pageRec.pageNum, { forceCanvas: false });
    }
  }
}

// ============================================================
// 8. Web URL & Raw Article Reader (Tab 2)
// ============================================================
function parseMarkdownOrTextBlocks(rawText, fallbackTitle = '外文文章翻譯') {
  const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
  let title = fallbackTitle;
  const blocks = [];
  let inCode = false;
  let codeLines = [];
  let paraLines = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    const joined = paraLines.join(' ').replace(/\s+/g, ' ').trim();
    paraLines = [];
    if (!joined) return;
    blocks.push({ kind: 'p', text: joined, key: hashText(joined) });
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        blocks.push({ kind: 'code', text: codeLines.join('\n') });
        codeLines = [];
        inCode = false;
      } else {
        flushPara();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }
    if (!trimmed) {
      flushPara();
      continue;
    }
    if (/^Title:\s+/i.test(trimmed) && title === fallbackTitle) {
      title = trimmed.replace(/^Title:\s+/i, '').trim();
      continue;
    }
    if (/^(?:URL Source|Markdown Content|Published Time):/i.test(trimmed)) {
      continue;
    }
    const hMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      flushPara();
      const hText = hMatch[2].trim();
      if (hMatch[1].length === 1 && title === fallbackTitle) {
        title = hText;
      } else if (hText) {
        blocks.push({ kind: 'heading', text: hText, key: hashText(hText) });
      }
      continue;
    }
    paraLines.push(trimmed);
  }
  flushPara();
  if (codeLines.length > 0) {
    blocks.push({ kind: 'code', text: codeLines.join('\n') });
  }
  return { title, blocks };
}

async function fetchReadableArticleFromUrl(targetUrl) {
  // 1. Try r.jina.ai clean reader first
  try {
    const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: { Accept: 'text/plain' }
    });
    if (jinaRes.ok) {
      const txt = await jinaRes.text();
      if (txt && txt.trim().length > 80) {
        return parseMarkdownOrTextBlocks(txt, new URL(targetUrl).hostname);
      }
    }
  } catch (_) {}

  // 2. Fallback to AllOrigins HTML + DOMParser
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
  const htmlRes = await fetch(proxyUrl);
  if (!htmlRes.ok) {
    throw new Error(`無法擷取網頁 (HTTP ${htmlRes.status})`);
  }
  const html = await htmlRes.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = (doc.querySelector('h1')?.textContent || doc.title || new URL(targetUrl).hostname).trim();
  const root = doc.querySelector('article, main, [role="main"]') || doc.body;
  const blocks = [];

  for (const node of root.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre')) {
    if (node.closest('nav, footer, aside, script, style, noscript')) continue;
    if (node.tagName === 'PRE') {
      const codeTxt = (node.textContent || '').trim();
      if (codeTxt) blocks.push({ kind: 'code', text: codeTxt });
      continue;
    }
    const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt.length < 8) continue;
    const isH = /^H[1-4]$/.test(node.tagName);
    blocks.push({
      kind: isH ? 'heading' : 'p',
      text: txt,
      key: hashText(txt)
    });
  }

  return { title, blocks };
}

async function renderAndStreamWebArticle({ title, sourceLabel, blocks }) {
  state.currentWebArticle = { title, sourceLabel, blocks };
  if (state.webAbortController) {
    state.webAbortController.abort();
  }
  const controller = new AbortController();
  state.webAbortController = controller;

  dom.webArticleCard.hidden = false;
  dom.webArticleSource.textContent = sourceLabel || 'Reader';
  dom.webArticleTitle.textContent = title || '文章翻譯';
  dom.webArticleBody.replaceChildren();

  const translatableItems = [];
  const transNodesByKey = new Map();

  for (const blk of blocks) {
    if (blk.kind === 'code') {
      const pre = document.createElement('pre');
      pre.className = 'nr-web-code';
      pre.textContent = blk.text;
      dom.webArticleBody.appendChild(pre);
      continue;
    }

    const wrap = document.createElement(blk.kind === 'heading' ? 'h2' : 'div');
    wrap.className = `nr-web-block${blk.kind === 'heading' ? ' is-heading' : ''}`;

    const origSpan = document.createElement('div');
    origSpan.className = 'nr-web-orig';
    origSpan.textContent = blk.text;

    const transSpan = document.createElement('div');
    transSpan.className = 'nr-web-trans';
    transSpan.textContent = blk.text;

    wrap.append(origSpan, transSpan);
    dom.webArticleBody.appendChild(wrap);

    if (shouldTranslatePdfText(blk.text, state.settings.targetLang || 'zh-TW', { isHeading: blk.kind === 'heading' })) {
      if (!transNodesByKey.has(blk.key)) {
        transNodesByKey.set(blk.key, []);
        translatableItems.push({ key: blk.key, text: blk.text });
      }
      transNodesByKey.get(blk.key).push(transSpan);
    }
  }

  if (translatableItems.length === 0) {
    dom.webArticleProgress.textContent = '無需翻譯';
    return;
  }

  let doneCount = 0;
  dom.webArticleProgress.textContent = `串流翻譯中 0 / ${translatableItems.length}`;
  setGlobalStatus('streaming', `文章翻譯 0/${translatableItems.length}`);

  const onItem = (key, zh) => {
    const targets = transNodesByKey.get(key) || [];
    for (const node of targets) {
      node.textContent = zh;
    }
    doneCount += 1;
    dom.webArticleProgress.textContent = doneCount >= translatableItems.length
      ? `已完成 ${translatableItems.length} 段`
      : `串流翻譯中 ${doneCount} / ${translatableItems.length}`;
    setGlobalStatus(
      doneCount >= translatableItems.length ? 'done' : 'streaming',
      `已譯 ${doneCount}/${translatableItems.length}`
    );
  };

  try {
    const batches = buildPageBatches(translatableItems);
    for (const batch of batches) {
      if (controller.signal.aborted) return;
      await streamTranslateBatchWithCache(state.settings, batch, title, onItem, controller.signal);
    }
    setGlobalStatus('done', `已完成 ${doneCount} 段`);
  } catch (err) {
    if (controller.signal.aborted) return;
    dom.webArticleProgress.textContent = err?.message || '翻譯失敗';
    setGlobalStatus('error', err?.message || '翻譯失敗');
  }
}

// ============================================================
// 9. Settings Tab & Install Tab Helpers (Tabs 3 & 4)
// ============================================================
const BOOKMARKLET_SNIPPET = `javascript:(function(){var s=document.createElement('script');s.src='https://chih-kai-wang.github.io/native-read/nativeread.user.js?t='+Date.now();document.head.appendChild(s);})();`;

function populateSettingsForm() {
  const s = state.settings;
  dom.setProvider.replaceChildren();
  const providerGroups = new Map();
  for (const preset of Object.values(PROVIDER_PRESETS)) {
    const groupLabel = preset.group || '其他';
    if (!providerGroups.has(groupLabel)) {
      const og = document.createElement('optgroup');
      og.label = groupLabel;
      providerGroups.set(groupLabel, og);
      dom.setProvider.appendChild(og);
    }
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    providerGroups.get(groupLabel).appendChild(opt);
  }
  dom.setProvider.value = PROVIDER_PRESETS[s.providerId] ? s.providerId : 'custom';
  dom.setApiKey.value = s.apiKey || '';
  dom.setModel.value = s.model || '';
  dom.setBaseUrl.value = s.baseUrl || '';
  dom.setTargetLang.value = TARGET_LANGUAGES[s.targetLang] ? s.targetLang : 'zh-TW';
  dom.customLangField.hidden = dom.setTargetLang.value !== 'custom';
  dom.setCustomTargetLang.value = s.customTargetLang || '';
  dom.setThinkingEffort.value = s.thinkingEffort || 'fastest';
  dom.setTypographyMatch.value = s.typographyMatch || 'native';
  dom.setGlossary.value = s.customGlossary ?? DEFAULT_GLOSSARY;

  updateProviderPresetUI(dom.setProvider.value, false);
}

function updateProviderPresetUI(providerId, overwriteFields = true) {
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.custom;
  dom.setProviderHint.textContent = preset.hint || '';
  dom.setApiKey.placeholder = preset.placeholderKey || '填入 API Key...';

  if (overwriteFields) {
    dom.setModel.value = preset.defaultModel || '';
    dom.setBaseUrl.value = preset.baseUrl || '';
  }
  dom.setModel.placeholder = preset.defaultModel
    ? `例如 ${preset.defaultModel}`
    : '請輸入此服務商的模型名稱（可在服務商後台查詢）';

  dom.modelChipsRow.replaceChildren();
  for (const m of preset.suggestedModels || []) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'nr-chip';
    chip.textContent = m;
    chip.addEventListener('click', () => {
      dom.setModel.value = m;
    });
    dom.modelChipsRow.appendChild(chip);
  }
}

async function updateCacheCountUI() {
  const cnt = await cacheCount();
  dom.cacheCountLabel.textContent = String(cnt);
}

// ============================================================
// 10. Event Bindings & Startup
// ============================================================
function bindEvents() {
  dom.syncBannerClose.addEventListener('click', () => {
    dom.syncBanner.hidden = true;
  });

  for (const btn of dom.navButtons) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  // Global target language change
  dom.globalLangSelect.addEventListener('change', () => {
    const nextLang = dom.globalLangSelect.value;
    state.settings = saveSettings({ targetLang: nextLang });
    dom.setTargetLang.value = nextLang;
    applyRootLanguageFonts(state.settings);
    if (state.pdfDoc) {
      resetAndRetranslatePdf();
    }
    if (state.currentWebArticle) {
      renderAndStreamWebArticle(state.currentWebArticle);
    }
  });

  // Re-fit PDF pages on mobile rotation / window resize
  let pdfResizeTimer = null;
  let lastResizeWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (!state.pdfDoc) return;
    if (Math.abs(window.innerWidth - lastResizeWidth) < 24) return;
    lastResizeWidth = window.innerWidth;
    if (pdfResizeTimer) clearTimeout(pdfResizeTimer);
    pdfResizeTimer = setTimeout(() => {
      if (!state.pdfDoc) return;
      const availW = Math.min(840, Math.max(310, window.innerWidth - 28));
      state.baseFitScale = Math.max(0.48, Math.min(1.55, availW / Math.max(200, state.defaultPageWidth)));
      applyPdfZoom(state.zoom);
    }, 220);
  });

  // PDF Tab events
  dom.pdfModeSegmented.addEventListener('click', (e) => {
    const btn = e.target.closest('.nr-seg-btn');
    if (btn?.dataset.mode) setPdfMode(btn.dataset.mode);
  });

  dom.pdfZoomOutBtn.addEventListener('click', () => stepPdfZoom(-1));
  dom.pdfZoomInBtn.addEventListener('click', () => stepPdfZoom(1));
  dom.pdfZoomResetBtn.addEventListener('click', () => applyPdfZoom(1.0));

  const openFilePicker = () => {
    dom.pdfFileInput.value = '';
    dom.pdfFileInput.click();
  };
  dom.pdfOpenFileTopBtn.addEventListener('click', openFilePicker);
  dom.pdfEmptyOpenBtn.addEventListener('click', openFilePicker);
  dom.pdfErrorOpenFileBtn.addEventListener('click', openFilePicker);

  dom.pdfFileInput.addEventListener('change', () => {
    const file = dom.pdfFileInput.files?.[0];
    if (file) loadPdfFromFile(file);
  });

  dom.pdfUrlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = dom.pdfUrlInput.value.trim();
    if (val) loadPdfFromUrl(val);
  });

  dom.pdfRetryUrlBtn.addEventListener('click', () => {
    if (state.sourceUrl) loadPdfFromUrl(state.sourceUrl);
  });

  dom.pdfOpenSourceBtn?.addEventListener('click', () => {
    if (!state.pdfOpenSourceUrl) return;
    try {
      const parsed = new URL(state.pdfOpenSourceUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        window.open(parsed.toString(), '_blank', 'noopener');
      }
    } catch (_) {}
  });

  // Compare Sheet events
  dom.compareCloseBtn.addEventListener('click', closeComparePopover);
  const copyFeedback = async (btn, text) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = '已複製';
      setTimeout(() => { btn.textContent = prev; }, 1200);
    } catch (_) {}
  };
  dom.copyOrigBtn.addEventListener('click', () => copyFeedback(dom.copyOrigBtn, state.activeComparePara?.orig));
  dom.copyTransBtn.addEventListener('click', () => copyFeedback(dom.copyTransBtn, state.activeComparePara?.trans));

  // Web Tab events
  dom.webModeSegmented.addEventListener('click', (e) => {
    const btn = e.target.closest('.nr-seg-btn');
    if (!btn?.dataset.webmode) return;
    dom.webArticleCard.dataset.webmode = btn.dataset.webmode;
    for (const b of dom.webModeSegmented.querySelectorAll('.nr-seg-btn')) {
      b.classList.toggle('is-active', b === btn);
    }
  });

  dom.webFontSegmented.addEventListener('click', (e) => {
    const btn = e.target.closest('.nr-seg-btn');
    if (!btn?.dataset.webfont) return;
    dom.webArticleCard.dataset.webfont = btn.dataset.webfont;
    for (const b of dom.webFontSegmented.querySelectorAll('.nr-seg-btn')) {
      b.classList.toggle('is-active', b === btn);
    }
  });

  dom.webUrlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = dom.webUrlInput.value.trim();
    if (!url) return;
    // If user pasted a direct PDF link into Web tab, automatically route to PDF tab!
    if (/\.pdf(?:$|\?)/i.test(url) || /arxiv\.org\/pdf\//i.test(url)) {
      switchTab('pdf');
      dom.pdfUrlInput.value = url;
      loadPdfFromUrl(url);
      return;
    }
    dom.webArticleCard.hidden = false;
    dom.webArticleTitle.textContent = '正在擷取網頁正文...';
    dom.webArticleProgress.textContent = url;
    dom.webArticleBody.replaceChildren();
    try {
      const parsed = await fetchReadableArticleFromUrl(url);
      await renderAndStreamWebArticle({
        title: parsed.title,
        sourceLabel: new URL(url).hostname,
        blocks: parsed.blocks
      });
    } catch (err) {
      dom.webArticleTitle.textContent = '無法直接擷取該網址';
      dom.webArticleProgress.textContent = err?.message || '請改展開上方「直接貼上外文段落」進行翻譯';
    }
  });

  dom.webTranslateRawBtn.addEventListener('click', () => {
    const raw = dom.webRawInput.value.trim();
    if (!raw) return;
    const parsed = parseMarkdownOrTextBlocks(raw, '自訂外文段落翻譯');
    renderAndStreamWebArticle({
      title: parsed.title,
      sourceLabel: 'Direct Paste',
      blocks: parsed.blocks
    });
  });

  dom.webClearRawBtn.addEventListener('click', () => {
    dom.webRawInput.value = '';
  });

  // Install Tab bookmarklet
  dom.bookmarkletCodeBox.textContent = BOOKMARKLET_SNIPPET;
  dom.copyBookmarkletBtn.addEventListener('click', () => {
    copyFeedback(dom.copyBookmarkletBtn, BOOKMARKLET_SNIPPET);
  });

  // Settings Tab events
  dom.setProvider.addEventListener('change', () => {
    updateProviderPresetUI(dom.setProvider.value, true);
  });

  dom.setTargetLang.addEventListener('change', () => {
    dom.customLangField.hidden = dom.setTargetLang.value !== 'custom';
  });

  dom.toggleApiKeyVisBtn.addEventListener('click', () => {
    const isPw = dom.setApiKey.type === 'password';
    dom.setApiKey.type = isPw ? 'text' : 'password';
    dom.toggleApiKeyVisBtn.textContent = isPw ? '隱藏' : '顯示';
  });

  const collectFormSettings = () => {
    const providerId = dom.setProvider.value;
    const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.custom;
    return {
      providerId,
      protocol: preset.protocol || 'openai',
      apiKey: sanitizeApiKey(dom.setApiKey.value),
      model: dom.setModel.value.trim() || preset.defaultModel,
      baseUrl: dom.setBaseUrl.value.trim() || preset.baseUrl,
      targetLang: dom.setTargetLang.value,
      customTargetLang: dom.setCustomTargetLang.value.trim(),
      thinkingEffort: dom.setThinkingEffort.value,
      typographyMatch: dom.setTypographyMatch.value,
      customGlossary: dom.setGlossary.value
    };
  };

  dom.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const prev = state.settings;
    state.settings = saveSettings(collectFormSettings());
    populateLanguageDropdowns();
    applyRootLanguageFonts(state.settings);
    showSyncBanner('✅ 設定已儲存至本機！');
    if (
      state.pdfDoc &&
      prev &&
      (
        state.settings.targetLang !== prev.targetLang ||
        state.settings.customTargetLang !== prev.customTargetLang ||
        state.settings.model !== prev.model ||
        state.settings.protocol !== prev.protocol
      )
    ) {
      resetAndRetranslatePdf();
    }
  });

  dom.testApiBtn.addEventListener('click', async () => {
    const candidate = { ...state.settings, ...collectFormSettings() };
    state.settings = saveSettings(candidate);
    dom.settingsTestResult.hidden = false;
    dom.settingsTestResult.dataset.status = '';
    dom.settingsTestResult.textContent = `正在測試連線 (${candidate.protocol} · ${candidate.model})...`;
    const t0 = performance.now();
    try {
      let translated = '';
      await streamTranslateBatchWithCache(
        candidate,
        [{ key: `test_${Date.now()}`, text: 'Machine learning models prevent overfitting using cross-validation.' }],
        'API Connection Test',
        (_k, zh) => { translated = zh; },
        null
      );
      const ms = Math.round(performance.now() - t0);
      dom.settingsTestResult.dataset.status = 'ok';
      dom.settingsTestResult.textContent = `✅ 連線成功 (${ms} ms)\n測試譯文：${translated}`;
    } catch (err) {
      dom.settingsTestResult.dataset.status = 'error';
      dom.settingsTestResult.textContent = `❌ 連線失敗：${err?.message || err}`;
    }
  });

  dom.clearCacheBtn.addEventListener('click', async () => {
    await cacheClear();
    await updateCacheCountUI();
    showSyncBanner('🧹 已清除所有 IndexedDB 翻譯快取');
  });
}

async function init() {
  const syncedFromDesktop = checkAndApplyNrSyncHash();
  state.settings = loadSettings();
  populateLanguageDropdowns();
  populateSettingsForm();
  applyRootLanguageFonts(state.settings);
  bindEvents();
  updateCacheCountUI();

  if (syncedFromDesktop) {
    showSyncBanner('✅ 已從電腦端同步 API Key 與偏好設定！');
  }

  // Register PWA Service Worker
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let updateBannerShown = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !updateBannerShown) {
        updateBannerShown = true;
        showSyncBanner('已更新到最新版本，重新整理頁面即可套用。');
      }
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Handle query parameters (?src= for PDF, ?url= / ?text= for Web Share Target)
  const params = new URLSearchParams(window.location.search);
  const srcPdf = params.get('src');
  const shareUrl = params.get('url') || params.get('text');

  if (srcPdf && srcPdf.trim()) {
    switchTab('pdf');
    dom.pdfUrlInput.value = srcPdf.trim();
    await loadPdfFromUrl(srcPdf.trim());
  } else if (shareUrl && /^https?:\/\/\S+/i.test(shareUrl.trim())) {
    const cleanUrl = shareUrl.trim().match(/https?:\/\/\S+/i)[0];
    if (/\.pdf(?:$|\?)/i.test(cleanUrl) || /arxiv\.org\/pdf\//i.test(cleanUrl)) {
      switchTab('pdf');
      dom.pdfUrlInput.value = cleanUrl;
      await loadPdfFromUrl(cleanUrl);
    } else {
      switchTab('web');
      dom.webUrlInput.value = cleanUrl;
      dom.webUrlForm.requestSubmit();
    }
  } else {
    showPdfStage('empty');
  }
}

init();
