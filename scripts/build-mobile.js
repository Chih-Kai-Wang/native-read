#!/usr/bin/env node
/**
 * NativeRead Mobile & Multi-Platform Build Script
 * The release version is read from manifest.json (single source of truth).
 * Generates:
 *  1. docs/vendor/pdfjs/* & docs/icons/* & docs/.nojekyll
 *  2. docs/nativeread.user.js (Universal iOS Safari / Android / Desktop Userscript)
 *  3. docs/nativeread-android-extension.zip (Android Chromium Extension Package)
 *  4. docs/nativeread.meta.js (Userscript update-check header) & docs/version.json
 *  5. Syncs the version into docs/sw.js CACHE_NAME and the docs/index.html badge
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirectory(srcDir, destDir) {
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function readUtf8(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

const PAGES_BASE = 'https://chih-kai-wang.github.io/native-read/';
const USERSCRIPT_URL = PAGES_BASE + 'nativeread.user.js';
const USERSCRIPT_META_URL = PAGES_BASE + 'nativeread.meta.js';

function readReleaseVersion() {
  const manifestPath = path.join(ROOT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid release version "${manifest.version}" in ${manifestPath}: expected MAJOR.MINOR.PATCH (digits only)`
    );
  }
  return version;
}

function buildUserscriptHeader(version) {
  return [
    '// ==UserScript==',
    '// @name         NativeRead — 原版美感 AI 網頁翻譯 (Mobile & Desktop)',
    '// @namespace    https://chih-kai-wang.github.io/native-read/',
    `// @version      ${version}`,
    '// @description  保留原網站 Serif / Sans 排版氣質的 AI 串流網頁與程式碼註解翻譯器（支援 iOS Safari Stay / Userscripts 與 Android Tampermonkey / 狐猴 / Kiwi）',
    '// @author       Chih-Kai Wang',
    '// @homepageURL  https://github.com/Chih-Kai-Wang/native-read',
    '// @supportURL   https://github.com/Chih-Kai-Wang/native-read/issues',
    `// @updateURL    ${USERSCRIPT_META_URL}`,
    `// @downloadURL  ${USERSCRIPT_URL}`,
    '// @match        *://*/*',
    '// @grant        GM_getValue',
    '// @grant        GM_setValue',
    '// @grant        GM.getValue',
    '// @grant        GM.setValue',
    '// @grant        GM_xmlhttpRequest',
    '// @grant        GM.xmlHttpRequest',
    '// @connect      *',
    '// @run-at       document-idle',
    '// ==/UserScript=='
  ].join('\n');
}

function writeUserscriptMeta(header) {
  const metaPath = path.join(DOCS_DIR, 'nativeread.meta.js');
  const content = `${header}\n`;
  fs.writeFileSync(metaPath, content, 'utf8');
  console.log(`[build-mobile] Generated ${metaPath} (${Buffer.byteLength(content)} bytes)`);
}

function syncPwaVersion(version) {
  const swPath = path.join(DOCS_DIR, 'sw.js');
  const swOrig = fs.readFileSync(swPath, 'utf8');
  const swRe = /^const CACHE_NAME = '[^']*';$/m;
  if (!swRe.test(swOrig)) {
    throw new Error(`Could not find CACHE_NAME declaration in ${swPath}`);
  }
  const swNext = swOrig.replace(swRe, `const CACHE_NAME = 'nativeread-pwa-v${version}';`);
  if (swNext !== swOrig) {
    fs.writeFileSync(swPath, swNext, 'utf8');
    console.log(`[build-mobile] Updated ${swPath} -> nativeread-pwa-v${version}`);
  }

  const indexPath = path.join(DOCS_DIR, 'index.html');
  const indexOrig = fs.readFileSync(indexPath, 'utf8');
  const brandRe = /(<span class="nr-brand-tag">)[^<]*(<\/span>)/;
  if (!brandRe.test(indexOrig)) {
    throw new Error(`Could not find <span class="nr-brand-tag">...</span> in ${indexPath}`);
  }
  const indexNext = indexOrig.replace(brandRe, `$1v${version} Mobile &amp; PWA$2`);
  if (indexNext !== indexOrig) {
    fs.writeFileSync(indexPath, indexNext, 'utf8');
    console.log(`[build-mobile] Updated ${indexPath} -> v${version} Mobile & PWA`);
  }
}

function writeVersionJson(version) {
  const versionPath = path.join(DOCS_DIR, 'version.json');
  const payload = {
    version,
    userscript: USERSCRIPT_URL,
    androidZip: PAGES_BASE + 'nativeread-android-extension.zip',
    pwa: PAGES_BASE
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(versionPath, content, 'utf8');
  console.log(`[build-mobile] Generated ${versionPath} (${Buffer.byteLength(content)} bytes)`);
}

function buildUserscript(version) {
  const configJs = readUtf8('shared/config.js');
  const siteAnalyzerJs = readUtf8('content/site-analyzer.js');
  const codeOverlayJs = readUtf8('content/code-overlay.js');
  const rendererJs = readUtf8('content/renderer.js');
  const contentCss = readUtf8('content/content.css');

  const header = buildUserscriptHeader(version);

  const runtimeJs = `
(() => {
  if (globalThis.__NATIVEREAD_USERSCRIPT_BOOTED__) {
    if (typeof globalThis.__NATIVEREAD_OPEN_PILL__ === 'function') {
      globalThis.__NATIVEREAD_OPEN_PILL__();
    }
    return;
  }
  globalThis.__NATIVEREAD_USERSCRIPT_BOOTED__ = true;

  // Run only in top frame or main content frames
  const {
    PROVIDER_PRESETS,
    TARGET_LANGUAGES,
    DEFAULT_GLOSSARY,
    DEFAULT_SETTINGS,
    SETTINGS_KEY,
    resolveTargetLanguage,
    resolveEndpoint,
    resolveStreamEndpoint,
    buildProviderAuthHeaders,
    buildAnthropicMessagesBody,
    extractAnthropicStreamDelta,
    resolveThinkingConfig,
    normalizeHostname,
    isHostWhitelisted,
    isLocalEndpoint,
    sanitizeApiKey,
    validateApiKey,
    normalizeProviderProfiles,
    switchActiveProviderSettings,
    resolveFallbackSettings,
    formatApiError,
    hashText
  } = globalThis.KCTConfig;

  const KCTSiteAnalyzer = globalThis.KCTSiteAnalyzer;
  const KCTRenderer = globalThis.KCTRenderer;
  const KCTCodeOverlay = globalThis.KCTCodeOverlay;

  const PAGE_STYLE_CSS = ${JSON.stringify(contentCss)};

  // ============================================================
  // 1. Storage Adapter (GM_getValue / GM.getValue ONLY on untrusted origins;
  //    localStorage fallback strictly restricted to trusted PWA origin)
  // ============================================================
  function hasGmGet() {
    return typeof GM_getValue === 'function' || (typeof GM !== 'undefined' && typeof GM.getValue === 'function');
  }

  function hasGmSet() {
    return typeof GM_setValue === 'function' || (typeof GM !== 'undefined' && typeof GM.setValue === 'function');
  }

  function isTrustedOriginForFallback() {
    try {
      const host = String(location.hostname || '').toLowerCase();
      const pathname = String(location.pathname || '');
      if (host === 'chih-kai-wang.github.io' && pathname.startsWith('/native-read')) return true;
      if (host === 'localhost' || host === '127.0.0.1') return true;
    } catch (_) {}
    return false;
  }

  function buildDefaultUserscriptSettings() {
    return {
      ...DEFAULT_SETTINGS,
      providerId: 'gemini',
      protocol: 'gemini',
      baseUrl: PROVIDER_PRESETS.gemini.baseUrl,
      model: PROVIDER_PRESETS.gemini.defaultModel,
      providerProfiles: {},
      autoTranslateHosts: []
    };
  }

  function parseStoredRawSettings(raw) {
    const base = buildDefaultUserscriptSettings();
    if (!raw) return base;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const merged = {
        ...base,
        ...parsed,
        apiKey: sanitizeApiKey(parsed?.apiKey),
        autoTranslateHosts: Array.isArray(parsed?.autoTranslateHosts)
          ? Array.from(new Set(parsed.autoTranslateHosts.map(normalizeHostname).filter(Boolean)))
          : []
      };
      merged.providerProfiles = normalizeProviderProfiles(parsed?.providerProfiles, merged);
      return merged;
    } catch (_) {
      return base;
    }
  }

  let cachedSettings = buildDefaultUserscriptSettings();

  async function initStoredSettings() {
    let raw = null;
    try {
      if (typeof GM_getValue === 'function') {
        raw = await Promise.resolve(GM_getValue(SETTINGS_KEY, null));
      } else if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
        raw = await GM.getValue(SETTINGS_KEY, null);
      }
    } catch (_) {}

    if (!raw && !hasGmGet() && isTrustedOriginForFallback()) {
      try {
        raw = localStorage.getItem(SETTINGS_KEY);
      } catch (_) {}
    }
    cachedSettings = parseStoredRawSettings(raw);
    return cachedSettings;
  }

  function readStoredSettings() {
    return cachedSettings;
  }

  async function persistStoredSettings(next) {
    const serialized = JSON.stringify(next);
    let wroteGm = false;
    try {
      if (typeof GM_setValue === 'function') {
        await Promise.resolve(GM_setValue(SETTINGS_KEY, serialized));
        wroteGm = true;
      } else if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
        await GM.setValue(SETTINGS_KEY, serialized);
        wroteGm = true;
      }
    } catch (_) {}
    if (!wroteGm && !hasGmSet() && isTrustedOriginForFallback()) {
      try {
        localStorage.setItem(SETTINGS_KEY, serialized);
      } catch (_) {}
    }
    return next;
  }

  function writeStoredSettings(partial) {
    const current = readStoredSettings();
    const hasExplicitProfiles = Boolean(
      partial &&
      typeof partial.providerProfiles === 'object' &&
      partial.providerProfiles !== null &&
      !Array.isArray(partial.providerProfiles)
    );
    const next = {
      ...current,
      ...(partial && typeof partial === 'object' ? partial : {})
    };
    next.apiKey = sanitizeApiKey(next.apiKey);
    if (Array.isArray(next.autoTranslateHosts)) {
      next.autoTranslateHosts = Array.from(new Set(next.autoTranslateHosts.map(normalizeHostname).filter(Boolean)));
    } else {
      next.autoTranslateHosts = [];
    }
    const baseProfiles = hasExplicitProfiles ? partial.providerProfiles : current.providerProfiles;
    next.providerProfiles = normalizeProviderProfiles(baseProfiles, next);
    if (next.fallbackProviderId === next.providerId) {
      next.fallbackProviderId = '';
    }
    cachedSettings = next;
    void persistStoredSettings(next);
    return next;
  }

  // Override KCTConfig.getSettings / saveSettings so shared modules work seamlessly
  globalThis.KCTConfig.getSettings = async () => readStoredSettings();
  globalThis.KCTConfig.saveSettings = async (partial) => {
    const next = writeStoredSettings(partial);
    await persistStoredSettings(next);
    return next;
  };

  // ============================================================
  // 2. #nr_sync Zero-Typing Sync Decoder & Trusted PWA Bridge
  // ============================================================
  function decodeBase64UrlJson(b64url) {
    const base64 = String(b64url || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '==='.slice((base64.length + 3) % 4);
    const binStr = atob(padded);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function extractNrSyncToken(rawInput) {
    const text = String(rawInput || '').trim();
    if (!text) return '';
    const hashMatch = text.match(/(?:^|[#&])nr_sync=([A-Za-z0-9_%-]+)/);
    if (hashMatch && hashMatch[1]) return hashMatch[1];
    try {
      const parsed = new URL(text);
      const urlMatch = String(parsed.hash || '').match(/(?:^|[#&])nr_sync=([A-Za-z0-9_%-]+)/);
      if (urlMatch && urlMatch[1]) return urlMatch[1];
    } catch (_) {}
    if (/^[A-Za-z0-9_-]{12,}={0,2}$/.test(text)) {
      return text;
    }
    return '';
  }

  async function applyNrSyncPayloadObject(payload, syncedAtOverride = null) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

    const rawPid = String(payload.providerId || payload.p || '').trim();
    const rawProtoField = String(payload.protocol || payload.r || '').trim().toLowerCase();
    const rawBaseField = String(payload.baseUrl || payload.u || '').trim();
    const hasEndpointFields = Boolean(rawPid || rawProtoField || rawBaseField);
    const rawKey = Object.prototype.hasOwnProperty.call(payload, 'apiKey')
      ? payload.apiKey
      : (Object.prototype.hasOwnProperty.call(payload, 'k') ? payload.k : undefined);
    const hasExplicitKey = typeof rawKey === 'string';
    if (!hasExplicitKey && hasEndpointFields) return false;

    const providerId = rawPid
      ? (PROVIDER_PRESETS[rawPid] ? rawPid : 'custom')
      : 'gemini';
    const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.gemini;
    const protocol = rawProtoField || String(preset.protocol || 'gemini').toLowerCase();
    if (!['openai', 'gemini', 'anthropic'].includes(protocol)) return false;

    const baseUrl = rawBaseField || preset.baseUrl || '';
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    } catch (_) {
      return false;
    }

    const keyCheck = validateApiKey(rawKey ?? '');
    if (!keyCheck.ok) return false;
    const apiKey = keyCheck.cleanKey;
    const model = String(payload.model || payload.m || preset.defaultModel || '').trim();
    const rawLang = String(payload.targetLang || payload.l || 'zh-TW').trim();
    const targetLang = TARGET_LANGUAGES[rawLang] ? rawLang : 'zh-TW';
    const customTargetLang = String(payload.customTargetLang ?? payload.c ?? '').trim();
    const rawEffort = String(payload.thinkingEffort || payload.e || 'fastest').trim();
    const thinkingEffort = ['fastest', 'balanced', 'deep'].includes(rawEffort) ? rawEffort : 'fastest';
    const rawTypo = String(payload.typographyMatch || payload.t || 'native').trim();
    const typographyMatch = ['native', 'system', 'preserve'].includes(rawTypo) ? rawTypo : 'native';
    const syncedAt = Number.isFinite(Number(syncedAtOverride)) && Number(syncedAtOverride) > 0
      ? Number(syncedAtOverride)
      : Date.now();

    const current = readStoredSettings();
    const baseProfiles =
      payload.providerProfiles && typeof payload.providerProfiles === 'object' && !Array.isArray(payload.providerProfiles)
        ? { ...(current.providerProfiles || {}), ...payload.providerProfiles }
        : current.providerProfiles;
    const mergedProfiles = normalizeProviderProfiles(baseProfiles, {
      providerId,
      protocol,
      baseUrl,
      apiKey,
      model
    });
    const nextPatch = {
      providerId,
      protocol,
      baseUrl,
      apiKey,
      model,
      providerProfiles: mergedProfiles,
      targetLang,
      customTargetLang,
      thinkingEffort,
      typographyMatch,
      syncedAt
    };
    if (typeof payload.fallbackProviderId === 'string') {
      nextPatch.fallbackProviderId = payload.fallbackProviderId === providerId ? '' : payload.fallbackProviderId;
    }
    if (typeof payload.customGlossary === 'string') {
      nextPatch.customGlossary = payload.customGlossary;
    }
    const next = writeStoredSettings(nextPatch);
    await persistStoredSettings(next);
    return true;
  }

  async function tryImportNrSyncInput(rawInput) {
    const token = extractNrSyncToken(rawInput);
    if (!token) return false;
    try {
      const payload = decodeBase64UrlJson(decodeURIComponent(token));
      return await applyNrSyncPayloadObject(payload, Date.now());
    } catch (_) {
      return false;
    }
  }

  async function checkAndApplyNrSyncHash() {
    if (!isTrustedOriginForFallback()) return false;
    const hash = String(window.location.hash || '');
    if (!hash.includes('nr_sync=')) return false;
    const token = extractNrSyncToken(hash);
    const scrubHash = () => {
      try {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (_) {}
    };
    if (!token) {
      scrubHash();
      return false;
    }

    try {
      const payload = decodeBase64UrlJson(decodeURIComponent(token));
      return await applyNrSyncPayloadObject(payload, Date.now());
    } catch (_) {
      return false;
    } finally {
      scrubHash();
    }
  }

  // Strictly only runs on the trusted GitHub Pages PWA origin so scan-QR-then-install works seamlessly
  async function trySyncFromTrustedPwaStorage() {
    if (!isTrustedOriginForFallback()) return false;
    let raw = null;
    try {
      raw = localStorage.getItem(SETTINGS_KEY);
    } catch (_) {
      return false;
    }
    if (!raw || typeof raw !== 'string') return false;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const incomingHasCreds =
        Boolean(sanitizeApiKey(parsed.apiKey)) ||
        (isLocalEndpoint(parsed.baseUrl) && Boolean(String(parsed.model || '').trim()));
      if (!incomingHasCreds) return false;

      const current = readStoredSettings();
      const currentHasCreds =
        Boolean(sanitizeApiKey(current.apiKey)) ||
        (isLocalEndpoint(current.baseUrl) && Boolean(String(current.model || '').trim()));
      const incomingTs = Number(parsed.syncedAt || 0);
      const currentTs = Number(current.syncedAt || 0);
      if (currentHasCreds && incomingTs <= currentTs) {
        return false;
      }
      return await applyNrSyncPayloadObject(parsed, incomingTs || Date.now());
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  // 3. Persistent Cache (IndexedDB with 'ts' index/LRU + memory fallback)
  // ============================================================
  const DB_NAME = 'kct_cache_db_v2';
  const STORE_NAME = 'entries';
  const MAX_CACHE_ENTRIES = 10000;
  const IDB_OPEN_TIMEOUT_MS = 3000;
  let dbPromise = null;
  const memCache = new Map();

  function openCacheDB() {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('No IDB'));
    if (dbPromise) return dbPromise;
    const currentPromise = new Promise((resolve, reject) => {
      let settled = false;
      let req = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (dbPromise === currentPromise) dbPromise = null;
        reject(new Error('IndexedDB open timeout'));
      }, IDB_OPEN_TIMEOUT_MS);

      const finishOk = (db) => {
        if (settled) {
          try { db.close(); } catch (_) {}
          return;
        }
        settled = true;
        clearTimeout(timer);
        db.onversionchange = () => {
          try { db.close(); } catch (_) {}
          if (dbPromise === currentPromise) dbPromise = null;
        };
        db.onclose = () => {
          if (dbPromise === currentPromise) dbPromise = null;
        };
        resolve(db);
      };

      const finishErr = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (dbPromise === currentPromise) dbPromise = null;
        reject(err);
      };

      try {
        req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          const store = db.objectStoreNames.contains(STORE_NAME)
            ? req.transaction.objectStore(STORE_NAME)
            : db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          if (!store.indexNames.contains('ts')) {
            store.createIndex('ts', 'ts', { unique: false });
          }
        };
        req.onsuccess = () => finishOk(req.result);
        req.onerror = () => finishErr(req.error || new Error('IDB open error'));
        req.onblocked = () => finishErr(new Error('IDB open blocked'));
      } catch (e) {
        finishErr(e);
      }
    });
    dbPromise = currentPromise;
    return currentPromise;
  }

  async function cacheGetMany(keys) {
    const out = new Map();
    for (const k of keys) {
      if (memCache.has(k)) out.set(k, memCache.get(k));
    }
    try {
      const db = await openCacheDB();
      await new Promise((resolve) => {
        let tx;
        try {
          tx = db.transaction(STORE_NAME, 'readonly');
        } catch (err) {
          if (err?.name === 'InvalidStateError') dbPromise = null;
          resolve();
          return;
        }
        const store = tx.objectStore(STORE_NAME);
        for (const k of keys) {
          if (out.has(k)) continue;
          const r = store.get(k);
          r.onsuccess = () => {
            if (r.result?.zh) {
              out.set(k, r.result.zh);
              memCache.set(k, r.result.zh);
            }
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch (_) {}
    return out;
  }

  function deleteOldestUserscriptCacheKeys(store, source, count) {
    if (!store || !source || !Number.isFinite(count) || count <= 0) return;
    if (typeof source.getAllKeys === 'function') {
      const keysReq = source.getAllKeys(null, count);
      keysReq.onsuccess = () => {
        try {
          const keys = Array.isArray(keysReq.result) ? keysReq.result : [];
          for (const pk of keys) {
            const delReq = store.delete(pk);
            if (delReq && typeof delReq === 'object') {
              delReq.onerror = (e) => {
                try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
              };
            }
          }
        } catch (_) {}
      };
      keysReq.onerror = (e) => {
        try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
      };
      return;
    }

    let remaining = count;
    const curReq = source.openCursor(null, 'next');
    curReq.onsuccess = () => {
      const cursor = curReq.result;
      if (cursor && remaining > 0) {
        cursor.delete();
        remaining -= 1;
        if (remaining > 0) cursor.continue();
      }
    };
  }

  async function evictOldestUserscriptCacheFraction(db, fraction = 0.2) {
    await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(STORE_NAME, 'readwrite');
      } catch (_) {
        resolve();
        return;
      }
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const toDelete = Math.max(1, Math.ceil((countReq.result || 0) * fraction));
        const cursorSource = store.indexNames.contains('ts') ? store.index('ts') : store;
        deleteOldestUserscriptCacheKeys(store, cursorSource, toDelete);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  }

  async function writeUserscriptCacheOnce(db, entries) {
    const now = Date.now();
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(STORE_NAME, 'readwrite');
      } catch (err) {
        if (err?.name === 'InvalidStateError') dbPromise = null;
        reject(err);
        return;
      }
      const store = tx.objectStore(STORE_NAME);
      entries.forEach((e, idx) => {
        if (e?.key && e?.zh) store.put({ key: e.key, zh: e.zh, ts: now + idx });
      });
      const countReq = store.count();
      countReq.onsuccess = () => {
        const overflow = (countReq.result || 0) - MAX_CACHE_ENTRIES;
        if (overflow > 0) {
          const cursorSource = store.indexNames.contains('ts') ? store.index('ts') : store;
          deleteOldestUserscriptCacheKeys(store, cursorSource, overflow);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IDB put failed'));
      tx.onabort = () => reject(tx.error || new Error('IDB put aborted'));
    });
  }

  async function cachePutMany(entries) {
    for (const e of entries) {
      if (e?.key && e?.zh) {
        memCache.set(e.key, e.zh);
        if (memCache.size > MAX_CACHE_ENTRIES) {
          const oldestKey = memCache.keys().next().value;
          if (oldestKey !== undefined) memCache.delete(oldestKey);
        }
      }
    }
    try {
      const db = await openCacheDB();
      try {
        await writeUserscriptCacheOnce(db, entries);
      } catch (err) {
        if (err?.name === 'QuotaExceededError') {
          await evictOldestUserscriptCacheFraction(db, 0.2);
          await writeUserscriptCacheOnce(db, entries).catch(() => {});
        }
      }
    } catch (_) {}
  }

  function buildCacheSignature(settings) {
    const lang = resolveTargetLanguage(settings);
    const customLang = lang.isCustom ? String(settings.customTargetLang || '').trim().toLowerCase() : '';
    const glossaryHash = hashText(String(settings.customGlossary || '').trim());
    return \`\${settings.protocol}:\${settings.model}:\${settings.thinkingEffort || 'fastest'}:\${lang.id}:\${customLang}:\${glossaryHash}\`;
  }

  // ============================================================
  // 4. LLM Request Engine (SSE fetch + GM_xmlhttpRequest CSP bypass fallback)
  // ============================================================
  function buildStreamSystemPrompt(settings, pageContext) {
    const lang = resolveTargetLanguage(settings);
    const langGuide = lang.id === 'zh-TW'
      ? '目標語言：繁體中文（台灣慣用語與台灣繁體字形，如資料、函式、迴圈、過度擬合、程式碼）。'
      : lang.id === 'zh-CN'
        ? '目标语言：简体中文（自然流利的中国大陆技术表达）。'
        : \`Target language: \${lang.promptName}.\`;
    const glossary = String(settings.customGlossary || '').trim();
    const glossaryPart = (glossary && (lang.id === 'zh-TW' || lang.id === 'zh-CN'))
      ? \`\\n參考術語表：\\n\${glossary}\\n\`
      : '';
    return [
      'Expert web & technical translator. Preserve original tone and structure.',
      pageContext?.title ? \`Page topic: \${String(pageContext.title).slice(0, 120)}\` : '',
      langGuide,
      'Rules:',
      '1. Keep atomic placeholders [[C0]] (code), [[M0]] (math/citations), [[L0]] (untranslatable link) verbatim; paired tags [[A0]]...[[/A0]] (link) and [[S0]]...[[/S0]] (bold/italic/emphasis) must each appear exactly once, wrapping the TRANSLATED words that correspond to the original wrapped words, properly nested, never translated/renamed/re-numbered/removed; do not add tags that were not in the input.',
      '2. Keep code identifiers, package/function names, URLs, and abbreviations intact.',
      '3. For "kind":"comment", keep the leading "# " prefix.',
      '4. Output STRICT NDJSON: one JSON object per line in the format {"i":0,"t":"..."} matching every input index i.',
      '5. NO markdown fences (no \`\`\`), NO surrounding array [...].',
      glossaryPart
    ].filter(Boolean).join('\\n');
  }

  function parseNdjsonLine(rawLine) {
    let clean = String(rawLine || '').trim();
    if (!clean || clean.startsWith('\`\`\`') || clean === '[' || clean === ']' || clean === '],') return [];
    if (clean.startsWith('[') && clean.includes('{')) clean = clean.slice(1).trim();
    if (clean.endsWith(',')) clean = clean.slice(0, -1).trim();
    if (clean.endsWith(']') && !clean.startsWith('[')) clean = clean.slice(0, -1).trim();
    if (!clean) return [];

    const extractObj = (obj) => {
      const out = [];
      if (!obj || typeof obj !== 'object') return out;
      const push = (e) => {
        if (!e || typeof e !== 'object') return;
        const idx = Number(e.i ?? e.id ?? e.index);
        const txt = e.t ?? e.zh ?? e.translation;
        if (Number.isInteger(idx) && idx >= 0 && typeof txt === 'string' && txt.trim()) {
          out.push({ idx, text: txt.trim() });
        }
      };
      if (Array.isArray(obj)) obj.forEach(push);
      else if (Array.isArray(obj.translations)) obj.translations.forEach(push);
      else push(obj);
      return out;
    };

    try {
      return extractObj(JSON.parse(clean));
    } catch (_) {
      const results = [];
      let start = clean.indexOf('{');
      while (start !== -1) {
        let depth = 0;
        let inStr = false;
        let esc = false;
        let end = -1;
        for (let i = start; i < clean.length; i++) {
          const ch = clean[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\\\') esc = true;
            else if (ch === '"') inStr = false;
          } else if (ch === '"') inStr = true;
          else if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) { end = i; break; }
          }
        }
        if (end === -1) break;
        try {
          results.push(...extractObj(JSON.parse(clean.slice(start, end + 1))));
        } catch (_) {}
        start = clean.indexOf('{', end + 1);
      }
      return results;
    }
  }

  function extractDelta(protocol, chunkObj) {
    if (!chunkObj || typeof chunkObj !== 'object') return '';
    if (protocol === 'gemini') {
      const parts = chunkObj?.candidates?.[0]?.content?.parts || [];
      let out = '';
      for (const p of parts) {
        if (p && !p.thought && typeof p.text === 'string') out += p.text;
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
    const c = chunkObj?.choices?.[0];
    return c?.delta?.content || c?.message?.content || '';
  }

  function redactAllUserscriptKeys(msg, settings = null) {
    let out = String(msg || '');
    const keys = new Set();
    const s = settings || readStoredSettings();
    const mainKey = sanitizeApiKey(s?.apiKey);
    if (mainKey) keys.add(mainKey);
    if (s?.providerProfiles && typeof s.providerProfiles === 'object') {
      for (const p of Object.values(s.providerProfiles)) {
        const pk = sanitizeApiKey(p?.apiKey);
        if (pk) keys.add(pk);
      }
    }
    for (const k of keys) {
      if (k && k.length >= 6) {
        out = out.split(k).join('[REDACTED_KEY]');
      }
    }
    return out;
  }

  function isHardQuota429Userscript(status, bodyText) {
    if (status !== 429) return false;
    return /quota exceeded|exceeded your current quota|daily limit|insufficient_quota|billing|配額上限|額度已用盡/i.test(
      String(bodyText || '')
    );
  }

  function buildUserscriptHttpError(status, statusText, rawBodyText, settings = null) {
    const safeBody = redactAllUserscriptKeys(String(rawBodyText || '').slice(0, 260), settings);
    const msg = \`HTTP \${status}: \${safeBody || statusText || 'Request failed'}\`;
    const err = new Error(msg);
    err.isHttpError = true;
    err.httpStatus = status;
    if (status === 401 || status === 403) {
      err.errorCode = 'AUTH_ERROR';
      err.retryable = false;
    } else if (status === 404) {
      err.errorCode = 'HTTP_404';
      err.retryable = false;
    } else if (status === 429) {
      err.errorCode = 'RATE_LIMIT';
      err.retryable = !isHardQuota429Userscript(status, rawBodyText);
    } else if (status === 503 || status === 529) {
      err.errorCode = 'OVERLOADED';
      err.retryable = true;
    } else if (status >= 500) {
      err.errorCode = 'SERVER_ERROR';
      err.retryable = true;
    } else {
      err.errorCode = \`HTTP_\${status}\`;
      err.retryable = false;
    }
    return err;
  }

  function computeUserscriptBackoffMs(status, attempt, retryAfterMs = 0) {
    if (retryAfterMs > 0) {
      return Math.min(30000, retryAfterMs + Math.round(Math.random() * 400));
    }
    if (status === 429) {
      return Math.round(Math.min(12000, 3000 * (2 ** Math.max(0, attempt - 1))) * (0.85 + Math.random() * 0.3));
    }
    if (status === 503 || status === 529) {
      return Math.round(Math.min(8000, 1500 * (2 ** Math.max(0, attempt - 1))) * (0.85 + Math.random() * 0.3));
    }
    return Math.round(Math.min(5000, 900 * attempt) + Math.random() * 350);
  }

  function sleepUserscriptWithAbort(ms, signal) {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function parseUserscriptRetryAfterMs(val) {
    if (!val) return 0;
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) return Math.min(30000, Math.round(n * 1000));
    const ts = Date.parse(val);
    if (Number.isFinite(ts) && ts > Date.now()) return Math.min(30000, ts - Date.now());
    return 0;
  }

  function isUserscriptEcho(orig, trans, targetLangId) {
    const cleanOrig = String(orig || '').replace(/\\[\\[[A-Z]+\\d+\\]\\]|\\[\\[\\/[A-Z]+\\d+\\]\\]/g, '').replace(/[\\s\\p{P}\\p{S}]+/gu, '').toLowerCase();
    const cleanTrans = String(trans || '').replace(/\\[\\[[A-Z]+\\d+\\]\\]|\\[\\[\\/[A-Z]+\\d+\\]\\]/g, '').replace(/[\\s\\p{P}\\p{S}]+/gu, '').toLowerCase();
    if (!cleanTrans || cleanOrig.length < 18) return false;
    const isAsian = targetLangId === 'zh-TW' || targetLangId === 'zh-CN' || targetLangId === 'ja' || targetLangId === 'ko';
    if (isAsian && !/[\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af]/.test(cleanTrans) && cleanTrans === cleanOrig) {
      return true;
    }
    return cleanTrans === cleanOrig;
  }

  function buildRequestPayload(settings, messages, stream) {
    const cleanKey = sanitizeApiKey(settings.apiKey);
    const headers = buildProviderAuthHeaders(settings, cleanKey);
    if (settings.protocol === 'gemini') {
      const sys = messages.find((m) => m.role === 'system');
      const usr = messages.filter((m) => m.role !== 'system');
      const normModel = String(settings.model || '').replace(/^models\\//i, '').trim().toLowerCase();
      const isG3Or4 = /^gemini-(?:3|4)(?:[.\\-]|$)/.test(normModel);
      const generationConfig = {};
      if (!isG3Or4) generationConfig.temperature = Number(settings.temperature ?? 0.2);
      const tc = resolveThinkingConfig(settings.model, settings.thinkingEffort || 'fastest');
      if (tc) generationConfig.thinkingConfig = tc;
      const body = {
        contents: usr.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig
      };
      if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
      return {
        url: stream ? resolveStreamEndpoint(settings) : resolveEndpoint(settings),
        headers,
        body: JSON.stringify(body)
      };
    } else if (settings.protocol === 'anthropic') {
      const body = buildAnthropicMessagesBody(settings, messages, { stream: Boolean(stream), maxTokens: 32000 });
      return {
        url: resolveEndpoint(settings),
        headers,
        body: JSON.stringify(body)
      };
    } else {
      const model = String(settings.model || '').trim();
      const body = { model, messages, stream: Boolean(stream) };
      if (!/^o[134](?:-|$)|deepseek-reasoner|^r1\\b/i.test(model)) {
        body.temperature = Number(settings.temperature ?? 0.2);
      }
      return {
        url: resolveEndpoint(settings),
        headers,
        body: JSON.stringify(body)
      };
    }
  }

  function callViaGmXhr(reqConfig, signal, settings = null) {
    const gmXhr = typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);
    if (!gmXhr) {
      const netErr = new Error('此頁面 CSP 阻擋了直接連線，請在 Tampermonkey / Stay Userscript 環境執行');
      netErr.errorCode = 'NETWORK_ERROR';
      return Promise.reject(netErr);
    }
    if (signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let handle = null;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        try { handle?.abort?.(); } catch (_) {}
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      handle = gmXhr({
        method: 'POST',
        url: reqConfig.url,
        headers: reqConfig.headers,
        data: reqConfig.body,
        timeout: 30000,
        onload(res) {
          if (settled) return;
          settled = true;
          cleanup();
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText || '');
          } else {
            reject(buildUserscriptHttpError(res.status, res.statusText || '', res.responseText || '', settings));
          }
        },
        onerror() {
          if (settled) return;
          settled = true;
          cleanup();
          const netErr = new Error('GM_xmlhttpRequest 網路請求失敗');
          netErr.errorCode = 'NETWORK_ERROR';
          netErr.retryable = true;
          reject(netErr);
        },
        ontimeout() {
          if (settled) return;
          settled = true;
          cleanup();
          const tErr = new Error('GM_xmlhttpRequest 請求逾時');
          tErr.errorCode = 'TIMEOUT';
          tErr.retryable = true;
          reject(tErr);
        }
      });
    });
  }

  function isUserscriptFallbackEligible(err, signal) {
    if (signal?.aborted) return false;
    if (err?.name === 'AbortError' && err?.errorCode !== 'TIMEOUT') return false;
    const code = String(err?.errorCode || '');
    const status = Number(err?.httpStatus || 0);
    if (code === 'NO_API_KEY' || code === 'INVALID_API_KEY_CHARS' || code === 'NO_MODEL' || code === 'AUTH_ERROR') return false;
    if (status === 400 || status === 401 || status === 403 || status === 404) return false;
    if (status === 429 || status === 503 || status === 529 || status >= 500) return true;
    return code === 'OVERLOADED' || code === 'RATE_LIMIT' || code === 'SERVER_ERROR' || code === 'TIMEOUT' || code === 'NETWORK_ERROR' || Boolean(err?.retryable);
  }

  const USERSCRIPT_CONNECT_TIMEOUT_MS = 25000;
  const USERSCRIPT_CHUNK_TIMEOUT_MS = 28000;

  async function translateBatchItems(settings, items, pageContext, onItem, signal = null, { allowFallback = true } = {}) {
    if (!items || items.length === 0) return;
    const cleanKey = sanitizeApiKey(settings.apiKey);
    if (!cleanKey && !isLocalEndpoint(settings.baseUrl || '')) {
      const err = new Error('請先點擊 ⚙ 設定 API Key');
      err.errorCode = 'NO_API_KEY';
      throw err;
    }
    const keyCheck = validateApiKey(cleanKey);
    if (!keyCheck.ok) {
      const err = new Error(keyCheck.error);
      err.errorCode = 'INVALID_API_KEY_CHARS';
      throw err;
    }
    if (!String(settings.model || '').trim()) {
      const err = new Error('請先點擊 ⚙ 設定並填入模型名稱');
      err.errorCode = 'NO_MODEL';
      throw err;
    }

    const langInfo = resolveTargetLanguage(settings);
    const sig = buildCacheSignature(settings);
    const cacheKeys = items.map((it) => \`\${sig}::\${it.key}\`);
    const hits = await cacheGetMany(cacheKeys);
    const uncached = [];

    for (let i = 0; i < items.length; i++) {
      const hit = hits.get(cacheKeys[i]);
      if (hit && !isUserscriptEcho(items[i].text, hit, langInfo.id)) {
        onItem(items[i], hit, true);
      } else {
        uncached.push(items[i]);
      }
    }
    if (uncached.length === 0) return;

    const payload = uncached.map((it, idx) =>
      it.kind === 'comment' ? { i: idx, kind: 'comment', text: it.text } : { i: idx, text: it.text }
    );
    const messages = [
      { role: 'system', content: buildStreamSystemPrompt(settings, pageContext) },
      { role: 'user', content: JSON.stringify(payload) }
    ];

    const emitted = new Set();
    const toCache = [];
    const handleLine = (line) => {
      for (const entry of parseNdjsonLine(line)) {
        if (entry.idx >= 0 && entry.idx < uncached.length && !emitted.has(entry.idx)) {
          emitted.add(entry.idx);
          const item = uncached[entry.idx];
          onItem(item, entry.text, false);
          if (!isUserscriptEcho(item.text, entry.text, langInfo.id)) {
            toCache.push({ key: \`\${sig}::\${item.key}\`, zh: entry.text });
          }
        }
      }
    };

    const reqConfig = buildRequestPayload(settings, messages, true);
    const nonStreamConfig = buildRequestPayload(settings, messages, false);
    const maxAttempts = 4;
    let lastAttemptErr = null;
    let succeeded = false;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        const ctrl = new AbortController();
        let timedOut = false;
        const onAbort = () => { try { ctrl.abort(); } catch (_) {} };
        if (signal) {
          if (signal.aborted) ctrl.abort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        let connectTimer = setTimeout(() => {
          timedOut = true;
          try { ctrl.abort(); } catch (_) {}
        }, USERSCRIPT_CONNECT_TIMEOUT_MS);
        let chunkTimer = null;
        let retryAfterMs = 0;

        try {
          const response = await fetch(reqConfig.url, {
            method: 'POST',
            headers: reqConfig.headers,
            body: reqConfig.body,
            signal: ctrl.signal
          });
          clearTimeout(connectTimer);
          connectTimer = null;

          if (!response.ok) {
            retryAfterMs = parseUserscriptRetryAfterMs(response.headers?.get?.('retry-after'));
            const errText = await response.text().catch(() => '');
            throw buildUserscriptHttpError(response.status, response.statusText || '', errText, settings);
          }

          if (response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let sseBuf = '';
            let ndjsonBuf = '';
            const processSse = (raw) => {
              const line = raw.trim();
              if (!line.startsWith('data:')) return;
              const d = line.slice(5).trim();
              if (!d || d === '[DONE]') return;
              let chunkObj;
              try {
                chunkObj = JSON.parse(d);
              } catch (_) {
                return;
              }
              if (settings.protocol === 'anthropic') {
                const ant = extractAnthropicStreamDelta(chunkObj);
                if (ant.error) {
                  const sErr = new Error(redactAllUserscriptKeys(ant.error, settings));
                  sErr.errorCode = 'SERVER_ERROR';
                  sErr.retryable = true;
                  throw sErr;
                }
              }
              if (chunkObj?.error) {
                const msg = typeof chunkObj.error === 'string'
                  ? chunkObj.error
                  : (chunkObj.error.message || JSON.stringify(chunkObj.error));
                const sErr = new Error(redactAllUserscriptKeys(msg, settings));
                sErr.httpStatus = Number(chunkObj.error?.code || 0) || 0;
                throw sErr;
              }
              const delta = extractDelta(settings.protocol, chunkObj);
              if (delta) {
                ndjsonBuf += delta;
                let nl;
                while ((nl = ndjsonBuf.indexOf('\\n')) !== -1) {
                  const l = ndjsonBuf.slice(0, nl);
                  ndjsonBuf = ndjsonBuf.slice(nl + 1);
                  handleLine(l);
                }
              }
            };
            while (true) {
              if (chunkTimer) clearTimeout(chunkTimer);
              timedOut = false;
              chunkTimer = setTimeout(() => {
                timedOut = true;
                try { ctrl.abort(); } catch (_) {}
              }, USERSCRIPT_CHUNK_TIMEOUT_MS);
              const { value, done } = await reader.read();
              if (done) break;
              sseBuf += decoder.decode(value, { stream: true });
              let nl;
              while ((nl = sseBuf.indexOf('\\n')) !== -1) {
                const l = sseBuf.slice(0, nl);
                sseBuf = sseBuf.slice(nl + 1);
                processSse(l);
              }
            }
            if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
            if (sseBuf.trim()) processSse(sseBuf);
            if (ndjsonBuf.trim()) handleLine(ndjsonBuf);
          } else {
            const rawText = await response.text();
            for (const l of rawText.split('\\n')) handleLine(l);
          }
          succeeded = true;
          lastAttemptErr = null;
          break;
        } catch (err) {
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
          if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
          if (signal?.aborted) {
            throw err;
          }
          let attemptErr = err;
          if (timedOut) {
            const tErr = new Error('請求逾時，模型長時間無回應');
            tErr.errorCode = 'TIMEOUT';
            tErr.retryable = true;
            attemptErr = tErr;
          } else if (!err?.isHttpError && err?.name !== 'AbortError') {
            // Transport / CSP connect-src error ONLY: fall back to GM_xmlhttpRequest!
            try {
              const rawResp = await callViaGmXhr(nonStreamConfig, signal, settings);
              try {
                const parsed = JSON.parse(rawResp);
                const fullText = extractDelta(settings.protocol, parsed);
                for (const l of String(fullText || '').split('\\n')) handleLine(l);
              } catch (_) {
                for (const l of String(rawResp || '').split('\\n')) handleLine(l);
              }
              succeeded = true;
              lastAttemptErr = null;
              break;
            } catch (gmErr) {
              if (signal?.aborted) throw gmErr;
              attemptErr = gmErr;
            }
          }
          lastAttemptErr = attemptErr;
          const status = Number(attemptErr?.httpStatus || 0);
          const canRetry = Boolean(attemptErr?.retryable) && attempt < maxAttempts;
          if (!canRetry) {
            break;
          }
          const waitMs = computeUserscriptBackoffMs(status, attempt, retryAfterMs);
          await sleepUserscriptWithAbort(waitMs, signal);
        } finally {
          if (connectTimer) clearTimeout(connectTimer);
          if (chunkTimer) clearTimeout(chunkTimer);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
      }
    } finally {
      if (toCache.length > 0) {
        await cachePutMany(toCache);
      }
    }

    if (!succeeded) {
      if (allowFallback && isUserscriptFallbackEligible(lastAttemptErr, signal)) {
        const fbSettings = resolveFallbackSettings(settings);
        if (fbSettings) {
          await translateBatchItems(fbSettings, uncached, pageContext, onItem, signal, { allowFallback: false });
          return;
        }
      }
      throw lastAttemptErr || new Error('翻譯失敗');
    }
  }

  // ============================================================
  // 5. Page Translation Orchestrator + Lazy IntersectionObserver
  // ============================================================
  const state = {
    settings: buildDefaultUserscriptSettings(),
    isPageActive: false,
    isTranslating: false,
    haltedByError: false,
    translationEpoch: 0,
    elementState: new WeakMap(),
    pendingItems: [],
    totalDetected: 0,
    totalTranslated: 0,
    lastErrorMsg: '',
    viewportObserver: null,
    flushTimer: null,
    activeController: null,
    spaHooked: false,
    lastHrefPath: location.pathname + location.search
  };

  function ensurePageStyleInjected() {
    if (document.querySelector('style[data-kct-ui="page-style"]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-kct-ui', 'page-style');
    style.textContent = PAGE_STYLE_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function releasePendingUserscriptItems() {
    const released = state.pendingItems.splice(0);
    for (const item of released) {
      if (item?.el && state.elementState.get(item.el) === 'queued') {
        state.elementState.delete(item.el);
      }
    }
  }

  function isCircuitBreakingUserscriptError(err) {
    const code = String(err?.errorCode || '');
    const status = Number(err?.httpStatus || 0);
    if (
      code === 'NO_API_KEY' ||
      code === 'INVALID_API_KEY_CHARS' ||
      code === 'NO_MODEL' ||
      code === 'AUTH_ERROR' ||
      code === 'OVERLOADED' ||
      code === 'RATE_LIMIT' ||
      code === 'SERVER_ERROR' ||
      code === 'TIMEOUT' ||
      code === 'NETWORK_ERROR'
    ) {
      return true;
    }
    return status >= 400;
  }

  function enqueueItemForTranslation(item) {
    if (state.haltedByError) {
      if (item?.el) state.elementState.delete(item.el);
      return;
    }
    state.pendingItems.push(item);
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        flushTranslationQueue();
      }, 60);
    }
  }

  async function flushTranslationQueue() {
    if (state.isTranslating || state.haltedByError || state.pendingItems.length === 0) return;
    state.isTranslating = true;
    const epoch = state.translationEpoch;
    const controller = new AbortController();
    state.activeController = controller;
    const pageContext = KCTSiteAnalyzer.classifyPage();
    updatePillStatus();

    try {
      while (state.pendingItems.length > 0 && epoch === state.translationEpoch && !state.haltedByError) {
        const batchSize = Math.max(1, Number(state.settings.batchSize || 16));
        const maxBatchChars = Math.max(800, Number(state.settings.maxBatchChars || 5500));
        const batch = [];
        let batchChars = 0;
        while (state.pendingItems.length > 0 && batch.length < batchSize) {
          const next = state.pendingItems[0];
          const nextLen = String(next?.text || '').length;
          if (batch.length > 0 && batchChars + nextLen > maxBatchChars) break;
          batch.push(state.pendingItems.shift());
          batchChars += nextLen;
        }
        if (batch.length === 0) break;

        await translateBatchItems(state.settings, batch, pageContext, (item, zh) => {
          if (epoch !== state.translationEpoch) return;
          if (item.kind === 'comment') {
            KCTCodeOverlay.renderCommentTranslation({ ...item, zh }, state.settings, state);
          } else {
            KCTRenderer.applyBlockTranslation({ ...item, zh }, state.settings, state);
          }
          state.totalTranslated += 1;
          updatePillStatus();
        }, controller.signal);
      }
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return;
      const fmt = formatApiError(err, err?.httpStatus, err?.errorCode);
      state.lastErrorMsg = fmt.shortMsg || err?.message || '翻譯失敗';
      if (isCircuitBreakingUserscriptError(err)) {
        state.haltedByError = true;
        releasePendingUserscriptItems();
        if (state.viewportObserver) state.viewportObserver.disconnect();
      }
      if (err?.errorCode === 'NO_API_KEY' || err?.errorCode === 'INVALID_API_KEY_CHARS') {
        openSettingsModal();
      }
    } finally {
      if (state.activeController === controller) {
        state.activeController = null;
      }
      state.isTranslating = false;
      updatePillStatus();
    }
  }

  function prepareBlockItem(el) {
    const { text, placeholders, nestedListEl } = KCTSiteAnalyzer.extractBlockContent(el);
    if (!KCTSiteAnalyzer.shouldTranslateText(text, state.settings.targetLang)) {
      state.elementState.set(el, 'skip');
      return null;
    }
    const typo = KCTSiteAnalyzer.probeTypography(el);
    return {
      kind: 'block',
      el,
      key: hashText(text),
      text,
      placeholders,
      nestedListEl,
      typo,
      epoch: state.translationEpoch
    };
  }

  function hookSpaNavigation() {
    if (state.spaHooked) return;
    state.spaHooked = true;
    const handleUrlChange = () => {
      const nextHrefPath = location.pathname + location.search;
      if (nextHrefPath === state.lastHrefPath) return;
      state.lastHrefPath = nextHrefPath;
      const wasActive = state.isPageActive;
      revertPageTranslation();
      if (wasActive || isHostWhitelisted(location.hostname, state.settings)) {
        setTimeout(() => {
          if (!state.isPageActive) startPageTranslation();
        }, 350);
      }
    };
    const wrapHistoryMethod = (methodName) => {
      const orig = history[methodName];
      if (typeof orig !== 'function') return;
      history[methodName] = function wrappedHistoryMethod(...args) {
        const res = orig.apply(this, args);
        setTimeout(handleUrlChange, 0);
        return res;
      };
    };
    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
    window.addEventListener('popstate', () => setTimeout(handleUrlChange, 0));
  }

  function startPageTranslation() {
    ensurePageStyleInjected();
    hookSpaNavigation();
    state.isPageActive = true;
    state.haltedByError = false;
    state.lastErrorMsg = '';
    KCTRenderer.applyDisplayModeClass({ ...state.settings, enabled: true });

    if (!state.viewportObserver) {
      state.viewportObserver = new IntersectionObserver(
        (entries) => {
          if (!state.isPageActive || state.haltedByError) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target;
            state.viewportObserver.unobserve(el);
            if (state.elementState.get(el) !== 'observed') continue;
            const item = prepareBlockItem(el);
            if (item) {
              state.elementState.set(el, 'queued');
              state.totalDetected += 1;
              enqueueItemForTranslation(item);
            }
          }
        },
        { rootMargin: '360px 0px', threshold: 0.01 }
      );
    }

    const roots = KCTSiteAnalyzer.findContentRoots('course');
    const candidates = KCTSiteAnalyzer.collectUniversalCandidateElements(roots, 'course', state.elementState);
    const vh = window.innerHeight || 800;

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const inView = rect.bottom >= -200 && rect.top <= vh + 280;
      if (inView) {
        const item = prepareBlockItem(el);
        if (item) {
          state.elementState.set(el, 'queued');
          state.totalDetected += 1;
          enqueueItemForTranslation(item);
        }
      } else {
        state.elementState.set(el, 'observed');
        state.viewportObserver.observe(el);
      }
    }

    const commentItems = KCTCodeOverlay.collectCodeComments(true, state.settings, state);
    for (const cItem of commentItems) {
      state.totalDetected += 1;
      enqueueItemForTranslation(cItem);
    }

    if (!state.domMutationObserver && document.body) {
      let mutTimer = null;
      state.domMutationObserver = new MutationObserver((mutations) => {
        if (!state.isPageActive || state.haltedByError) return;
        let hasNew = false;
        for (const m of mutations) {
          if (m.target?.closest?.('[data-kct-ui]')) continue;
          if (m.addedNodes && m.addedNodes.length > 0) {
            for (const n of m.addedNodes) {
              if (n.nodeType === 1 && !n.matches?.('[data-kct-ui]')) {
                hasNew = true;
                break;
              }
            }
          }
          if (hasNew) break;
        }
        if (hasNew) {
          if (mutTimer) clearTimeout(mutTimer);
          mutTimer = setTimeout(() => {
            if (state.isPageActive && !state.haltedByError) startPageTranslation();
          }, 320);
        }
      });
      state.domMutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    updatePillStatus();
  }

  function revertPageTranslation() {
    state.translationEpoch += 1;
    if (state.activeController) {
      try { state.activeController.abort(); } catch (_) {}
      state.activeController = null;
    }
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    releasePendingUserscriptItems();
    state.haltedByError = false;
    state.lastErrorMsg = '';
    if (state.viewportObserver) {
      state.viewportObserver.disconnect();
    }
    if (state.domMutationObserver) {
      state.domMutationObserver.disconnect();
      state.domMutationObserver = null;
    }
    KCTRenderer.clearAllInjectedTranslations(state, KCTCodeOverlay);
    state.isPageActive = false;
    state.isTranslating = false;
    updatePillStatus();
  }

  // ============================================================
  // 6. Shadow DOM Edge Tab ("NR") + Expandable Pill + Settings Modal
  // ============================================================
  let uiRefs = null;

  function buildShadowUI() {
    if (uiRefs || !document.body) return;
    const host = document.createElement('div');
    host.setAttribute('data-kct-ui', 'userscript-host');
    host.setAttribute('translate', 'no');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = \`
      :host {
        all: initial;
        position: fixed;
        right: 12px;
        bottom: max(18px, env(safe-area-inset-bottom, 18px));
        z-index: 2147483646;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", sans-serif;
        color: #f8fafc;
      }
      .nr-edge-tab {
        appearance: none;
        border: 1px solid rgba(148, 163, 184, 0.32);
        background: rgba(15, 23, 42, 0.78);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: #38bdf8;
        font-weight: 800;
        font-size: 12px;
        letter-spacing: 0.03em;
        width: 38px;
        height: 38px;
        border-radius: 999px;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.78;
        transition: opacity 0.16s ease, transform 0.16s ease;
        touch-action: none;
      }
      .nr-edge-tab:hover {
        opacity: 1;
        transform: scale(1.05);
      }
      .nr-pill {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.92);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
        font-size: 12px;
        max-width: calc(100vw - 24px);
        overflow-x: auto;
      }
      .nr-pill[hidden], .nr-edge-tab[hidden], .nr-modal-backdrop[hidden], .nr-toast[hidden] {
        display: none !important;
      }
      .nr-btn {
        appearance: none;
        border: 0;
        background: rgba(255, 255, 255, 0.1);
        color: #f1f5f9;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        padding: 5px 10px;
        border-radius: 999px;
        cursor: pointer;
        white-space: nowrap;
      }
      .nr-btn.is-primary {
        background: #0284c7;
        color: #ffffff;
      }
      .nr-btn.is-active {
        background: #38bdf8;
        color: #0f172a;
      }
      .nr-status {
        font-size: 11px;
        color: #94a3b8;
        white-space: nowrap;
        padding: 0 4px;
      }
      .nr-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(2, 6, 23, 0.65);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        z-index: 2147483647;
      }
      .nr-modal {
        width: 100%;
        max-width: 400px;
        background: #0f172a;
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 16px;
        padding: 18px;
        box-shadow: 0 24px 54px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .nr-modal-title {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        color: #f8fafc;
      }
      .nr-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .nr-field label {
        font-size: 11.5px;
        color: #cbd5e1;
        font-weight: 600;
      }
      .nr-field input, .nr-field select {
        font-family: inherit;
        font-size: 13px;
        padding: 7px 10px;
        border-radius: 8px;
        border: 1px solid rgba(148, 163, 184, 0.35);
        background: #1e293b;
        color: #f8fafc;
      }
      .nr-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 4px;
      }
      .nr-sync-box {
        padding: 9px 10px;
        border-radius: 10px;
        background: rgba(2, 132, 199, 0.12);
        border: 1px solid rgba(56, 189, 248, 0.28);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .nr-sync-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .nr-sync-row input {
        flex: 1 1 auto;
        min-width: 0;
        font-family: inherit;
        font-size: 12.5px;
        padding: 6px 8px;
        border-radius: 7px;
        border: 1px solid rgba(148, 163, 184, 0.35);
        background: #1e293b;
        color: #f8fafc;
      }
      .nr-sync-helper {
        align-self: flex-start;
        font-size: 11.5px;
        color: #38bdf8;
        background: transparent;
        border: 0;
        padding: 2px 0;
        cursor: pointer;
        text-decoration: underline;
      }
      .nr-toast {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        background: #0284c7;
        color: #fff;
        padding: 8px 16px;
        border-radius: 999px;
        font-size: 12.5px;
        font-weight: 600;
        box-shadow: 0 8px 24px rgba(2, 132, 199, 0.45);
      }
    \`;

    // Edge Tab ("NR")
    const edgeTab = document.createElement('button');
    edgeTab.type = 'button';
    edgeTab.className = 'nr-edge-tab';
    edgeTab.textContent = 'NR';
    edgeTab.title = '展開 NativeRead 原版排版翻譯';

    // Expanded Control Pill
    const pill = document.createElement('div');
    pill.className = 'nr-pill';
    pill.hidden = true;

    const translateBtn = document.createElement('button');
    translateBtn.type = 'button';
    translateBtn.className = 'nr-btn is-primary';
    translateBtn.textContent = '立即翻譯';

    const modeReplaceBtn = document.createElement('button');
    modeReplaceBtn.type = 'button';
    modeReplaceBtn.className = 'nr-btn is-active';
    modeReplaceBtn.textContent = '譯文';

    const modeBilingualBtn = document.createElement('button');
    modeBilingualBtn.type = 'button';
    modeBilingualBtn.className = 'nr-btn';
    modeBilingualBtn.textContent = '雙語';

    const modeOrigBtn = document.createElement('button');
    modeOrigBtn.type = 'button';
    modeOrigBtn.className = 'nr-btn';
    modeOrigBtn.textContent = '原文';

    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = 'nr-btn';
    starBtn.textContent = '☆';
    starBtn.title = '將此網站加入自動翻譯白名單';

    const gearBtn = document.createElement('button');
    gearBtn.type = 'button';
    gearBtn.className = 'nr-btn';
    gearBtn.textContent = '⚙';
    gearBtn.title = '設定 API Key 與模型';

    const statusSpan = document.createElement('span');
    statusSpan.className = 'nr-status';
    statusSpan.textContent = '就緒';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'nr-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = '收起懸浮膠囊';

    pill.append(
      translateBtn,
      modeReplaceBtn,
      modeBilingualBtn,
      modeOrigBtn,
      starBtn,
      gearBtn,
      statusSpan,
      closeBtn
    );

    // Settings Modal inside Shadow DOM
    const modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'nr-modal-backdrop';
    modalBackdrop.hidden = true;

    const modal = document.createElement('div');
    modal.className = 'nr-modal';

    const modalTitle = document.createElement('h3');
    modalTitle.className = 'nr-modal-title';
    modalTitle.textContent = '⚙ NativeRead 模型與 API Key 設定';

    const syncBox = document.createElement('div');
    syncBox.className = 'nr-sync-box';
    const syncLabel = document.createElement('label');
    syncLabel.style.fontSize = '11.5px';
    syncLabel.style.fontWeight = '600';
    syncLabel.style.color = '#e2e8f0';
    syncLabel.textContent = '從電腦端同步連結一鍵匯入';
    const syncRow = document.createElement('div');
    syncRow.className = 'nr-sync-row';
    const syncLinkInput = document.createElement('input');
    syncLinkInput.id = 'nr-modal-sync-input';
    syncLinkInput.type = 'text';
    syncLinkInput.placeholder = '貼上 #nr_sync=... 同步連結';
    const importSyncBtn = document.createElement('button');
    importSyncBtn.id = 'nr-modal-sync-import';
    importSyncBtn.type = 'button';
    importSyncBtn.className = 'nr-btn is-primary';
    importSyncBtn.textContent = '一鍵匯入';
    syncRow.append(syncLinkInput, importSyncBtn);
    const openSyncPageBtn = document.createElement('button');
    openSyncPageBtn.id = 'nr-modal-sync-page';
    openSyncPageBtn.type = 'button';
    openSyncPageBtn.className = 'nr-sync-helper';
    openSyncPageBtn.textContent = '開啟同步頁自動匯入 ↗';
    syncBox.append(syncLabel, syncRow, openSyncPageBtn);

    const makeField = (labelText, inputEl) => {
      const wrap = document.createElement('div');
      wrap.className = 'nr-field';
      const lbl = document.createElement('label');
      lbl.textContent = labelText;
      wrap.append(lbl, inputEl);
      return wrap;
    };

    const providerSelect = document.createElement('select');
    for (const p of Object.values(PROVIDER_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      providerSelect.appendChild(opt);
    }

    const protocolSelect = document.createElement('select');
    for (const [val, lbl] of [['openai', 'OpenAI 相容'], ['gemini', 'Google Gemini'], ['anthropic', 'Anthropic Claude']]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      protocolSelect.appendChild(opt);
    }

    const baseUrlInput = document.createElement('input');
    baseUrlInput.type = 'url';
    baseUrlInput.placeholder = 'https://...';

    const apiKeyInput = document.createElement('input');
    apiKeyInput.type = 'password';
    apiKeyInput.placeholder = '填入 API Key...';

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.placeholder = '模型名稱 (如 gemini-3.5-flash-lite)';

    const langSelect = document.createElement('select');
    for (const [id, info] of Object.entries(TARGET_LANGUAGES)) {
      if (id === 'custom' && state.settings?.targetLang !== 'custom' && !state.settings?.customTargetLang) continue;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id === 'custom'
        ? String(state.settings?.customTargetLang || info.label)
        : info.label;
      langSelect.appendChild(opt);
    }

    providerSelect.addEventListener('change', () => {
      const pid = providerSelect.value;
      const preset = PROVIDER_PRESETS[pid] || PROVIDER_PRESETS.gemini;
      const prof = state.settings?.providerProfiles?.[pid];
      protocolSelect.value = prof?.protocol || preset.protocol || 'openai';
      baseUrlInput.value = prof?.baseUrl || preset.baseUrl || '';
      modelInput.value = prof?.model || preset.defaultModel || '';
      apiKeyInput.value = prof?.apiKey || '';
    });

    const modalActions = document.createElement('div');
    modalActions.className = 'nr-modal-actions';

    const cancelModalBtn = document.createElement('button');
    cancelModalBtn.type = 'button';
    cancelModalBtn.className = 'nr-btn';
    cancelModalBtn.textContent = '取消';

    const saveModalBtn = document.createElement('button');
    saveModalBtn.type = 'button';
    saveModalBtn.className = 'nr-btn is-primary';
    saveModalBtn.textContent = '儲存並翻譯';

    modalActions.append(cancelModalBtn, saveModalBtn);
    modal.append(
      modalTitle,
      syncBox,
      makeField('AI 服務商', providerSelect),
      makeField('API 協定', protocolSelect),
      makeField('API Base URL', baseUrlInput),
      makeField('API Key 金鑰', apiKeyInput),
      makeField('模型 ID', modelInput),
      makeField('目標語言', langSelect),
      modalActions
    );
    modalBackdrop.appendChild(modal);

    const toast = document.createElement('div');
    toast.className = 'nr-toast';
    toast.hidden = true;

    shadow.append(style, edgeTab, pill, modalBackdrop, toast);
    document.body.appendChild(host);

    uiRefs = {
      host,
      edgeTab,
      pill,
      translateBtn,
      modeReplaceBtn,
      modeBilingualBtn,
      modeOrigBtn,
      starBtn,
      gearBtn,
      statusSpan,
      closeBtn,
      modalBackdrop,
      syncLinkInput,
      importSyncBtn,
      openSyncPageBtn,
      providerSelect,
      protocolSelect,
      baseUrlInput,
      apiKeyInput,
      modelInput,
      langSelect,
      cancelModalBtn,
      saveModalBtn,
      toast
    };

    // Vertical drag along screen edge for NR tab
    let dragStartY = 0;
    let startBottom = 18;
    let moved = false;
    edgeTab.addEventListener('pointerdown', (e) => {
      dragStartY = e.clientY;
      const computedBottom = parseFloat(getComputedStyle(host).bottom) || 18;
      startBottom = computedBottom;
      moved = false;
      edgeTab.setPointerCapture(e.pointerId);
    });
    edgeTab.addEventListener('pointermove', (e) => {
      if (!edgeTab.hasPointerCapture(e.pointerId)) return;
      const dy = dragStartY - e.clientY;
      if (Math.abs(dy) > 6) moved = true;
      if (moved) {
        const nextBottom = Math.max(12, Math.min(window.innerHeight - 60, startBottom + dy));
        host.style.bottom = \`\${Math.round(nextBottom)}px\`;
      }
    });
    edgeTab.addEventListener('pointerup', (e) => {
      if (edgeTab.hasPointerCapture(e.pointerId)) {
        edgeTab.releasePointerCapture(e.pointerId);
      }
      if (!moved) {
        edgeTab.hidden = true;
        pill.hidden = false;
      }
    });

    globalThis.__NATIVEREAD_OPEN_PILL__ = () => {
      edgeTab.hidden = true;
      pill.hidden = false;
      if (!state.isPageActive) {
        startPageTranslation();
      }
    };

    translateBtn.addEventListener('click', () => {
      if (state.isPageActive) {
        revertPageTranslation();
      }
      startPageTranslation();
    });

    const setDisplayMode = (mode) => {
      state.settings = writeStoredSettings({ displayMode: mode });
      KCTRenderer.applyDisplayModeClass({ ...state.settings, enabled: true });
      modeReplaceBtn.classList.toggle('is-active', mode === 'replace');
      modeBilingualBtn.classList.toggle('is-active', mode === 'bilingual');
      modeOrigBtn.classList.toggle('is-active', mode === 'original');
      if (!state.isPageActive && mode !== 'original') {
        startPageTranslation();
      }
    };

    modeReplaceBtn.addEventListener('click', () => setDisplayMode('replace'));
    modeBilingualBtn.addEventListener('click', () => setDisplayMode('bilingual'));
    modeOrigBtn.addEventListener('click', () => setDisplayMode('original'));

    starBtn.addEventListener('click', () => {
      const hostName = normalizeHostname(location.hostname);
      const cur = Array.isArray(state.settings.autoTranslateHosts) ? state.settings.autoTranslateHosts : [];
      const exists = isHostWhitelisted(hostName, state.settings);
      const nextHosts = exists
        ? cur.filter((h) => !(hostName === h || hostName.endsWith(\`.\${h}\`)))
        : [...cur, hostName];
      state.settings = writeStoredSettings({ autoTranslateHosts: nextHosts });
      updatePillStatus();
    });

    gearBtn.addEventListener('click', () => openSettingsModal());
    cancelModalBtn.addEventListener('click', () => { modalBackdrop.hidden = true; });

    openSyncPageBtn.addEventListener('click', () => {
      try {
        window.open('https://chih-kai-wang.github.io/native-read/', '_blank', 'noopener');
      } catch (_) {}
    });

    importSyncBtn.addEventListener('click', async () => {
      const ok = await tryImportNrSyncInput(syncLinkInput.value);
      if (!ok) {
        showToast('⚠️ 同步連結格式無效或金鑰不合法');
        return;
      }
      state.settings = readStoredSettings();
      syncLinkInput.value = '';
      openSettingsModal();
      modalBackdrop.hidden = true;
      updatePillStatus();
      showToast('✅ 已匯入電腦端設定！');
      if (state.isPageActive) {
        revertPageTranslation();
      }
      startPageTranslation();
    });

    saveModalBtn.addEventListener('click', () => {
      const pid = providerSelect.value;
      const preset = PROVIDER_PRESETS[pid] || PROVIDER_PRESETS.gemini;
      const nextUrl = String(baseUrlInput.value || preset.baseUrl || '').trim();
      try {
        const parsed = new URL(nextUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          showToast('⚠️ Base URL 必須為 http:// 或 https://');
          return;
        }
      } catch (_) {
        showToast('⚠️ 請輸入有效的 API Base URL');
        return;
      }
      const keyCheck = validateApiKey(apiKeyInput.value);
      if (!keyCheck.ok) {
        showToast(\`⚠️ \${keyCheck.error}\`);
        return;
      }
      const nextProtocol = protocolSelect.value || preset.protocol || 'openai';
      const nextModel = modelInput.value.trim() || preset.defaultModel || '';
      const mergedProfiles = normalizeProviderProfiles(state.settings?.providerProfiles, {
        providerId: pid,
        protocol: nextProtocol,
        baseUrl: nextUrl,
        apiKey: keyCheck.cleanKey,
        model: nextModel
      });
      state.settings = writeStoredSettings({
        providerId: pid,
        protocol: nextProtocol,
        baseUrl: nextUrl,
        apiKey: keyCheck.cleanKey,
        model: nextModel,
        providerProfiles: mergedProfiles,
        targetLang: langSelect.value
      });
      modalBackdrop.hidden = true;
      if (state.isPageActive) {
        revertPageTranslation();
      }
      startPageTranslation();
    });

    closeBtn.addEventListener('click', () => {
      pill.hidden = true;
      edgeTab.hidden = false;
    });

    updatePillStatus();
  }

  function openSettingsModal() {
    if (!uiRefs) buildShadowUI();
    if (!uiRefs) return;
    uiRefs.edgeTab.hidden = true;
    uiRefs.pill.hidden = false;
    const pid = PROVIDER_PRESETS[state.settings.providerId] ? state.settings.providerId : 'custom';
    const preset = PROVIDER_PRESETS[pid] || PROVIDER_PRESETS.gemini;
    if (uiRefs.syncLinkInput) uiRefs.syncLinkInput.value = '';
    if (uiRefs.openSyncPageBtn) uiRefs.openSyncPageBtn.hidden = Boolean(sanitizeApiKey(state.settings?.apiKey));
    uiRefs.providerSelect.value = pid;
    if (uiRefs.protocolSelect) uiRefs.protocolSelect.value = state.settings.protocol || preset.protocol || 'openai';
    if (uiRefs.baseUrlInput) uiRefs.baseUrlInput.value = state.settings.baseUrl || preset.baseUrl || '';
    uiRefs.apiKeyInput.value = state.settings.apiKey || '';
    uiRefs.modelInput.value = state.settings.model || '';
    uiRefs.langSelect.value = state.settings.targetLang || 'zh-TW';
    uiRefs.modalBackdrop.hidden = false;
  }

  function showToast(msg) {
    if (!uiRefs) buildShadowUI();
    if (!uiRefs) return;
    uiRefs.toast.textContent = msg;
    uiRefs.toast.hidden = false;
    setTimeout(() => {
      uiRefs.toast.hidden = true;
    }, 3500);
  }

  function updatePillStatus() {
    if (!uiRefs) return;
    const whitelisted = isHostWhitelisted(location.hostname, state.settings);
    uiRefs.starBtn.textContent = whitelisted ? '★' : '☆';
    uiRefs.starBtn.classList.toggle('is-active', whitelisted);

    if (state.lastErrorMsg) {
      uiRefs.statusSpan.textContent = state.lastErrorMsg;
      return;
    }
    if (state.isTranslating) {
      uiRefs.statusSpan.textContent = \`翻譯中 \${state.totalTranslated}/\${state.totalDetected}\`;
    } else if (state.totalTranslated > 0) {
      uiRefs.statusSpan.textContent = \`已譯 \${state.totalTranslated} 段\`;
    } else {
      uiRefs.statusSpan.textContent = '就緒';
    }
  }

  // ============================================================
  // 7. Boot
  // ============================================================
  async function boot() {
    if (!KCTSiteAnalyzer.isTopFrame()) return;
    await initStoredSettings();
    let synced = await checkAndApplyNrSyncHash();
    if (!synced) {
      synced = await trySyncFromTrustedPwaStorage();
    }
    state.settings = readStoredSettings();
    buildShadowUI();
    if (synced) {
      showToast('✅ 已從電腦端同步 API Key 與偏好設定！');
    }
    if (isTrustedOriginForFallback()) {
      window.addEventListener?.('nativeread:pwa-settings-synced', () => {
        void (async () => {
          const ok = await trySyncFromTrustedPwaStorage();
          if (ok) {
            state.settings = readStoredSettings();
            updatePillStatus();
            showToast('✅ 已從本頁同步 API Key 與偏好設定！');
          }
        })();
      });
      window.addEventListener?.('storage', (e) => {
        if (e && e.key && e.key !== SETTINGS_KEY) return;
        void (async () => {
          const ok = await trySyncFromTrustedPwaStorage();
          if (ok) {
            state.settings = readStoredSettings();
            updatePillStatus();
          }
        })();
      });
    }
    if (isHostWhitelisted(location.hostname, state.settings)) {
      startPageTranslation();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void boot(); }, { once: true });
  } else {
    void boot();
  }
})();
`;

  const output = [
    header,
    '',
    configJs.trim(),
    '',
    siteAnalyzerJs.trim(),
    '',
    codeOverlayJs.trim(),
    '',
    rendererJs.trim(),
    '',
    runtimeJs.trim(),
    ''
  ].join('\n');

  const outPath = path.join(DOCS_DIR, 'nativeread.user.js');
  fs.writeFileSync(outPath, output, 'utf8');
  console.log(`[build-mobile] Generated ${outPath} (${Buffer.byteLength(output)} bytes)`);
  writeUserscriptMeta(header);
}

function buildAndroidExtensionZip() {
  const zipPath = path.join(DOCS_DIR, 'nativeread-android-extension.zip');
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
  const readmeFiles = fs
    .readdirSync(ROOT)
    .filter((name) => /^README(\.[A-Za-z0-9_-]+)?\.md$/.test(name));
  const itemsToInclude = [
    'manifest.json',
    'shared',
    'background',
    'content',
    'popup',
    'options',
    'viewer',
    'vendor',
    'icons',
    'LICENSE',
    ...readmeFiles
  ].filter((rel) => fs.existsSync(path.join(ROOT, rel)));

  execFileSync('zip', ['-rq', zipPath, ...itemsToInclude], { cwd: ROOT });
  const stat = fs.statSync(zipPath);
  console.log(`[build-mobile] Generated ${zipPath} (${stat.size} bytes)`);
}

// Generate docs/providers.js from shared/config.js so the PWA never carries a stale copy.
function writePwaProviders() {
  const vm = require('vm');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readUtf8('shared/config.js'), sandbox, { filename: 'shared/config.js' });
  const presets = sandbox.KCTConfig && sandbox.KCTConfig.PROVIDER_PRESETS;
  if (!presets || typeof presets !== 'object' || !presets.custom) {
    throw new Error('shared/config.js did not expose KCTConfig.PROVIDER_PRESETS (with a custom entry)');
  }
  for (const [id, p] of Object.entries(presets)) {
    if (p.id !== id || !p.protocol || !p.label || typeof p.baseUrl !== 'string') {
      throw new Error(`Provider preset "${id}" is missing id/protocol/label/baseUrl`);
    }
  }
  const outPath = path.join(DOCS_DIR, 'providers.js');
  const content =
    '// AUTO-GENERATED by scripts/build-mobile.js from shared/config.js — do not edit.\n' +
    `export const PROVIDER_PRESETS = ${JSON.stringify(presets, null, 2)};\n`;
  fs.writeFileSync(outPath, content, 'utf8');
  console.log(`[build-mobile] Generated ${outPath} (${Object.keys(presets).length} providers)`);
}

function main() {
  const version = readReleaseVersion();
  console.log(`[build-mobile] Release version ${version}`);

  ensureDir(DOCS_DIR);

  // 1. Copy vendor/pdfjs/* -> docs/vendor/pdfjs/, icons/* -> docs/icons/, and shared/pdf-layout.mjs -> docs/pdf-layout.mjs
  copyDirectory(path.join(ROOT, 'vendor', 'pdfjs'), path.join(DOCS_DIR, 'vendor', 'pdfjs'));
  copyDirectory(path.join(ROOT, 'icons'), path.join(DOCS_DIR, 'icons'));
  fs.copyFileSync(path.join(ROOT, 'shared', 'pdf-layout.mjs'), path.join(DOCS_DIR, 'pdf-layout.mjs'));

  // 2. Write docs/.nojekyll so GitHub Pages serves .mjs and all assets without Jekyll filtering
  fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '', 'utf8');

  // 3. Sync version into PWA service worker cache name & index.html badge
  syncPwaVersion(version);

  // 3b. Generate docs/providers.js (PWA provider registry) from shared/config.js
  writePwaProviders();

  // 4. Build docs/nativeread.user.js and docs/nativeread.meta.js
  buildUserscript(version);

  // 5. Build docs/nativeread-android-extension.zip
  buildAndroidExtensionZip();

  // 6. Write docs/version.json
  writeVersionJson(version);
}

main();
