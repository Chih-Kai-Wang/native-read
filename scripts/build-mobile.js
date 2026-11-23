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
    sanitizeApiKey,
    hashText
  } = globalThis.KCTConfig;

  const KCTSiteAnalyzer = globalThis.KCTSiteAnalyzer;
  const KCTRenderer = globalThis.KCTRenderer;
  const KCTCodeOverlay = globalThis.KCTCodeOverlay;

  const PAGE_STYLE_CSS = ${JSON.stringify(contentCss)};

  // ============================================================
  // 1. Storage Adapter (GM_getValue / GM_setValue + localStorage)
  // ============================================================
  function readStoredSettings() {
    let raw = null;
    try {
      if (typeof GM_getValue === 'function') {
        raw = GM_getValue(SETTINGS_KEY, null);
      }
    } catch (_) {}
    if (!raw) {
      try {
        raw = localStorage.getItem(SETTINGS_KEY);
      } catch (_) {}
    }
    if (!raw) {
      return { ...DEFAULT_SETTINGS, providerId: 'gemini', protocol: 'gemini', baseUrl: PROVIDER_PRESETS.gemini.baseUrl, model: PROVIDER_PRESETS.gemini.defaultModel, autoTranslateHosts: [] };
    }
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        autoTranslateHosts: Array.isArray(parsed?.autoTranslateHosts)
          ? parsed.autoTranslateHosts.map(normalizeHostname).filter(Boolean)
          : []
      };
    } catch (_) {
      return { ...DEFAULT_SETTINGS, autoTranslateHosts: [] };
    }
  }

  function writeStoredSettings(partial) {
    const current = readStoredSettings();
    const next = {
      ...current,
      ...partial
    };
    if (Array.isArray(next.autoTranslateHosts)) {
      next.autoTranslateHosts = Array.from(new Set(next.autoTranslateHosts.map(normalizeHostname).filter(Boolean)));
    } else {
      next.autoTranslateHosts = [];
    }
    const serialized = JSON.stringify(next);
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(SETTINGS_KEY, serialized);
      }
    } catch (_) {}
    try {
      localStorage.setItem(SETTINGS_KEY, serialized);
    } catch (_) {}
    return next;
  }

  // Override KCTConfig.getSettings / saveSettings so shared modules work seamlessly
  globalThis.KCTConfig.getSettings = async () => readStoredSettings();
  globalThis.KCTConfig.saveSettings = async (partial) => writeStoredSettings(partial);

  // ============================================================
  // 2. #nr_sync Zero-Typing Sync Decoder
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

      writeStoredSettings({
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
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  // 3. Persistent Cache (IndexedDB + GM memory fallback)
  // ============================================================
  const DB_NAME = 'kct_cache_db_v2';
  const STORE_NAME = 'entries';
  let dbPromise = null;
  const memCache = new Map();

  function openCacheDB() {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('No IDB'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); };
      } catch (e) {
        dbPromise = null;
        reject(e);
      }
    });
    return dbPromise;
  }

  async function cacheGetMany(keys) {
    const out = new Map();
    for (const k of keys) {
      if (memCache.has(k)) out.set(k, memCache.get(k));
    }
    try {
      const db = await openCacheDB();
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
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
      });
    } catch (_) {}
    return out;
  }

  async function cachePutMany(entries) {
    for (const e of entries) {
      if (e?.key && e?.zh) memCache.set(e.key, e.zh);
    }
    try {
      const db = await openCacheDB();
      const now = Date.now();
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        entries.forEach((e, idx) => {
          if (e?.key && e?.zh) store.put({ key: e.key, zh: e.zh, ts: now + idx });
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
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

  function buildRequestPayload(settings, messages, stream) {
    const cleanKey = sanitizeApiKey(settings.apiKey);
    const headers = { 'Content-Type': 'application/json' };
    if (settings.protocol === 'gemini') {
      if (cleanKey) headers['x-goog-api-key'] = cleanKey;
      const sys = messages.find((m) => m.role === 'system');
      const usr = messages.filter((m) => m.role !== 'system');
      const normModel = String(settings.model || '').replace(/^models\\//i, '').trim().toLowerCase();
      const isG3Or4 = /^gemini-(?:3|4)(?:[.\\-]|$)/.test(normModel);
      const generationConfig = {};
      if (!isG3Or4) generationConfig.temperature = Number(settings.temperature ?? 0.2);
      const tc = resolveThinkingConfig(settings.model, settings.thinkingEffort || 'fastest');
      if (tc) generationConfig.thinkingConfig = tc;
      const body = {
        contents: usr.map((m) => ({ role: 'user', parts: [{ text: m.content }] })),
        generationConfig
      };
      if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
      return {
        url: stream ? resolveStreamEndpoint(settings) : resolveEndpoint(settings),
        headers,
        body: JSON.stringify(body)
      };
    } else if (settings.protocol === 'anthropic') {
      // Claude Messages API (no temperature / thinking fields; JSON is requested in the prompt)
      const body = buildAnthropicMessagesBody(settings, messages, { stream: Boolean(stream), maxTokens: 32000 });
      return {
        url: resolveEndpoint(settings),
        headers: buildProviderAuthHeaders(settings, cleanKey),
        body: JSON.stringify(body)
      };
    } else {
      // OpenAI-compatible; Azure OpenAI endpoints get the api-key header
      Object.assign(headers, buildProviderAuthHeaders(settings, cleanKey));
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

  function callViaGmXhr(reqConfig) {
    const gmXhr = typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);
    if (!gmXhr) {
      return Promise.reject(new Error('此頁面 CSP 阻擋了直接連線，請在 Tampermonkey / Stay Userscript 環境執行'));
    }
    return new Promise((resolve, reject) => {
      gmXhr({
        method: 'POST',
        url: reqConfig.url,
        headers: reqConfig.headers,
        data: reqConfig.body,
        timeout: 35000,
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText || '');
          } else {
            reject(new Error(\`HTTP \${res.status}: \${String(res.responseText || '').slice(0, 180)}\`));
          }
        },
        onerror() {
          reject(new Error('GM_xmlhttpRequest 網路請求失敗'));
        },
        ontimeout() {
          reject(new Error('GM_xmlhttpRequest 請求逾時'));
        }
      });
    });
  }

  async function translateBatchItems(settings, items, pageContext, onItem) {
    if (!items || items.length === 0) return;
    const cleanKey = sanitizeApiKey(settings.apiKey);
    if (!cleanKey && !/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)/i.test(settings.baseUrl || '')) {
      const err = new Error('請先點擊 ⚙ 設定 API Key');
      err.errorCode = 'NO_API_KEY';
      throw err;
    }
    if (!String(settings.model || '').trim()) {
      const err = new Error('請先點擊 ⚙ 設定並填入模型名稱');
      err.errorCode = 'NO_MODEL';
      throw err;
    }

    const sig = buildCacheSignature(settings);
    const cacheKeys = items.map((it) => \`\${sig}::\${it.key}\`);
    const hits = await cacheGetMany(cacheKeys);
    const uncached = [];

    for (let i = 0; i < items.length; i++) {
      const hit = hits.get(cacheKeys[i]);
      if (hit) {
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
          toCache.push({ key: \`\${sig}::\${item.key}\`, zh: entry.text });
        }
      }
    };

    try {
      const reqConfig = buildRequestPayload(settings, messages, true);
      const response = await fetch(reqConfig.url, {
        method: 'POST',
        headers: reqConfig.headers,
        body: reqConfig.body
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(\`HTTP \${response.status}: \${errText.slice(0, 180)}\`);
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
          try {
            const delta = extractDelta(settings.protocol, JSON.parse(d));
            if (delta) {
              ndjsonBuf += delta;
              let nl;
              while ((nl = ndjsonBuf.indexOf('\\n')) !== -1) {
                const l = ndjsonBuf.slice(0, nl);
                ndjsonBuf = ndjsonBuf.slice(nl + 1);
                handleLine(l);
              }
            }
          } catch (_) {}
        };
        while (true) {
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
        if (sseBuf.trim()) processSse(sseBuf);
        if (ndjsonBuf.trim()) handleLine(ndjsonBuf);
      } else {
        const rawText = await response.text();
        for (const l of rawText.split('\\n')) handleLine(l);
      }
    } catch (fetchErr) {
      // Automatic fallback to GM_xmlhttpRequest if page CSP blocks connect-src!
      const nonStreamConfig = buildRequestPayload(settings, messages, false);
      const rawResp = await callViaGmXhr(nonStreamConfig);
      try {
        const parsed = JSON.parse(rawResp);
        const fullText = extractDelta(settings.protocol, parsed);
        for (const l of String(fullText || '').split('\\n')) handleLine(l);
      } catch (_) {
        for (const l of String(rawResp || '').split('\\n')) handleLine(l);
      }
    }

    if (toCache.length > 0) {
      await cachePutMany(toCache);
    }
  }

  // ============================================================
  // 5. Page Translation Orchestrator + Lazy IntersectionObserver
  // ============================================================
  const state = {
    settings: readStoredSettings(),
    isPageActive: false,
    isTranslating: false,
    translationEpoch: 0,
    elementState: new WeakMap(),
    pendingItems: [],
    totalDetected: 0,
    totalTranslated: 0,
    lastErrorMsg: '',
    viewportObserver: null,
    flushTimer: null
  };

  function ensurePageStyleInjected() {
    if (document.querySelector('style[data-kct-ui="page-style"]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-kct-ui', 'page-style');
    style.textContent = PAGE_STYLE_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function enqueueItemForTranslation(item) {
    state.pendingItems.push(item);
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        flushTranslationQueue();
      }, 60);
    }
  }

  async function flushTranslationQueue() {
    if (state.isTranslating || state.pendingItems.length === 0) return;
    state.isTranslating = true;
    const epoch = state.translationEpoch;
    const pageContext = KCTSiteAnalyzer.classifyPage();
    updatePillStatus();

    try {
      while (state.pendingItems.length > 0 && epoch === state.translationEpoch) {
        const batchSize = Math.max(1, Number(state.settings.batchSize || 16));
        const batch = state.pendingItems.splice(0, batchSize);

        await translateBatchItems(state.settings, batch, pageContext, (item, zh) => {
          if (epoch !== state.translationEpoch) return;
          if (item.kind === 'comment') {
            KCTCodeOverlay.renderCommentTranslation({ ...item, zh }, state.settings, state);
          } else {
            KCTRenderer.applyBlockTranslation({ ...item, zh }, state.settings, state);
          }
          state.totalTranslated += 1;
          updatePillStatus();
        });
      }
    } catch (err) {
      state.lastErrorMsg = err?.message || '翻譯失敗';
      if (err?.errorCode === 'NO_API_KEY') {
        openSettingsModal();
      }
    } finally {
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

  function startPageTranslation() {
    ensurePageStyleInjected();
    state.isPageActive = true;
    state.lastErrorMsg = '';
    KCTRenderer.applyDisplayModeClass({ ...state.settings, enabled: true });

    if (!state.viewportObserver) {
      state.viewportObserver = new IntersectionObserver(
        (entries) => {
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
        if (!state.isPageActive) return;
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
            if (state.isPageActive) startPageTranslation();
          }, 320);
        }
      });
      state.domMutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    updatePillStatus();
  }

  function revertPageTranslation() {
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
      const preset = PROVIDER_PRESETS[providerSelect.value] || PROVIDER_PRESETS.gemini;
      modelInput.value = preset.defaultModel || '';
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
      makeField('AI 服務商', providerSelect),
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
      providerSelect,
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

    saveModalBtn.addEventListener('click', () => {
      const pid = providerSelect.value;
      const preset = PROVIDER_PRESETS[pid] || PROVIDER_PRESETS.gemini;
      state.settings = writeStoredSettings({
        providerId: pid,
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        apiKey: sanitizeApiKey(apiKeyInput.value),
        model: modelInput.value.trim() || preset.defaultModel,
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
    uiRefs.providerSelect.value = PROVIDER_PRESETS[state.settings.providerId] ? state.settings.providerId : 'gemini';
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
  function boot() {
    if (!KCTSiteAnalyzer.isTopFrame()) return;
    const synced = checkAndApplyNrSyncHash();
    state.settings = readStoredSettings();
    buildShadowUI();
    if (synced) {
      showToast('✅ 已從電腦端同步 API Key 與偏好設定！');
    }
    if (isHostWhitelisted(location.hostname, state.settings)) {
      startPageTranslation();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
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
