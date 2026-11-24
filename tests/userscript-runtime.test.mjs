import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function runUserscriptInSandbox({
  pageUrl = 'https://untrusted.example.com/blog',
  initialGm = null,
  initialLocalStorage = null,
  withGm = true,
  fetchImpl,
  gmXhrImpl,
  globalsBeforeRun = null
} = {}) {
  const usCode = fs.readFileSync(path.join(REPO_ROOT, 'docs/nativeread.user.js'), 'utf8');
  const parsedUrl = new URL(pageUrl);
  const gmStore = initialGm ? { ...initialGm } : {};
  const localStore = new Map(initialLocalStorage ? Object.entries(initialLocalStorage) : []);
  let localStorageWrites = 0;
  let gmXhrCalls = 0;
  let replaceStateCalls = 0;

  class MockElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.childNodes = this.children;
      this.parentNode = null;
      this.parentElement = null;
      this.attributes = new Map();
      this.dataset = {};
      this.style = {
        setProperty(k, v) { this[k] = v; },
        removeProperty(k) { delete this[k]; }
      };
      this.isConnected = true;
      this.offsetWidth = 600;
      this.offsetHeight = 70;
      this.clientWidth = 600;
      this.clientHeight = 70;
      this.hidden = false;
      this.type = '';
      this.value = '';
      this.title = '';
      this._classSet = new Set();
      this._listeners = new Map();
      this._text = '';
      this.shadowRoot = null;
      const self = this;
      this.classList = {
        add(...cls) { cls.forEach((c) => self._classSet.add(c)); },
        remove(...cls) { cls.forEach((c) => self._classSet.delete(c)); },
        contains(c) { return self._classSet.has(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (self._classSet.has(c)) { self._classSet.delete(c); return false; }
            self._classSet.add(c); return true;
          }
          if (force) { self._classSet.add(c); return true; }
          self._classSet.delete(c); return false;
        }
      };
    }
    attachShadow() {
      this.shadowRoot = new MockElement('shadow-root');
      return this.shadowRoot;
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }
    appendChild(c) { if (c) { c.parentNode = this; c.parentElement = this; this.children.push(c); } return c; }
    append(...nodes) { nodes.forEach((n) => this.appendChild(typeof n === 'string' ? { nodeType: 3, textContent: n } : n)); }
    replaceChildren(...nodes) { this.children.length = 0; this.append(...nodes); }
    remove() {}
    contains(o) { return o === this || this.children.some((c) => typeof c.contains === 'function' && c.contains(o)); }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchesUserscriptSel(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    matches(sel) { return matchesUserscriptSel(this, sel); }
    querySelector(sel) { return findAll(this, sel)[0] || null; }
    querySelectorAll(sel) { return findAll(this, sel); }
    getBoundingClientRect() { return { top: 40, bottom: 120, left: 0, right: 500, width: 500, height: 80 }; }
    getClientRects() { return [this.getBoundingClientRect()]; }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    click() {
      const fns = this._listeners.get('click') || [];
      fns.forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
    }
    setPointerCapture() {}
    hasPointerCapture() { return false; }
    releasePointerCapture() {}
    get innerText() { return this.textContent; }
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this.children.map((c) => c.textContent ?? c._text ?? '').join('');
    }
    set textContent(v) {
      this.children.length = 0;
      const str = String(v ?? '');
      this._text = str;
      if (str) {
        this.children.push({ nodeType: 3, textContent: str, nodeValue: str, parentNode: this, parentElement: this });
      }
    }
    get className() { return Array.from(this._classSet).join(' '); }
    set className(v) { this._classSet = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  }

  function matchesCompound(el, compound) {
    let rest = compound.trim();
    if (!rest) return false;
    while (rest.length > 0) {
      const notMatch = rest.match(/^:not\(([^)]+)\)/);
      if (notMatch) {
        if (matchesCompound(el, notMatch[1])) return false;
        rest = rest.slice(notMatch[0].length);
        continue;
      }
      const attrMatch = rest.match(/^\[([^=\]]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/);
      if (attrMatch) {
        const attr = attrMatch[1].trim();
        const expected = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
        if (expected === undefined) {
          if (!el.hasAttribute(attr)) return false;
        } else if (el.getAttribute(attr) !== expected) {
          return false;
        }
        rest = rest.slice(attrMatch[0].length);
        continue;
      }
      const clsMatch = rest.match(/^\.([A-Za-z0-9_-]+)/);
      if (clsMatch) {
        if (!el.classList.contains(clsMatch[1])) return false;
        rest = rest.slice(clsMatch[0].length);
        continue;
      }
      const idMatch = rest.match(/^#([A-Za-z0-9_-]+)/);
      if (idMatch) {
        if (el.getAttribute('id') !== idMatch[1]) return false;
        rest = rest.slice(idMatch[0].length);
        continue;
      }
      const tagMatch = rest.match(/^([A-Za-z0-9*]+)/);
      if (tagMatch) {
        if (tagMatch[1] !== '*' && el.tagName !== tagMatch[1].toUpperCase()) return false;
        rest = rest.slice(tagMatch[0].length);
        continue;
      }
      return false;
    }
    return true;
  }

  function matchesUserscriptSel(el, sel) {
    if (!el || el.nodeType !== 1 || typeof sel !== 'string') return false;
    return sel.split(',').some((raw) => {
      const parts = raw.trim().split(/\s+/).filter(Boolean);
      if (!parts.length || !matchesCompound(el, parts[parts.length - 1])) return false;
      let ancestor = el.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (ancestor && !matchesCompound(ancestor, parts[i])) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }

  function findAll(root, sel, out = []) {
    for (const c of root.children || []) {
      if (c.nodeType === 1) {
        if (matchesUserscriptSel(c, sel)) out.push(c);
        findAll(c, sel, out);
      }
    }
    return out;
  }

  const head = new MockElement('head');
  const body = new MockElement('body');
  const docEl = new MockElement('html');
  docEl.append(head, body);

  const p = new MockElement('p');
  p.textContent = 'This long English academic sentence must be translated by the userscript runtime.';
  const main = new MockElement('main');
  main.appendChild(p);
  body.appendChild(main);

  const context = {
    globalThis: null,
    console,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    DOMException,
    Response,
    WeakMap,
    Map,
    Set,
    setTimeout: (fn, ms, ...a) => setTimeout(fn, ms >= 300 ? 10 : ms, ...a),
    clearTimeout,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    window: null,
    document: {
      documentElement: docEl,
      head,
      body,
      title: 'Userscript Fixture',
      readyState: 'complete',
      createElement: (t) => new MockElement(t),
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t ?? '') }),
      querySelector: (s) => findAll(docEl, s)[0] || null,
      querySelectorAll: (s) => findAll(docEl, s),
      addEventListener() {},
      removeEventListener() {}
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({
      fontFamily: 'Georgia, serif',
      fontSize: '16px',
      lineHeight: '24px',
      fontWeight: '400',
      fontStyle: 'normal',
      color: 'rgb(0, 0, 0)',
      direction: 'ltr',
      textAlign: 'left',
      textTransform: 'none',
      letterSpacing: 'normal',
      visibility: 'visible',
      display: 'block',
      getPropertyValue(prop) {
        const camel = String(prop || '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        return this[camel] ?? this[prop] ?? '';
      }
    }),
    history: {
      pushState() {},
      replaceState() { replaceStateCalls += 1; parsedUrl.hash = ''; }
    },
    location: parsedUrl,
    innerHeight: 800,
    innerWidth: 1280,
    localStorage: {
      getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
      setItem: (k, v) => { localStorageWrites += 1; localStore.set(k, String(v)); }
    },
    fetch: (...args) => (fetchImpl ? fetchImpl(...args) : Promise.reject(new TypeError('Failed to fetch'))),
    GM_xmlhttpRequest: (opts) => {
      gmXhrCalls += 1;
      if (gmXhrImpl) gmXhrImpl(opts);
      else opts.onload?.({ status: 200, responseText: '{"i":0,"t":"GM後端譯文"}\n' });
      return { abort() {} };
    }
  };
  if (withGm) {
    context.GM_getValue = (k, def) => (k in gmStore ? gmStore[k] : def);
    context.GM_setValue = (k, v) => { gmStore[k] = v; };
  }
  context.globalThis = context;
  context.window = context;
  context.self = context;
  context.top = context;
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.document.defaultView = context;
  if (globalsBeforeRun && typeof globalsBeforeRun === 'object') {
    Object.assign(context, globalsBeforeRun);
  }

  vm.runInNewContext(usCode, context, { filename: 'docs/nativeread.user.js' });
  return {
    usCode,
    context,
    body,
    gmStore,
    localStore,
    getLocalStorageWrites: () => localStorageWrites,
    getGmXhrCalls: () => gmXhrCalls,
    getReplaceStateCalls: () => replaceStateCalls
  };
}

test('nativeread.user.js declares GM.getValue & GM.setValue grants and isolates untrusted storage', async () => {
  const payload = Buffer.from(JSON.stringify({
    p: 'openai',
    r: 'openai',
    k: 'sk-secret-gm-isolated-001',
    m: 'gpt-4o-mini'
  })).toString('base64url');

  // Untrusted origin with #nr_sync must ignore sync AND must not leak any API key to page localStorage
  const env = runUserscriptInSandbox({
    pageUrl: `https://untrusted.example.com/news#nr_sync=${payload}`,
    withGm: true
  });
  await new Promise((r) => setTimeout(r, 30));

  assert.match(env.usCode, /@grant\s+GM\.getValue/);
  assert.match(env.usCode, /@grant\s+GM\.setValue/);
  assert.equal(env.gmStore.kct_settings_v1, undefined, 'Untrusted origin did NOT import #nr_sync');
  assert.equal(env.getLocalStorageWrites(), 0, 'Zero writes to page localStorage on untrusted origin');

  // Saving settings via KCTConfig.saveSettings writes only to GM storage, zero localStorage
  await env.context.KCTConfig.saveSettings({ apiKey: 'sk-only-in-gm-store-999' });
  assert.match(String(env.gmStore.kct_settings_v1 || ''), /sk-only-in-gm-store-999/);
  assert.equal(env.getLocalStorageWrites(), 0, 'GM storage never spills keys to page localStorage');
});

test('trusted GitHub Pages origin imports #nr_sync and scrubs location hash', async () => {
  const payload = Buffer.from(JSON.stringify({
    p: 'anthropic',
    r: 'anthropic',
    k: 'sk-ant-trusted-mobile-99',
    m: 'claude-sonnet-4-6'
  })).toString('base64url');

  const env = runUserscriptInSandbox({
    pageUrl: `https://chih-kai-wang.github.io/native-read/#nr_sync=${payload}`,
    withGm: true
  });
  await new Promise((r) => setTimeout(r, 40));

  assert.ok(env.gmStore.kct_settings_v1, 'Trusted origin persisted synced settings to GM storage');
  assert.match(String(env.gmStore.kct_settings_v1), /sk-ant-trusted-mobile-99/);
  assert.equal(env.getReplaceStateCalls(), 1, 'Scrubbed #nr_sync from location bar');
});

test('HTTP 401 does NOT double-fire into GM_xmlhttpRequest, whereas CORS/network TypeError does', async () => {
  const seeded = JSON.stringify({
    providerId: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-http-err-test-001',
    model: 'gpt-4o-mini',
    autoTranslateHosts: []
  });

  // 1) HTTP 401 from fetch must NOT trigger GM_xmlhttpRequest fallback
  const httpEnv = runUserscriptInSandbox({
    pageUrl: 'https://example.org/doc',
    initialGm: { kct_settings_v1: seeded },
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 })
  });
  await new Promise((r) => setTimeout(r, 30));
  httpEnv.context.__NATIVEREAD_OPEN_PILL__();
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(httpEnv.getGmXhrCalls(), 0, 'HTTP 401 never double-fired into GM_xmlhttpRequest');

  // 2) Transport/CSP TypeError('Failed to fetch') DOES fall back to GM_xmlhttpRequest
  const cspEnv = runUserscriptInSandbox({
    pageUrl: 'https://example.org/doc',
    initialGm: { kct_settings_v1: seeded },
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); }
  });
  await new Promise((r) => setTimeout(r, 30));
  cspEnv.context.__NATIVEREAD_OPEN_PILL__();
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(cspEnv.getGmXhrCalls(), 1, 'CSP/network TypeError fell back cleanly to GM_xmlhttpRequest');
});

test('trusted PWA origin localStorage automatically bridges into GM storage when Userscript installed after QR scan', async () => {
  const preSyncedPwaSettings = JSON.stringify({
    settingsSchemaVersion: 6,
    providerId: 'gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIza-bridge-after-qr-001',
    model: 'gemini-3.5-flash-lite',
    targetLang: 'zh-TW',
    syncedAt: 1700000123456
  });

  const env = runUserscriptInSandbox({
    pageUrl: 'https://chih-kai-wang.github.io/native-read/',
    withGm: true,
    initialGm: null,
    initialLocalStorage: { kct_settings_v1: preSyncedPwaSettings }
  });
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(env.gmStore.kct_settings_v1, 'Trusted PWA localStorage bridged automatically into GM storage');
  const saved = JSON.parse(String(env.gmStore.kct_settings_v1));
  assert.equal(saved.apiKey, 'AIza-bridge-after-qr-001');
  assert.equal(saved.model, 'gemini-3.5-flash-lite');
});

test('untrusted origin seeded localStorage never bridges into GM storage and causes zero localStorage writes', async () => {
  const evilPwaSettings = JSON.stringify({
    providerId: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-evil-page-storage-999',
    model: 'gpt-4o-mini',
    syncedAt: 1700000123999
  });

  const env = runUserscriptInSandbox({
    pageUrl: 'https://untrusted.example.com/article',
    withGm: true,
    initialGm: null,
    initialLocalStorage: { kct_settings_v1: evilPwaSettings }
  });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(env.gmStore.kct_settings_v1, undefined, 'Untrusted page localStorage must NEVER bridge into GM storage');
  assert.equal(env.getLocalStorageWrites(), 0, 'Zero writes to untrusted page localStorage');
});

test('Userscript settings modal 1-tap #nr_sync paste import saves cleanly to GM storage without leaking to page', async () => {
  const payload = Buffer.from(JSON.stringify({
    p: 'openai',
    r: 'openai',
    k: 'sk-modal-import-001',
    m: 'gpt-4o-mini',
    l: 'zh-TW'
  })).toString('base64url');

  const env = runUserscriptInSandbox({
    pageUrl: 'https://untrusted.example.com/article',
    withGm: true,
    initialGm: null
  });
  await new Promise((r) => setTimeout(r, 40));

  const hostEl = env.body.children.find((c) => Boolean(c.shadowRoot));
  assert.ok(hostEl && hostEl.shadowRoot, 'Userscript Shadow UI host mounted');
  const syncInput = hostEl.shadowRoot.querySelector('#nr-modal-sync-input');
  const importBtn = hostEl.shadowRoot.querySelector('#nr-modal-sync-import');
  assert.ok(syncInput && importBtn, 'Userscript modal exposes #nr-modal-sync-input and #nr-modal-sync-import');

  syncInput.value = `https://chih-kai-wang.github.io/native-read/#nr_sync=${payload}`;
  importBtn.click();
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(env.gmStore.kct_settings_v1, 'Modal import persisted settings to GM storage');
  const saved = JSON.parse(String(env.gmStore.kct_settings_v1));
  assert.equal(saved.apiKey, 'sk-modal-import-001');
  assert.equal(saved.model, 'gpt-4o-mini');
  assert.equal(env.getLocalStorageWrites(), 0, 'Zero writes to untrusted page localStorage on modal import');
});

test('Native WebView bridge hooks auto-start, prefer GM_xmlhttpRequest, switch modes, and never leak apiKey', async () => {
  let fetchCalls = 0;
  const seededSettings = JSON.stringify({
    settingsSchemaVersion: 6,
    providerId: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-native-webview-secret-001',
    model: 'gpt-4o-mini',
    targetLang: 'zh-TW',
    displayMode: 'replace'
  });

  const env = runUserscriptInSandbox({
    pageUrl: 'https://example.org/research-article',
    withGm: true,
    initialGm: { kct_settings_v1: seededSettings },
    globalsBeforeRun: {
      __NATIVEREAD_PREFER_GM_XHR__: true,
      __NATIVEREAD_AUTO_START__: true
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be called when __NATIVEREAD_PREFER_GM_XHR__ is true');
    },
    gmXhrImpl: (opts) => {
      opts.onload?.({
        status: 200,
        statusText: 'OK',
        responseText: JSON.stringify({
          choices: [{ message: { content: '{"i":0,"t":"原生瀏覽器橋接譯文"}\n' } }]
        })
      });
    }
  });

  await new Promise((r) => setTimeout(r, 80));

  assert.equal(fetchCalls, 0, '__NATIVEREAD_PREFER_GM_XHR__ bypasses page fetch cleanly');
  assert.equal(env.getGmXhrCalls(), 1, '__NATIVEREAD_AUTO_START__ triggered GM_xmlhttpRequest translation automatically');
  assert.equal(typeof env.context.__NATIVEREAD_TRANSLATE_NOW__, 'function');
  assert.equal(typeof env.context.__NATIVEREAD_SET_MODE__, 'function');
  assert.equal(typeof env.context.__NATIVEREAD_RELOAD_SETTINGS__, 'function');
  assert.equal(typeof env.context.__NATIVEREAD_GET_STATE__, 'function');

  env.context.__NATIVEREAD_SET_MODE__('bilingual');
  const st = env.context.__NATIVEREAD_GET_STATE__();
  assert.equal(st.mode, 'bilingual');
  assert.equal(st.hasKey, true);
  assert.equal('apiKey' in st, false, '__NATIVEREAD_GET_STATE__ must NEVER expose raw apiKey');
});
