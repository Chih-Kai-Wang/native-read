import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function createDomSandbox({ pageUrl = 'https://example.com/article', storageInit = {} } = {}) {
  const parsedUrl = new URL(pageUrl);
  const store = { ...storageInit };

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
      this.shadowRoot = null;
      this.offsetWidth = 600;
      this.offsetHeight = 70;
      this.clientWidth = 600;
      this.clientHeight = 70;
      this._classSet = new Set();
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
      this.isConnected = true;
      this._text = '';
      this._listeners = new Map();
    }
    attachShadow() {
      this.shadowRoot = new MockElement('#shadow');
      return this.shadowRoot;
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }
    cloneNode(deep = true) {
      const copy = new MockElement(this.tagName);
      copy._text = this._text;
      copy._classSet = new Set(this._classSet);
      for (const [k, v] of this.attributes.entries()) copy.attributes.set(k, v);
      if (deep) {
        for (const c of this.children) {
          copy.appendChild(typeof c.cloneNode === 'function' ? c.cloneNode(true) : { ...c });
        }
      }
      return copy;
    }
    appendChild(child) {
      if (child) {
        child.parentNode = this;
        child.parentElement = this;
        this.children.push(child);
      }
      return child;
    }
    append(...nodes) {
      for (const n of nodes) {
        if (typeof n === 'string') {
          this.appendChild({ nodeType: 3, textContent: n });
        } else {
          this.appendChild(n);
        }
      }
    }
    replaceChildren(...nodes) {
      this.children.length = 0;
      this.append(...nodes);
    }
    insertAdjacentElement(_pos, el) {
      if (this.parentNode) this.parentNode.appendChild(el);
      return el;
    }
    remove() {
      if (this.parentNode) {
        const idx = this.parentNode.children.indexOf(this);
        if (idx !== -1) this.parentNode.children.splice(idx, 1);
      }
    }
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => (typeof c.contains === 'function' ? c.contains(other) : false));
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchesSimple(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    matches(sel) { return matchesSimple(this, sel); }
    querySelector(sel) { return findAll(this, sel)[0] || null; }
    querySelectorAll(sel) { return findAll(this, sel); }
    getBoundingClientRect() { return { top: 50, bottom: 120, left: 0, right: 600, width: 600, height: 70 }; }
    getClientRects() { return [this.getBoundingClientRect()]; }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
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
    set className(v) {
      this._classSet = new Set(String(v || '').split(/\s+/).filter(Boolean));
    }
  }

  function matchesSingleCompound(el, compound) {
    let rest = compound.trim();
    if (!rest) return false;
    while (rest.length > 0) {
      const notMatch = rest.match(/^:not\(([^)]+)\)/);
      if (notMatch) {
        if (matchesSingleCompound(el, notMatch[1])) return false;
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

  function matchesSimple(el, sel) {
    if (!el || el.nodeType !== 1 || typeof sel !== 'string') return false;
    return sel.split(',').some((rawPart) => {
      const parts = rawPart.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return false;
      const last = parts[parts.length - 1];
      if (!matchesSingleCompound(el, last)) return false;
      let ancestor = el.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (ancestor && !matchesSingleCompound(ancestor, parts[i])) {
          ancestor = ancestor.parentElement;
        }
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }

  function findAll(root, sel, out = []) {
    for (const c of root.children || []) {
      if (c.nodeType === 1) {
        if (matchesSimple(c, sel)) out.push(c);
        findAll(c, sel, out);
      }
    }
    return out;
  }

  const head = new MockElement('head');
  const body = new MockElement('body');
  const docEl = new MockElement('html');
  docEl.append(head, body);

  const messageListeners = [];
  const storageListeners = [];
  const connectLog = [];
  let onMessageRuntime = [];
  let portHandler = null;
  let intersectionCbs = [];
  let mutationCbs = [];
  let batchFailNext = false;

  const documentObj = {
    documentElement: docEl,
    head,
    body,
    title: 'Test Page',
    readyState: 'complete',
    defaultView: null,
    createDocumentFragment: () => new MockElement('#fragment'),
    createElement: (tag) => new MockElement(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t ?? '') }),
    querySelector: (s) => findAll(docEl, s)[0] || null,
    querySelectorAll: (s) => findAll(docEl, s),
    getElementById: (id) => findAll(docEl, `[id="${id}"]`)[0] || null,
    createTreeWalker(root, whatToShow = 0xffffffff) {
      const nodes = [];
      const walk = (n) => {
        for (const c of n.children || []) {
          if (((whatToShow & 4) && c.nodeType === 3) || ((whatToShow & 1) && c.nodeType === 1)) {
            nodes.push(c);
          }
          if (c.children) walk(c);
        }
      };
      if (root) walk(root);
      let idx = 0;
      return {
        nextNode() {
          return idx < nodes.length ? nodes[idx++] : null;
        }
      };
    },
    addEventListener() {},
    removeEventListener() {}
  };

  class MockIntersectionObserver {
    constructor(cb) {
      this._cb = cb;
      this.observed = new Set();
      intersectionCbs.push(cb);
    }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
  }

  class MockMutationObserver {
    constructor(cb) { mutationCbs.push(cb); }
    observe() {}
    disconnect() {}
  }

  const timers = new Set();
  const trackTimeout = (fn, ms, ...a) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn(...a);
    }, ms);
    timers.add(id);
    return id;
  };
  const untrackTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };

  const context = {
    globalThis: null,
    console,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    WeakMap,
    Map,
    Set,
    setTimeout: trackTimeout,
    clearTimeout: untrackTimeout,
    requestAnimationFrame: (fn) => trackTimeout(fn, 0),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    window: null,
    navigator: {
      maxTouchPoints: 0,
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0',
      clipboard: { async writeText() {} }
    },
    document: documentObj,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    scrollY: 0,
    scrollX: 0,
    IntersectionObserver: MockIntersectionObserver,
    MutationObserver: MockMutationObserver,
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
      replaceState(_s, _t, next) {
        if (typeof next === 'string') parsedUrl.hash = '';
      }
    },
    location: parsedUrl,
    innerHeight: 800,
    innerWidth: 1280,
    chrome: {
      runtime: {
        id: 'native-read-test-ext',
        lastError: null,
        onMessage: { addListener(fn) { onMessageRuntime.push(fn); } },
        connect({ name }) {
          const listeners = [];
          const port = {
            name,
            onMessage: { addListener(fn) { listeners.push(fn); } },
            onDisconnect: { addListener() {} },
            postMessage(msg) {
              connectLog.push(msg);
              if (portHandler) {
                portHandler(msg, (ev) => listeners.forEach((fn) => fn(ev)));
              }
            },
            disconnect() {}
          };
          return port;
        },
        async sendMessage(msg) {
          messageListeners.push(msg);
          if (msg?.type === 'TRANSLATE_BATCH') {
            if (batchFailNext) {
              return { ok: false, errorCode: 'HTTP_401', error: 'HTTP 401: Invalid API key' };
            }
            const translations = {};
            for (const it of msg.items || []) {
              translations[it.key] = { zh: `譯文:${it.text}`, cached: false };
            }
            return { ok: true, translations };
          }
          if (msg?.type === 'IMPORT_MOBILE_SYNC') {
            store.kct_settings_v1 = { ...(store.kct_settings_v1 || {}), ...msg.payload };
            return { ok: true };
          }
          return { ok: true };
        }
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
            return { ...store };
          },
          async set(obj) { Object.assign(store, obj); }
        },
        onChanged: { addListener(fn) { storageListeners.push(fn); } }
      }
    },
    MockElement
  };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  context.top = context;
    context.addEventListener = () => {};
    context.removeEventListener = () => {};
    context.requestIdleCallback = (fn) => trackTimeout(fn, 0);
    documentObj.defaultView = context;

  for (const rel of ['shared/config.js', 'content/site-analyzer.js', 'content/code-overlay.js', 'content/renderer.js']) {
    const code = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    vm.runInNewContext(code, context, { filename: rel });
  }

  return {
    context,
    body,
    store,
    MockElement,
    connectLog,
    setPortHandler(fn) { portHandler = fn; },
    setBatchFailNext(v) { batchFailNext = v; },
    loadContentScript() {
      const code = fs.readFileSync(path.join(REPO_ROOT, 'content/content.js'), 'utf8');
      vm.runInNewContext(code, context, { filename: 'content/content.js' });
    },
    triggerContentMessage(msg) {
      return new Promise((resolve) => {
        for (const fn of onMessageRuntime) {
          const keep = fn(msg, {}, resolve);
          if (keep !== true) resolve(undefined);
        }
      });
    },
    triggerMutations(addedNodes) {
      for (const cb of mutationCbs) {
        cb([{ target: body, addedNodes }]);
      }
    },
    dispose() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    }
  };
}

test('normalizeBracketTokens converts CJK fullwidth and lowercase brackets into valid placeholders', () => {
  const { context, MockElement } = createDomSandbox();
  const block = new MockElement('p');
  block.textContent = 'Check fn() and docs now.';
  const codeNode = new MockElement('code');
  codeNode.textContent = 'fn()';
  const linkNode = new MockElement('a');
  linkNode.setAttribute('href', 'https://example.com');
  linkNode.textContent = 'docs';
  const ph = new Map([
    ['[[C0]]', codeNode],
    ['[[A0]]', linkNode]
  ]);

  context.KCTRenderer.applyBlockTranslation(
    {
      el: block,
      key: 'k_tok',
      text: 'Check fn() and docs now.',
      zh: '查看 ［［c0］］ 與 【【a0】】文件【【/a0】】。',
      placeholders: ph,
      typo: { fontFamily: 'Georgia', fontSize: 16, lineHeight: 24, lineHeightRatio: 1.5, isSerif: true }
    },
    { targetLang: 'zh-TW', displayMode: 'replace', typographyMatch: 'native' },
    { elementState: new WeakMap() }
  );

  const transWrapper = block.querySelector('[data-kct-ui="trans"]');
  assert.ok(transWrapper, 'Rendered translation container despite fullwidth/lowercase LLM tokens');
  assert.match(transWrapper.textContent, /fn\(\)/);
  assert.ok(transWrapper.querySelector('a'), 'Preserved nested link element from 【【a0】】');
});

test('site-analyzer excludes any [contenteditable] except [contenteditable="false"]', () => {
  const { context, body, MockElement } = createDomSandbox();
  const main = new MockElement('main');
  const editablePlain = new MockElement('div');
  editablePlain.setAttribute('contenteditable', 'plaintext-only');
  const pInsidePlain = new MockElement('p');
  pInsidePlain.textContent = 'This editable draft sentence should never be overwritten by translator.';
  editablePlain.appendChild(pInsidePlain);

  const editableFalse = new MockElement('div');
  editableFalse.setAttribute('contenteditable', 'false');
  const pInsideFalse = new MockElement('p');
  pInsideFalse.textContent = 'This read-only article paragraph inside contenteditable=false must be translated.';
  editableFalse.appendChild(pInsideFalse);

  main.append(editablePlain, editableFalse);
  body.appendChild(main);

  const roots = context.KCTSiteAnalyzer.findContentRoots('course');
  const collected = context.KCTSiteAnalyzer.collectUniversalCandidateElements(roots, 'course', new WeakMap());
  assert.equal(collected.includes(pInsidePlain), false);
  assert.equal(collected.includes(pInsideFalse), true);
});

test('content.js circuit breaker halts retries on HTTP 401 and resets on explicit TRANSLATE_NOW', async () => {
  const syncEnv = createDomSandbox({
    pageUrl: 'https://example.com/article',
    storageInit: {
      kct_settings_v1: {
        enabled: true,
        providerId: 'openai',
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-valid',
        model: 'gpt-4o-mini',
        streamTranslation: true
      }
    }
  });
  const main = new syncEnv.MockElement('main');
  const p1 = new syncEnv.MockElement('p');
  p1.textContent = 'First paragraph that triggers a fatal HTTP 401 authentication error immediately.';
  const p2 = new syncEnv.MockElement('p');
  p2.textContent = 'Second paragraph waiting behind it should be released when halted.';
  main.append(p1, p2);
  syncEnv.body.appendChild(main);

  let streamCalls = 0;
  let force401 = true;
  syncEnv.setPortHandler((msg, emit) => {
    if (msg.type === 'TRANSLATE_STREAM') {
      streamCalls += 1;
      if (force401) {
        emit({ type: 'ERROR', requestId: msg.requestId, errorCode: 'HTTP_401', error: 'HTTP 401: Invalid API key' });
      } else {
        for (const it of msg.items || []) {
          emit({ type: 'ITEM', requestId: msg.requestId, key: it.key, zh: `譯文:${it.text}`, cached: false });
        }
        emit({ type: 'DONE', requestId: msg.requestId, translatedCount: (msg.items || []).length });
      }
    }
  });

  try {
    syncEnv.loadContentScript();
    await new Promise((r) => setTimeout(r, 40));

    const startRes = await syncEnv.triggerContentMessage({ type: 'KCT_COMMAND', action: 'TRANSLATE_NOW' });
    assert.equal(startRes?.ok, true, `TRANSLATE_NOW succeeded: ${JSON.stringify(startRes)}`);
    await new Promise((r) => setTimeout(r, 120));
    const callsAfter401 = streamCalls;
    assert.equal(callsAfter401, 1, 'Triggered stream once before halting on 401');

    // MutationObserver adding a new paragraph must NOT trigger another API call while haltedByError=true
    const p3 = new syncEnv.MockElement('p');
    p3.textContent = 'Dynamically appended paragraph while halted should not fire API call.';
    main.appendChild(p3);
    syncEnv.triggerMutations([p3]);
    await new Promise((r) => setTimeout(r, 380));
    assert.equal(streamCalls, callsAfter401, 'Circuit breaker prevented passive MutationObserver retry storm');

    // Explicit TRANSLATE_NOW resets circuit breaker
    force401 = false;
    await syncEnv.triggerContentMessage({ type: 'KCT_COMMAND', action: 'TRANSLATE_NOW' });
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(streamCalls > callsAfter401, 'Explicit TRANSLATE_NOW reset circuit breaker');
  } finally {
    syncEnv.dispose();
  }
});

test('tryImportMobileSyncHash imports #nr_sync only on trusted GitHub Pages PWA origin', async () => {
  const payload = Buffer.from(JSON.stringify({
    p: 'openai',
    r: 'openai',
    k: 'sk-trusted-sync-999',
    m: 'gpt-4o-mini',
    l: 'zh-TW'
  })).toString('base64url');

  const untrusted = createDomSandbox({ pageUrl: `https://evil.example.com/#nr_sync=${payload}` });
  untrusted.loadContentScript();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(untrusted.store.kct_settings_v1, undefined, 'Untrusted origin never imports #nr_sync');

  try {
    const trusted = createDomSandbox({ pageUrl: `https://chih-kai-wang.github.io/native-read/#nr_sync=${payload}` });
    try {
      trusted.loadContentScript();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(trusted.store.kct_settings_v1?.apiKey, 'sk-trusted-sync-999', 'Trusted PWA origin imported #nr_sync');
    } finally {
      trusted.dispose();
    }
  } finally {
    untrusted.dispose();
  }
});
