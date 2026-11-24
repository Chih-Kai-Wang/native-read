import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import {
  assert,
  assertEqual,
  assertDeepEqual,
  assertIncludes,
  assertNotIncludes,
  assertMatch,
  assertNotMatch,
  assertLessThanOrEqual,
  assertGreaterThanOrEqual
} from '../lib/assertions.js';
import { runEgoScript } from '../lib/browser.js';
import { restoreSettingsSnapshot } from '../lib/settings-guard.js';
import { startFixtureServer, startMockLlmServer } from '../lib/http-server.js';

function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, out);
    } else if (predicate(full, entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function loadConfigInVm(repoRoot, initialStorage = {}) {
  const code = fs.readFileSync(path.join(repoRoot, 'shared/config.js'), 'utf8');
  const store = { ...initialStorage };
  const context = {
    globalThis: null,
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: { id: 'ckeknfhpandgmippabbfkndmndainpff' },
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: store[keys] };
            if (Array.isArray(keys)) {
              const out = {};
              for (const k of keys) out[k] = store[k];
              return out;
            }
            return { ...store };
          },
          async set(patch) {
            Object.assign(store, patch);
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(code, context, { filename: 'shared/config.js' });
  return { KCTConfig: context.KCTConfig, store };
}

function encodeNrSync(payload) {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function listRootReadmes(repoRoot) {
  return fs
    .readdirSync(repoRoot)
    .filter((name) => /^README(?:\.[A-Za-z-]+)?\.md$/.test(name))
    .sort();
}

function stripFencedCodeBlocks(md) {
  return md.replace(/^```[\s\S]*?^```/gm, '');
}

function githubSlugify(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function extractHeadingAnchors(md) {
  const cleaned = stripFencedCodeBlocks(md);
  const anchors = new Set();
  const counts = new Map();
  for (const line of cleaned.split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) {
      const base = githubSlugify(m[1]);
      if (base) {
        const idx = counts.get(base) || 0;
        anchors.add(idx === 0 ? base : `${base}-${idx}`);
        counts.set(base, idx + 1);
      }
    }
    const idMatches = line.matchAll(/<(?:a|h[1-6]|div|span)\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi);
    for (const im of idMatches) {
      anchors.add(im[1]);
    }
  }
  return anchors;
}

function extractMarkdownAndHtmlLinks(md) {
  const cleaned = stripFencedCodeBlocks(md);
  const links = [];
  const mdRe = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const m of cleaned.matchAll(mdRe)) {
    links.push(m[1]);
  }
  const htmlRe = /\b(?:href|src)=["']([^"']+)["']/gi;
  for (const m of cleaned.matchAll(htmlRe)) {
    links.push(m[1]);
  }
  return links;
}

export function registerTests(ctx) {
  // Every browser test gets its own Node-level `finally` that restores the
  // user's real kct_settings_v1 from the harness snapshot, whatever happened
  // inside the ego-browser driver (throw, timeout, killed child, in-page
  // restore never reached). The in-driver finally blocks below remain the
  // first line of defence; this is the one that cannot be skipped.
  const addTest = (def) => {
    if (!def.usesBrowser) return ctx.addTest(def);
    const innerRun = def.run;
    return ctx.addTest({
      ...def,
      async run(runCtx) {
        try {
          return await innerRun.call(def, runCtx);
        } finally {
          await restoreSettingsSnapshot({ reason: `test-finally:${def.id}` });
        }
      }
    });
  };

  // =========================================================================
  // F1: On-Demand Silence, #nr_sync & Security Invariants
  // =========================================================================

  addTest({
    id: 'F1-T1-01',
    tier: 1,
    feature: 'F1',
    name: 'Manifest MV3 invariants: zero static content_scripts & zero web_accessible_resources',
    usesBrowser: false,
    async run({ repoRoot }) {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
      assertEqual(manifest.manifest_version, 3, 'manifest_version');
      assert(!('content_scripts' in manifest), 'manifest.json must NOT define static content_scripts');
      assert(!('web_accessible_resources' in manifest), 'manifest.json must NOT define web_accessible_resources');
      assertEqual(manifest.background?.service_worker, 'background/service-worker.js', 'background.service_worker');
      assertEqual(manifest.action?.default_popup, 'popup/popup.html', 'action.default_popup');
      for (const perm of ['storage', 'tabs', 'scripting', 'contextMenus', 'activeTab']) {
        assertIncludes(manifest.permissions || [], perm, `permissions includes ${perm}`);
      }
      const hostPerms = manifest.host_permissions || [];
      assert(!hostPerms.some((p) => p.startsWith('file:')), 'host_permissions must not claim file://');
    }
  });

  addTest({
    id: 'F1-T1-02',
    tier: 1,
    feature: 'F1',
    name: 'KCTConfig.DEFAULT_SETTINGS silent defaults and v1->v6 schema migration force autoTranslate=false',
    usesBrowser: false,
    async run({ repoRoot }) {
      const { KCTConfig } = loadConfigInVm(repoRoot, {
        kct_settings_v1: {
          settingsSchemaVersion: 1,
          autoTranslate: true,
          displayMode: 'bilingual',
          targetLang: 'zh-TW',
          batchSize: 8
        }
      });
      assertEqual(KCTConfig.DEFAULT_SETTINGS.settingsSchemaVersion, 6, 'settingsSchemaVersion');
      assertEqual(KCTConfig.DEFAULT_SETTINGS.autoTranslate, false, 'DEFAULT_SETTINGS.autoTranslate');
      assertEqual(KCTConfig.DEFAULT_SETTINGS.enabled, true, 'DEFAULT_SETTINGS.enabled');
      assertEqual(KCTConfig.DEFAULT_SETTINGS.thinkingEffort, 'fastest', 'DEFAULT_SETTINGS.thinkingEffort');

      const migrated = await KCTConfig.getSettings();
      assertEqual(migrated.settingsSchemaVersion, 6, 'migrated schema version');
      assertEqual(migrated.autoTranslate, false, 'migrated autoTranslate forced false');
      assertEqual(migrated.displayMode, 'replace', 'v1 bilingual migrated to replace');
      assertEqual(migrated.batchSize, 20, 'v1 legacy batchSize migrated to 20');
    }
  });

  addTest({
    id: 'F1-T1-03',
    tier: 1,
    feature: 'F1',
    name: 'Zero unsafe DOM injection sinks across all non-vendor JS and HTML source files',
    usesBrowser: false,
    async run({ repoRoot }) {
      const dirs = ['shared', 'background', 'content', 'viewer', 'popup', 'options', 'docs', 'scripts'];
      const sinkRe = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval)\s*\(|new\s+Function\b|\.(innerHTML|outerHTML)\s*=/;
      const violations = [];
      for (const d of dirs) {
        const files = walkFiles(path.join(repoRoot, d), (full, name) => {
          if (full.includes(`${path.sep}vendor${path.sep}`)) return false;
          return name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.html');
        });
        for (const f of files) {
          const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
          lines.forEach((line, idx) => {
            if (sinkRe.test(line)) {
              violations.push(`${path.relative(repoRoot, f)}:${idx + 1}: ${line.trim().slice(0, 80)}`);
            }
          });
        }
      }
      assertDeepEqual(violations, [], 'Unsafe DOM sinks found');
    }
  });

  addTest({
    id: 'F1-T1-04',
    tier: 1,
    feature: 'F1',
    name: 'Zero raw API key console logging & KCTConfig.sanitizeApiKey strips Bearer/whitespace',
    usesBrowser: false,
    async run({ repoRoot }) {
      const { KCTConfig } = loadConfigInVm(repoRoot);
      assertEqual(KCTConfig.sanitizeApiKey('  Bearer sk-test-998877  '), 'sk-test-998877', 'sanitizeApiKey Bearer');
      assertEqual(KCTConfig.sanitizeApiKey('  bearer   AIzaSyTest12345  '), 'AIzaSyTest12345', 'sanitizeApiKey case-insensitive');
      assertEqual(KCTConfig.sanitizeApiKey(''), '', 'sanitizeApiKey empty');

      const dirs = ['shared', 'background', 'content', 'viewer', 'popup', 'options', 'docs', 'scripts'];
      const badLogs = [];
      for (const d of dirs) {
        const files = walkFiles(path.join(repoRoot, d), (full, name) => {
          if (full.includes(`${path.sep}vendor${path.sep}`)) return false;
          return name.endsWith('.js') || name.endsWith('.mjs');
        });
        for (const f of files) {
          const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
          lines.forEach((line, idx) => {
            if (/console\.(log|warn|error|info|debug)\s*\(/.test(line) && /\b(apiKey|rawKey|x-goog-api-key|Authorization)\b/.test(line)) {
              badLogs.push(`${path.relative(repoRoot, f)}:${idx + 1}`);
            }
          });
        }
      }
      assertDeepEqual(badLogs, [], 'Console logging must never print apiKey or auth headers');
    }
  });

  addTest({
    id: 'F1-T1-05',
    tier: 1,
    feature: 'F1',
    name: 'KCTConfig URL & PDF classification baseline (remote PDF, arXiv, Drive, chrome://, HTML)',
    usesBrowser: false,
    async run({ repoRoot }) {
      const { KCTConfig } = loadConfigInVm(repoRoot);
      assertEqual(KCTConfig.isPdfUrl('https://example.com/paper.pdf'), true, 'standard .pdf URL');
      assertEqual(KCTConfig.isPdfUrl('https://arxiv.org/pdf/1706.03762'), true, 'extensionless arxiv PDF');
      assertEqual(KCTConfig.isInjectableUrl('https://example.com/article.html'), true, 'standard https HTML');
      assertEqual(KCTConfig.isInjectableUrl('chrome://settings'), false, 'chrome:// not injectable');
      assertEqual(
        KCTConfig.extractGoogleDriveFileId('https://drive.google.com/file/d/1IR7CddF_2FyQo_PdfBNTaEA50EGiVt2r/view'),
        '1IR7CddF_2FyQo_PdfBNTaEA50EGiVt2r',
        'Drive file ID extraction'
      );
      assertEqual(
        KCTConfig.resolvePdfSourceUrl('https://drive.google.com/file/d/1IR7CddF_2FyQo_PdfBNTaEA50EGiVt2r/view'),
        'https://drive.google.com/uc?export=download&id=1IR7CddF_2FyQo_PdfBNTaEA50EGiVt2r',
        'Drive resolved download URL'
      );
    }
  });

  addTest({
    id: 'F1-T2-01',
    tier: 2,
    feature: 'F1',
    name: 'URL boundary & category partition (file:// PDF vs HTML, GitHub /blob, Wikipedia File:, webstore)',
    usesBrowser: false,
    async run({ repoRoot }) {
      const { KCTConfig } = loadConfigInVm(repoRoot);
      assertEqual(KCTConfig.isFileUrl('file:///tmp/report.pdf'), true, 'isFileUrl');
      assertEqual(KCTConfig.isFilePdfUrl('file:///tmp/report.PDF'), true, 'isFilePdfUrl uppercase');
      assertEqual(KCTConfig.isFilePdfUrl('file:///tmp/report.html'), false, 'isFilePdfUrl rejects .html');
      assertEqual(KCTConfig.isPdfUrl('file:///tmp/report.pdf', { includeFile: true }), true, 'isPdfUrl includeFile:true');
      assertEqual(KCTConfig.isPdfUrl('file:///tmp/report.pdf', { includeFile: false }), false, 'isPdfUrl includeFile:false');
      assertEqual(KCTConfig.isRemotePdfUrl('https://github.com/org/repo/blob/main/paper.pdf'), false, 'GitHub /blob/ excluded');
      assertEqual(KCTConfig.isRemotePdfUrl('https://en.wikipedia.org/wiki/File:Architecture.pdf'), false, 'Wikipedia File: excluded');
      assertEqual(KCTConfig.isRemotePdfUrl('https://example.org/doc?format=pdf'), true, '?format=pdf matched');
      assertEqual(KCTConfig.isInjectableUrl('https://chromewebstore.google.com/detail/foo'), false, 'Chrome Web Store blocked');
      assertEqual(KCTConfig.isInjectableUrl('https://microsoftedge.microsoft.com/addons/detail/foo'), false, 'Edge Addons blocked');
      assertEqual(KCTConfig.isInjectableUrl('not-a-url'), false, 'malformed URL');
      assertEqual(KCTConfig.isPdfUrl(''), false, 'empty URL');
    }
  });

  addTest({
    id: 'F1-T2-02',
    tier: 2,
    feature: 'F1',
    name: 'file:// PDF viewer graceful error handling & chrome:// UNSUPPORTED_URL response',
    usesBrowser: true,
    async run() {
      const res = await runEgoScript(async ({ task, page, helpers }) => {
        await helpers.setDesktopViewport(page, 1280, 800);
        await helpers.enableEventCapture(page);

        await page.goto(`${helpers.EXT_ORIGIN}/viewer/pdf-viewer.html?fileAccess=denied&name=local-paper.pdf`, {
          waitUntil: 'domcontentloaded'
        });
        await page.waitForTimeout(300);
        const deniedState = await page.evaluate(() => ({
          bodyText: document.body?.innerText?.slice(0, 400) || '',
          hasFilePicker: Boolean(document.querySelector('input[type="file"]'))
        }));

        await page.goto(`${helpers.EXT_ORIGIN}/viewer/pdf-viewer.html?src=${encodeURIComponent('file:///nonexistent/local-paper.pdf')}`, {
          waitUntil: 'domcontentloaded'
        });
        await page.waitForTimeout(400);
        const fileErrState = await page.evaluate(() => ({
          bodyText: document.body?.innerText?.slice(0, 400) || ''
        }));

        const pBlocked = await task.newPage();
        await pBlocked.goto('about:blank');
        const cmdRes = await helpers.triggerExtensionOnTab(task, 'about:blank', 'TRANSLATE_NOW');
        await pBlocked.close();

        const events = await helpers.collectEvents(page);
        return { deniedState, fileErrState, cmdRes, pageErrors: events.pageErrors };
      });

      assertEqual(res.pageErrors.length, 0, 'Zero uncaught pageErrors in PDF viewer');
      assertEqual(res.deniedState.hasFilePicker, true, 'Local file picker remains usable on fileAccess=denied');
      assert(res.deniedState.bodyText.length > 0, 'Viewer displays guidance text on fileAccess=denied');
      assert(res.fileErrState.bodyText.length > 0, 'Viewer handles failed file:// fetch without crashing');
      assertEqual(res.cmdRes.response?.ok, false, 'ENSURE_AND_COMMAND rejects about:blank');
      assertEqual(res.cmdRes.response?.errorCode, 'UNSUPPORTED_URL', 'errorCode is UNSUPPORTED_URL');
    }
  });

  addTest({
    id: 'F1-T2-03',
    tier: 2,
    feature: 'F1',
    name: 'Untrusted origin #nr_sync rejection & zero auto-injection',
    usesBrowser: true,
    async run({ fixtureServer }) {
      const evilPayload = encodeNrSync({
        p: 'openai',
        u: 'http://127.0.0.1:9999/evil',
        k: 'sk-evil-untrusted-000',
        m: 'evil-model'
      });
      const targetUrl = `${fixtureServer.fixturesUrl}html/light-article-table.html#nr_sync=${evilPayload}`;

      const res = await runEgoScript(
        async ({ task, page, args, helpers }) => {
          const pExt = await task.newPage();
          await pExt.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
          await pExt.evaluate(async () => {
            const d = await chrome.storage.local.get('kct_settings_v1');
            window.__nrOrig = d.kct_settings_v1 || null;
          });
          const before = await helpers.getStorageSafe(pExt);

          try {
            await helpers.setDesktopViewport(page, 1280, 800);
            await helpers.enableEventCapture(page);
            await page.goto(args.targetUrl, { waitUntil: 'load' });
            await page.waitForTimeout(600);

            const domState = await page.evaluate(() => ({
              hasWidget: Boolean(document.querySelector('#kct-widget-host')),
              transCount: document.querySelectorAll('[data-kct-has-trans]').length,
              activeHtml: document.documentElement.classList.contains('kct-active')
            }));
            const after = await helpers.getStorageSafe(pExt);
            const events = await helpers.collectEvents(page);
            return { before, after, domState, pageErrors: events.pageErrors };
          } finally {
            // Leave the #nr_sync URL first so no late tabs.onUpdated import can
            // land after the restore below.
            await page.goto('about:blank').catch(() => {});
            await pExt.evaluate(async () => {
              if (window.__nrOrig) {
                await chrome.storage.local.set({ kct_settings_v1: window.__nrOrig });
              } else {
                await chrome.storage.local.remove('kct_settings_v1');
              }
            });
            await pExt.close();
          }
        },
        { args: { targetUrl } }
      );

      assertEqual(res.pageErrors.length, 0, 'Zero pageErrors');
      assertEqual(res.domState.hasWidget, false, 'Untrusted #nr_sync must NOT inject #kct-widget-host');
      assertEqual(res.domState.transCount, 0, 'Untrusted #nr_sync must NOT translate DOM');
      assertEqual(res.domState.activeHtml, false, 'Untrusted #nr_sync must NOT activate html.kct-active');
      assertEqual(res.after?.baseUrl, res.before?.baseUrl, 'baseUrl must remain unchanged');
      assertEqual(res.after?.model, res.before?.model, 'model must remain unchanged');
      assertEqual(res.after?.apiKeyLength, res.before?.apiKeyLength, 'apiKeyLength must remain unchanged');
    }
  });

  addTest({
    id: 'F1-T2-04',
    tier: 2,
    feature: 'F1',
    name: 'Partial #nr_sync payload (baseUrl u without apiKey k) must NOT pair existing key with new baseUrl',
    usesBrowser: true,
    async run() {
      const partialPayload = encodeNrSync({
        u: 'http://127.0.0.1:9999/exfiltrate',
        m: 'hijacked-model'
      });

      const res = await runEgoScript(
        async ({ task, page, args, helpers }) => {
          const pExt = await task.newPage();
          await pExt.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
          await pExt.evaluate(async () => {
            const d = await chrome.storage.local.get('kct_settings_v1');
            window.__nrOrig = d.kct_settings_v1 || null;
          });

          try {
            await pExt.evaluate(async () => {
              await chrome.storage.local.set({
                kct_settings_v1: {
                  ...(window.__nrOrig || {}),
                  settingsSchemaVersion: 5,
                  providerId: 'openai',
                  protocol: 'openai',
                  baseUrl: 'http://127.0.0.1:1/safe',
                  apiKey: 'sk-local-test-secret-999',
                  model: 'gpt-4o-mini'
                }
              });
            });
            await page.goto(`${helpers.EXT_ORIGIN}/popup/popup.html#nr_sync=${args.partialPayload}`, {
              waitUntil: 'domcontentloaded'
            });
            await page.waitForTimeout(600);
            const after = await helpers.getStorageSafe(pExt);
            return { after };
          } finally {
            // Leave the trusted-origin #nr_sync URL before restoring.
            await page.goto('about:blank').catch(() => {});
            await page.waitForTimeout(300).catch(() => {});
            await pExt.evaluate(async () => {
              if (window.__nrOrig) {
                await chrome.storage.local.set({ kct_settings_v1: window.__nrOrig });
              } else {
                await chrome.storage.local.remove('kct_settings_v1');
              }
            });
            await pExt.close();
          }
        },
        { args: { partialPayload } }
      );

      assert(
        !(res.after?.baseUrl === 'http://127.0.0.1:9999/exfiltrate' && res.after?.hasApiKey === true),
        'Partial #nr_sync without k must never overwrite baseUrl while retaining an existing apiKey'
      );
    }
  });

  addTest({
    id: 'F1-T2-05',
    tier: 2,
    feature: 'F1',
    name: 'Embedded PDF iframe subframe excluded while outer HTML page translates cleanly',
    usesBrowser: true,
    async run() {
      const mockLlm = await startMockLlmServer((req, res) => {
        if (req.url.includes('/chat/completions')) {
          const userMsg = req.body?.messages?.find((m) => m.role === 'user')?.content || '';
          let count = 1;
          try {
            const parsed = JSON.parse(userMsg);
            if (Array.isArray(parsed) && parsed.length > 0) count = parsed.length;
          } catch (_) {}
          if (req.body?.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            for (let i = 0; i < count; i++) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ i, t: `外層譯文 ${i}` }) + '\n' } }] })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            const translations = Array.from({ length: count }, (_, i) => ({ id: i, zh: `外層譯文 ${i}` }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }));
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const hostServer = await startFixtureServer({
        onRequest(req, res, rawPath) {
          if (rawPath === '/embed-pdf.html') {
            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Host With PDF Iframe</title></head><body><main><article><h1>Outer Technical Document</h1><p>This outer paragraph must be translated cleanly by NativeRead.</p></article><iframe id="pdf-subframe" src="/fixtures/pdfs/single-col-whitepaper.pdf" width="600" height="400"></iframe></main></body></html>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
            res.end(html);
            return true;
          }
          return false;
        }
      });

      try {
        const res = await runEgoScript(
          async ({ task, page, args, helpers }) => {
            const pExt = await task.newPage();
            await pExt.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            await pExt.evaluate(async () => {
              const d = await chrome.storage.local.get('kct_settings_v1');
              window.__nrOrig = d.kct_settings_v1 || null;
            });

            try {
              await pExt.evaluate(async (v1Url) => {
                await chrome.storage.local.set({
                  kct_settings_v1: {
                    ...(window.__nrOrig || {}),
                    settingsSchemaVersion: 5,
                    enabled: true,
                    autoTranslate: false,
                    providerId: 'custom',
                    protocol: 'openai',
                    baseUrl: v1Url,
                    apiKey: '',
                    model: 'mock-model',
                    targetLang: 'zh-TW',
                    streamTranslation: true
                  }
                });
              }, args.v1Url);
              await helpers.setDesktopViewport(page, 1280, 800);
              await helpers.enableEventCapture(page);
              await page.goto(args.embedUrl, { waitUntil: 'load' });
              await page.waitForTimeout(300);

              const cmd = await helpers.triggerExtensionOnTab(task, args.embedUrl, 'TRANSLATE_NOW');
              await page.waitForFunction(
                () => document.querySelectorAll('[data-kct-has-trans="1"]').length >= 1,
                undefined,
                { timeout: 10000 }
              );

              const outer = await page.evaluate(() => {
                const iframe = document.getElementById('pdf-subframe');
                let iframeTrans = 0;
                try {
                  iframeTrans = iframe?.contentDocument?.querySelectorAll('[data-kct-has-trans]')?.length || 0;
                } catch (_) {}
                return {
                  active: document.documentElement.classList.contains('kct-active'),
                  transCount: document.querySelectorAll('[data-kct-has-trans="1"]').length,
                  hasWidget: Boolean(document.querySelector('#kct-widget-host')),
                  iframeTrans
                };
              });
              const events = await helpers.collectEvents(page);
              return { cmd, outer, pageErrors: events.pageErrors };
            } finally {
              await pExt.evaluate(async () => {
                if (window.__nrOrig) {
                  await chrome.storage.local.set({ kct_settings_v1: window.__nrOrig });
                } else {
                  await chrome.storage.local.remove('kct_settings_v1');
                }
              });
              await pExt.close();
            }
          },
          { args: { v1Url: mockLlm.v1Url, embedUrl: `${hostServer.baseUrl}/embed-pdf.html` } }
        );

        assertEqual(res.cmd.response?.ok, true, 'ENSURE_AND_COMMAND ok');
        assertEqual(res.cmd.response?.openedPdfViewer, undefined, 'Outer HTML with PDF iframe stays in HTML mode');
        assertEqual(res.outer.active, true, 'Outer HTML activates');
        assertGreaterThanOrEqual(res.outer.transCount, 1, 'Outer HTML translated');
        assertEqual(res.outer.iframeTrans, 0, 'Embedded PDF iframe has zero injected translations');
        assertEqual(res.pageErrors.length, 0, 'Zero pageErrors');
      } finally {
        await hostServer.close();
        await mockLlm.close();
      }
    }
  });

  addTest({
    id: 'F1-T3-01',
    tier: 3,
    feature: 'F1',
    name: 'Pairwise: On-demand silence x SPA route transitions x untrusted #nr_sync',
    usesBrowser: true,
    async run({ fixtureServer }) {
      const payload = encodeNrSync({ p: 'openai', u: 'http://127.0.0.1:9999/bad', k: 'sk-bad-123456' });
      const url = `${fixtureServer.fixturesUrl}html/spa-course.html#nr_sync=${payload}`;

      const res = await runEgoScript(
        async ({ task, page, args, helpers }) => {
          const pExt = await task.newPage();
          await pExt.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
          // Capture the original BEFORE the #nr_sync navigation; it stays in
          // the page (never returned, never logged).
          await pExt.evaluate(async () => {
            const d = await chrome.storage.local.get('kct_settings_v1');
            window.__nrOrig = d.kct_settings_v1 || null;
          });
          const before = await helpers.getStorageSafe(pExt);

          try {
            await helpers.setDesktopViewport(page, 1280, 800);
            await helpers.enableEventCapture(page);
            await page.goto(args.url, { waitUntil: 'load' });
            await page.click('#btn-next-lesson');
            await page.click('#btn-notes-hash');
            await page.waitForTimeout(400);

            const domState = await page.evaluate(() => ({
              href: location.href,
              hasWidget: Boolean(document.querySelector('#kct-widget-host')),
              transCount: document.querySelectorAll('[data-kct-has-trans]').length
            }));
            const after = await helpers.getStorageSafe(pExt);
            const events = await helpers.collectEvents(page);
            return { before, after, domState, pageErrors: events.pageErrors };
          } finally {
            // Leave the #nr_sync URL first, let any late import settle, then
            // restore whatever the sync path may have written.
            await page.goto('about:blank').catch(() => {});
            await page.waitForTimeout(300).catch(() => {});
            await pExt.evaluate(async () => {
              if (window.__nrOrig) {
                await chrome.storage.local.set({ kct_settings_v1: window.__nrOrig });
              } else {
                await chrome.storage.local.remove('kct_settings_v1');
              }
            });
            await pExt.close();
          }
        },
        { args: { url } }
      );

      assertEqual(res.pageErrors.length, 0, 'Zero pageErrors');
      assertEqual(res.domState.hasWidget, false, 'Zero widget injection across SPA routes');
      assertEqual(res.domState.transCount, 0, 'Zero translation nodes across SPA routes');
      assertEqual(res.after?.baseUrl, res.before?.baseUrl, 'Settings baseUrl unchanged');
    }
  });

  addTest({
    id: 'F1-T3-02',
    tier: 3,
    feature: 'F1',
    name: 'Pairwise: CLEAR_PAGE on untouched tab never injects scripts & untrusted page cannot trigger ENSURE_AND_COMMAND',
    usesBrowser: true,
    async run({ fixtureServer }) {
      const targetUrl = `${fixtureServer.fixturesUrl}html/light-article-table.html`;
      const res = await runEgoScript(
        async ({ task, page, args, helpers }) => {
          await helpers.setDesktopViewport(page, 1280, 800);
          await page.goto(args.targetUrl, { waitUntil: 'load' });

          const pageCmdAttempt = await page.evaluate(async (extId) => {
            if (!globalThis.chrome?.runtime?.sendMessage) return { blocked: true, reason: 'no_chrome_runtime' };
            try {
              const resp = await chrome.runtime.sendMessage(extId, { type: 'ENSURE_AND_COMMAND', action: 'TRANSLATE_NOW' });
              return { blocked: !resp?.ok, resp };
            } catch (err) {
              return { blocked: true, reason: err?.message || 'threw' };
            }
          }, helpers.EXTENSION_ID);

          const clearRes = await helpers.triggerExtensionOnTab(task, args.targetUrl, 'CLEAR_PAGE');
          await page.waitForTimeout(200);
          const domState = await page.evaluate(() => ({
            hasWidget: Boolean(document.querySelector('#kct-widget-host')),
            active: document.documentElement.classList.contains('kct-active')
          }));
          return { pageCmdAttempt, clearRes, domState };
        },
        { args: { targetUrl } }
      );

      assertEqual(res.pageCmdAttempt.blocked, true, 'Untrusted webpage cannot invoke ENSURE_AND_COMMAND');
      assertEqual(res.clearRes.response?.ok, true, 'CLEAR_PAGE succeeds cleanly');
      assertEqual(res.domState.hasWidget, false, 'CLEAR_PAGE never injects widget into untouched tab');
      assertEqual(res.domState.active, false, 'CLEAR_PAGE never activates untouched tab');
    }
  });

  // =========================================================================
  // F2: LLM Transport, SSE/NDJSON, 429 Pacing & LRU Cache
  // =========================================================================

  addTest({
    id: 'F2-T1-01',
    tier: 1,
    feature: 'F2',
    name: 'KCTCacheDB schema contract (kct_cache_db_v2, entries, ts index, MAX_ENTRIES=20000, round-trip)',
    usesBrowser: true,
    async run({ repoRoot }) {
      const sandboxServer = await startFixtureServer({
        roots: { '/shared': path.join(repoRoot, 'shared') },
        onRequest(req, res, rawPath) {
          if (rawPath === '/cache-sandbox.html') {
            const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><script src="/shared/cache-db.js"></script></head><body>cache sandbox</body></html>';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
            res.end(html);
            return true;
          }
          return false;
        }
      });

      try {
        const res = await runEgoScript(
          async ({ page, args }) => {
            await page.goto(`${args.baseUrl}/cache-sandbox.html`, { waitUntil: 'load' });
            return await page.evaluate(async () => {
              await KCTCacheDB.clear();
              await KCTCacheDB.putMany([
                { key: 'sig::a', zh: '測試甲' },
                { key: 'sig::b', zh: '測試乙' }
              ]);
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(KCTCacheDB.DB_NAME);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              const tx = db.transaction(KCTCacheDB.STORE_NAME, 'readonly');
              const store = tx.objectStore(KCTCacheDB.STORE_NAME);
              const hasTsIndex = store.indexNames.contains('ts');
              const keyPath = store.keyPath;
              db.close();
              const hit = await KCTCacheDB.getMany(['sig::a', 'sig::b', 'sig::missing']);
              const stats = await KCTCacheDB.stats();
              await KCTCacheDB.clear();
              const statsAfter = await KCTCacheDB.stats();
              return {
                dbName: KCTCacheDB.DB_NAME,
                storeName: KCTCacheDB.STORE_NAME,
                maxEntries: KCTCacheDB.MAX_ENTRIES,
                hasTsIndex,
                keyPath,
                hitA: hit.get('sig::a'),
                hitB: hit.get('sig::b'),
                hasMissing: hit.has('sig::missing'),
                stats,
                statsAfter
              };
            });
          },
          { args: { baseUrl: sandboxServer.baseUrl } }
        );

        assertEqual(res.dbName, 'kct_cache_db_v2', 'DB_NAME');
        assertEqual(res.storeName, 'entries', 'STORE_NAME');
        assertEqual(res.maxEntries, 20000, 'MAX_ENTRIES');
        assertEqual(res.hasTsIndex, true, 'ts index exists');
        assertEqual(res.keyPath, 'key', 'keyPath is key');
        assertEqual(res.hitA, '測試甲', 'getMany returns sig::a');
        assertEqual(res.hitB, '測試乙', 'getMany returns sig::b');
        assertEqual(res.hasMissing, false, 'missing key omitted');
        assertEqual(res.stats.entries, 2, 'stats entries === 2');
        assertEqual(res.statsAfter.entries, 0, 'clear resets entries to 0');
      } finally {
        await sandboxServer.close();
      }
    }
  });

  addTest({
    id: 'F2-T1-02',
    tier: 1,
    feature: 'F2',
    name: 'System prompt instructs preserving [[C#]], [[M#]], and [[L#]] placeholders in both stream & batch modes',
    usesBrowser: true,
    async run() {
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const capturedPrompts = [];
      const mockLlm = await startMockLlmServer((req, res) => {
        if (!JSON.stringify(req.body || '').includes(nonce)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const sys = req.body?.messages?.find((m) => m.role === 'system')?.content || '';
        capturedPrompts.push({ stream: Boolean(req.body?.stream), sys });
        if (req.body?.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"i":0,"t":"測試 [[C0]] [[M0]] [[L0]]"}\n' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 0, zh: '批次 [[C0]] [[M0]] [[L0]]' }] }) } }] }));
        }
      });

      try {
        await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                try {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      model: 'mock-prompt-model',
                      targetLang: 'custom',
                      customTargetLang: `TC-${nonceVal}`,
                      streamTranslation: true
                    }
                  });

                  await new Promise((resolve, reject) => {
                    const port = chrome.runtime.connect({ name: 'kct-stream' });
                    port.onMessage.addListener((msg) => {
                      if (msg.type === 'DONE') {
                        port.disconnect();
                        resolve();
                      } else if (msg.type === 'ERROR') {
                        port.disconnect();
                        reject(new Error(msg.error));
                      }
                    });
                    port.postMessage({
                      type: 'TRANSLATE_STREAM',
                      requestId: `p_stream_${nonceVal}`,
                      items: [{ key: `k_s_${nonceVal}`, text: `Stream [[C0]] [[M0]] [[L0]] ${nonceVal}` }]
                    });
                  });

                  await chrome.runtime.sendMessage({
                    type: 'TRANSLATE_BATCH',
                    items: [{ key: `k_b_${nonceVal}`, text: `Batch [[C0]] [[M0]] [[L0]] ${nonceVal}` }]
                  });
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(capturedPrompts.length, 2, 'Captured both stream and batch prompts');
        for (const p of capturedPrompts) {
          assertIncludes(p.sys, '[[C0]]', `Prompt (stream=${p.stream}) preserves [[C0]]`);
          assertIncludes(p.sys, '[[M0]]', `Prompt (stream=${p.stream}) preserves [[M0]]`);
          assertIncludes(p.sys, '[[L0]]', `Prompt (stream=${p.stream}) preserves [[L0]]`);
        }
      } finally {
        await mockLlm.close();
      }
    }
  });

  addTest({
    id: 'F2-T1-03',
    tier: 1,
    feature: 'F2',
    name: 'kct-stream Port emits ITEM/DONE and populates kct_cache_db_v2 so 2nd request hits cache without LLM call',
    usesBrowser: true,
    async run() {
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let matchedCalls = 0;
      const mockLlm = await startMockLlmServer((req, res) => {
        if (!JSON.stringify(req.body || '').includes(nonce)) {
          res.writeHead(404);
          res.end();
          return;
        }
        matchedCalls += 1;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"i":0,"t":"你好 [[C0]] 世界"}\n' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"i":1,"t":"第二 [[L0]] 項目"}\n' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const res = await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            return await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                const runStream = (items, requestId) =>
                  new Promise((resolve, reject) => {
                    const events = [];
                    const port = chrome.runtime.connect({ name: 'kct-stream' });
                    port.onMessage.addListener((msg) => {
                      events.push(msg);
                      if (msg.type === 'DONE') {
                        port.disconnect();
                        resolve(events);
                      } else if (msg.type === 'ERROR') {
                        port.disconnect();
                        reject(new Error(msg.error));
                      }
                    });
                    port.postMessage({ type: 'TRANSLATE_STREAM', requestId, items });
                  });

                try {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      model: 'mock-stream-model',
                      targetLang: 'custom',
                      customTargetLang: `CacheTest-${nonceVal}`,
                      streamTranslation: true
                    }
                  });
                  const items = [
                    { key: `k1_${nonceVal}`, text: `Hello [[C0]] world ${nonceVal}` },
                    { key: `k2_${nonceVal}`, text: `Second [[L0]] item ${nonceVal}` }
                  ];
                  const first = await runStream(items, `req1_${nonceVal}`);
                  const second = await runStream(items, `req2_${nonceVal}`);
                  return { first, second };
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(matchedCalls, 1, 'LLM called exactly once (2nd call served from cache)');
        const firstItems = res.first.filter((e) => e.type === 'ITEM' || e.type === 'CHUNK');
        const firstDone = res.first.find((e) => e.type === 'DONE');
        assertEqual(firstItems.length, 2, 'First stream delivered 2 items');
        assertEqual(firstItems[0].cached, false, 'First stream cached=false');
        assertEqual(firstDone?.translatedCount, 2, 'First DONE translatedCount=2');

        const secondItems = res.second.filter((e) => e.type === 'ITEM' || e.type === 'CHUNK');
        const secondDone = res.second.find((e) => e.type === 'DONE');
        assertEqual(secondItems.length, 2, 'Second stream delivered 2 cached items');
        assert(secondItems.every((it) => it.cached === true), 'Second stream items all cached=true');
        assertEqual(secondDone?.translatedCount, 2, 'Second DONE translatedCount=2');
      } finally {
        await mockLlm.close();
      }
    }
  });

  addTest({
    id: 'F2-T1-04',
    tier: 1,
    feature: 'F2',
    name: 'kct-stream ERROR on fatal HTTP 401 & missing-item release allows re-translation on next trigger',
    usesBrowser: true,
    async run() {
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let mode = 'fatal401';
      const mockLlm = await startMockLlmServer((req, res) => {
        if (mode === 'fatal401') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
          return;
        }
        if (!JSON.stringify(req.body || '').includes(nonce)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const userMsg = req.body?.messages?.find((m) => m.role === 'user')?.content || '';
        let parsedItems = [];
        try {
          const parsed = JSON.parse(userMsg);
          if (Array.isArray(parsed)) parsedItems = parsed;
        } catch (_) {}
        const itemCount = parsedItems.length;
        if (mode === 'omitSecond') {
          // Omit p2 across SSE stream, JSON batch fallback, and single-item plain-text fallback until /allow-second
          if (req.body?.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            if (String(parsedItems[0]?.text || '').includes('First paragraph')) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"i":0,"t":"僅第一段完成"}\n' } }] })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            const content = parsedItems.length > 0 ? JSON.stringify({ translations: [] }) : '';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content } }] }));
          }
          return;
        }
        if (req.body?.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          for (let i = 0; i < itemCount; i++) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ i, t: `補齊譯文 ${i}` }) + '\n' } }] })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } else if (parsedItems.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: '補齊譯文 0' } }] }));
        } else {
          const translations = Array.from({ length: itemCount }, (_, i) => ({ id: i, zh: `補齊譯文 ${i}` }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }));
        }
      });

      const pageServer = await startFixtureServer({
        onRequest(req, res, rawPath) {
          if (rawPath === '/allow-second') {
            mode = 'completeAll';
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 2 });
            res.end('ok');
            return true;
          }
          if (rawPath === '/missing-release.html') {
            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Missing Item Release</title></head><body><main><article><p id="p1">First paragraph unique ${nonce}.</p><p id="p2">Second paragraph unique ${nonce}.</p></article></main></body></html>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
            res.end(html);
            return true;
          }
          return false;
        }
      });

      try {
        const res1 = await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            return await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                try {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      fallbackProviderId: '',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      model: 'mock-err-model',
                      targetLang: 'custom',
                      customTargetLang: `Err-${nonceVal}`,
                      streamTranslation: true
                    }
                  });
                  return await new Promise((resolve) => {
                    const port = chrome.runtime.connect({ name: 'kct-stream' });
                    port.onMessage.addListener((msg) => {
                      if (msg.type === 'ERROR' || msg.type === 'DONE') {
                        port.disconnect();
                        resolve(msg);
                      }
                    });
                    port.postMessage({
                      type: 'TRANSLATE_STREAM',
                      requestId: `err_${nonceVal}`,
                      items: [{ key: `kerr_${nonceVal}`, text: `Auth fail test ${nonceVal}` }]
                    });
                  });
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(res1.type, 'ERROR', '401 emits ERROR event');
        assertEqual(res1.errorCode, 'HTTP_401', '401 sets HTTP_401 errorCode');

        mode = 'omitSecond';
        const res2 = await runEgoScript(
          async ({ task, page, args, helpers }) => {
            const pExt = await task.newPage();
            await pExt.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            await pExt.evaluate(async () => {
              const d = await chrome.storage.local.get('kct_settings_v1');
              window.__nrOrig = d.kct_settings_v1 || null;
            });

            try {
              await pExt.evaluate(async ({ v1Url, nonceVal }) => {
                await chrome.storage.local.set({
                  kct_settings_v1: {
                    ...(window.__nrOrig || {}),
                    settingsSchemaVersion: 5,
                    enabled: true,
                    autoTranslate: false,
                    providerId: 'custom',
                    fallbackProviderId: '',
                    protocol: 'openai',
                    baseUrl: v1Url,
                    apiKey: '',
                    model: 'mock-release-model',
                    targetLang: 'custom',
                    customTargetLang: `Rel-${nonceVal}`,
                    streamTranslation: true
                  }
                });
              }, { v1Url: args.v1Url, nonceVal: args.nonce });
              await helpers.setDesktopViewport(page, 1280, 800);
              await page.goto(args.pageUrl, { waitUntil: 'load' });
              await helpers.triggerExtensionOnTab(task, args.pageUrl, 'TRANSLATE_NOW');
              await page.waitForFunction(
                () => document.querySelectorAll('[data-kct-has-trans="1"]').length >= 1,
                undefined,
                { timeout: 10000 }
              );
              await page.waitForTimeout(800);
              const afterFirst = await page.evaluate(() => ({
                p1: document.getElementById('p1')?.hasAttribute('data-kct-has-trans'),
                p2: document.getElementById('p2')?.hasAttribute('data-kct-has-trans')
              }));

              await page.evaluate(() => fetch('/allow-second'));
              await helpers.triggerExtensionOnTab(task, args.pageUrl, 'TRANSLATE_NOW');
              await page.waitForFunction(
                () => Boolean(document.getElementById('p2')?.hasAttribute('data-kct-has-trans')),
                undefined,
                { timeout: 10000 }
              );
              const afterSecond = await page.evaluate(() => ({
                p1: document.getElementById('p1')?.hasAttribute('data-kct-has-trans'),
                p2: document.getElementById('p2')?.hasAttribute('data-kct-has-trans')
              }));
              return { afterFirst, afterSecond };
            } finally {
              await pExt.evaluate(async () => {
                if (window.__nrOrig) {
                  await chrome.storage.local.set({ kct_settings_v1: window.__nrOrig });
                } else {
                  await chrome.storage.local.remove('kct_settings_v1');
                }
              });
              await pExt.close();
            }
          },
          { args: { v1Url: mockLlm.v1Url, nonce, pageUrl: `${pageServer.baseUrl}/missing-release.html` } }
        );

        assertEqual(res2.afterFirst.p1, true, 'First paragraph translated on first pass');
        assertEqual(res2.afterFirst.p2, false, 'Omitted second paragraph left untranslated on first pass');
        assertEqual(res2.afterSecond.p2, true, 'Released omitted paragraph successfully translated on re-trigger');
      } finally {
        await pageServer.close();
        await mockLlm.close();
      }
    }
  });

  addTest({
    id: 'F2-T1-05',
    tier: 1,
    feature: 'F2',
    name: 'Multi-object & pretty-printed JSON parsed cleanly without duplicate emission or double-billing',
    usesBrowser: true,
    async run() {
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let matchedCalls = 0;
      const mockLlm = await startMockLlmServer((req, res) => {
        if (!JSON.stringify(req.body || '').includes(nonce)) {
          res.writeHead(404);
          res.end();
          return;
        }
        matchedCalls += 1;
        const prettyObjects = '{\n  "i": 0,\n  "t": "第一物件譯文"\n}\n{\n  "i": 1,\n  "t": "第二物件譯文"\n}\n';
        if (req.body?.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          // Split across multiple SSE chunks mid-object
          const half = Math.floor(prettyObjects.length / 2);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: prettyObjects.slice(0, half) } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: prettyObjects.slice(half) } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  translations: [
                    { id: 0, zh: '批次甲' },
                    { id: 1, zh: '批次乙' }
                  ]
                })
              }
            }]
          }));
        }
      });

      try {
        const res = await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            return await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                try {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      model: 'mock-pretty-model',
                      targetLang: 'custom',
                      customTargetLang: `Pretty-${nonceVal}`,
                      streamTranslation: true
                    }
                  });
                  const streamEvents = await new Promise((resolve, reject) => {
                    const ev = [];
                    const port = chrome.runtime.connect({ name: 'kct-stream' });
                    port.onMessage.addListener((msg) => {
                      ev.push(msg);
                      if (msg.type === 'DONE') {
                        port.disconnect();
                        resolve(ev);
                      } else if (msg.type === 'ERROR') {
                        port.disconnect();
                        reject(new Error(msg.error));
                      }
                    });
                    port.postMessage({
                      type: 'TRANSLATE_STREAM',
                      requestId: `pretty_${nonceVal}`,
                      items: [
                        { key: `kp1_${nonceVal}`, text: `Pretty one ${nonceVal}` },
                        { key: `kp2_${nonceVal}`, text: `Pretty two ${nonceVal}` }
                      ]
                    });
                  });

                  const batchResp = await chrome.runtime.sendMessage({
                    type: 'TRANSLATE_BATCH',
                    items: [
                      { key: `kb1_${nonceVal}`, text: `Batch multi one ${nonceVal}` },
                      { key: `kb2_${nonceVal}`, text: `Batch multi two ${nonceVal}` }
                    ]
                  });
                  return { streamEvents, batchResp };
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(matchedCalls, 2, 'Exactly 1 stream request + 1 batch request (zero fallback double-billing)');
        const items = res.streamEvents.filter((e) => e.type === 'ITEM' || e.type === 'CHUNK');
        const done = res.streamEvents.find((e) => e.type === 'DONE');
        assertEqual(items.length, 2, 'Pretty-printed multi-object stream emitted 2 unique items');
        assertEqual(done?.translatedCount, 2, 'DONE translatedCount === 2');
        assertEqual(res.batchResp?.ok, true, 'Multi-object batch response succeeded');
        assertEqual(res.batchResp?.results?.[`kb1_${nonce}`]?.zh, '批次甲', 'Multi-object batch item 0');
        assertEqual(res.batchResp?.results?.[`kb2_${nonce}`]?.zh, '批次乙', 'Multi-object batch item 1');
      } finally {
        await mockLlm.close();
      }
    }
  });

  addTest({
    id: 'F2-T2-01',
    tier: 2,
    feature: 'F2',
    name: 'True LRU vs FIFO eviction boundary at MAX_ENTRIES=20000 on isolated HTTP origin',
    usesBrowser: true,
    timeoutMs: 120000,
    async run({ repoRoot }) {
      const sandboxServer = await startFixtureServer({
        roots: { '/shared': path.join(repoRoot, 'shared') },
        onRequest(req, res, rawPath) {
          if (rawPath === '/lru-sandbox.html') {
            const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><script src="/shared/cache-db.js"></script></head><body>lru sandbox</body></html>';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
            res.end(html);
            return true;
          }
          return false;
        }
      });

      try {
        const res = await runEgoScript(
          async ({ page, args }) => {
            await page.goto(`${args.baseUrl}/lru-sandbox.html`, { waitUntil: 'load' });
            return await page.evaluate(async () => {
              await KCTCacheDB.clear();
              const baseTs = Date.now() - 200000;
              const batch1 = [];
              const batch2 = [];
              for (let i = 0; i < 10000; i++) {
                batch1.push({ key: `k_${i}`, zh: `v_${i}`, ts: baseTs + i * 2 });
              }
              for (let i = 10000; i < 20000; i++) {
                batch2.push({ key: `k_${i}`, zh: `v_${i}`, ts: baseTs + i * 2 });
              }
              await KCTCacheDB.putMany(batch1);
              await KCTCacheDB.putMany(batch2);

              // Touch k_0 (the absolute oldest entry!) so LRU protects it while k_1 becomes oldest untouched
              const touched = await KCTCacheDB.getMany(['k_0']);
              await new Promise((r) => setTimeout(r, 450));

              // Insert 1 new entry to push total past MAX_ENTRIES=20000
              await KCTCacheDB.putMany([{ key: 'k_20000', zh: 'v_20000', ts: Date.now() }]);

              const stats = await KCTCacheDB.stats();
              const check = await KCTCacheDB.getMany(['k_0', 'k_1', 'k_2', 'k_20000']);
              await KCTCacheDB.clear();
              return {
                touchedHit: touched.get('k_0'),
                entriesAfterEvict: stats.entries,
                k0Survives: check.has('k_0'),
                k1Evicted: !check.has('k_1'),
                k2Survives: check.has('k_2'),
                k20000Survives: check.has('k_20000')
              };
            });
          },
          { args: { baseUrl: sandboxServer.baseUrl } }
        );

        assertEqual(res.touchedHit, 'v_0', 'k_0 read succeeded');
        assertEqual(res.entriesAfterEvict, 20000, 'Store capped at MAX_ENTRIES=20000');
        assertEqual(res.k0Survives, true, 'Touched oldest k_0 survived LRU eviction');
        assertEqual(res.k1Evicted, true, 'Untouched oldest k_1 was evicted (true LRU, not FIFO)');
        assertEqual(res.k2Survives, true, 'k_2 survived');
        assertEqual(res.k20000Survives, true, 'Newly inserted k_20000 survived');
      } finally {
        await sandboxServer.close();
      }
    }
  });

  addTest({
    id: 'F2-T2-02',
    tier: 2,
    feature: 'F2',
    name: 'getMany 60s touch throttle skips fresh ts churn and refreshes stale ts',
    usesBrowser: true,
    async run({ repoRoot }) {
      const sandboxServer = await startFixtureServer({
        roots: { '/shared': path.join(repoRoot, 'shared') },
        onRequest(req, res, rawPath) {
          if (rawPath === '/touch-sandbox.html') {
            const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><script src="/shared/cache-db.js"></script></head><body>touch sandbox</body></html>';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
            res.end(html);
            return true;
          }
          return false;
        }
      });

      try {
        const res = await runEgoScript(
          async ({ page, args }) => {
            await page.goto(`${args.baseUrl}/touch-sandbox.html`, { waitUntil: 'load' });
            return await page.evaluate(async () => {
              await KCTCacheDB.clear();
              const now = Date.now();
              const freshTs = now - 5000;
              const staleTs = now - 70000;
              await KCTCacheDB.putMany([
                { key: 'fresh_key', zh: '新鮮', ts: freshTs },
                { key: 'stale_key', zh: '陳舊', ts: staleTs }
              ]);
              await KCTCacheDB.getMany(['fresh_key', 'stale_key']);
              await new Promise((r) => setTimeout(r, 450));

              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(KCTCacheDB.DB_NAME);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              const readRaw = (k) =>
                new Promise((resolve, reject) => {
                  const tx = db.transaction(KCTCacheDB.STORE_NAME, 'readonly');
                  const req = tx.objectStore(KCTCacheDB.STORE_NAME).get(k);
                  req.onsuccess = () => resolve(req.result);
                  req.onerror = () => reject(req.error);
                });
              const freshRec = await readRaw('fresh_key');
              const staleRec = await readRaw('stale_key');
              db.close();
              await KCTCacheDB.clear();
              return { freshTs, staleTs, freshAfter: freshRec?.ts, staleAfter: staleRec?.ts };
            });
          },
          { args: { baseUrl: sandboxServer.baseUrl } }
        );

        assertEqual(res.freshAfter, res.freshTs, 'Fresh key (<60s) ts was not rewritten');
        assert(res.staleAfter > res.staleTs + 60000, 'Stale key (>=60s) ts was refreshed on read');
      } finally {
        await sandboxServer.close();
      }
    }
  });

  addTest({
    id: 'F2-T2-03',
    tier: 2,
    feature: 'F2',
    name: 'translateItemsWithFallback bounds retries (<= 8 requests for 8 unparseable items)',
    usesBrowser: true,
    async run() {
      const mockLlm = await startMockLlmServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'not valid json response at all' } }] }));
      });

      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        const resp = await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            return await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                try {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      model: 'mock-bad-json',
                      targetLang: 'custom',
                      customTargetLang: `BadJson-${nonceVal}`,
                      streamTranslation: false
                    }
                  });
                  const items = Array.from({ length: 8 }, (_, idx) => ({
                    key: `kbad_${idx}_${nonceVal}`,
                    text: `Item ${idx} ${nonceVal}`
                  }));
                  return await chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH', items });
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(resp.ok, false, 'Malformed JSON batch returns ok:false');
        assertGreaterThanOrEqual(mockLlm.requests.length, 1, 'At least 1 attempt made');
        assertLessThanOrEqual(mockLlm.requests.length, 8, 'Bounded fallback requests <= 8 (no 2^N explosion)');
      } finally {
        await mockLlm.close();
      }
    }
  });

  addTest({
    id: 'F2-T2-05',
    tier: 2,
    feature: 'F2',
    name: 'Mixed SSE + fallback recovery recovers only missed items, and CANCEL_STREAM aborts cleanly',
    usesBrowser: true,
    async run() {
      let scenario = 'mixed';
      const fallbackBodies = [];
      const mockLlm = await startMockLlmServer((req, res) => {
        if (scenario === 'cancel') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          setTimeout(() => {
            if (!res.writableEnded) {
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }, 4000);
          return;
        }
        if (req.body?.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          // Deliver ONLY item 0; omit item 1
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"i":0,"t":"串流首項"}\n' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          const userMsg = req.body?.messages?.find((m) => m.role === 'user')?.content || '';
          fallbackBodies.push(userMsg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 0, zh: '補漏次項' }] }) } }] }));
        }
      });

      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        const res = await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            return await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                try {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      model: 'mock-mixed-model',
                      targetLang: 'custom',
                      customTargetLang: `Mixed-${nonceVal}`,
                      streamTranslation: true
                    }
                  });
                  const mixedEvents = await new Promise((resolve, reject) => {
                    const ev = [];
                    const port = chrome.runtime.connect({ name: 'kct-stream' });
                    port.onMessage.addListener((msg) => {
                      ev.push(msg);
                      if (msg.type === 'DONE') {
                        port.disconnect();
                        resolve(ev);
                      } else if (msg.type === 'ERROR') {
                        port.disconnect();
                        reject(new Error(msg.error));
                      }
                    });
                    port.postMessage({
                      type: 'TRANSLATE_STREAM',
                      requestId: `mix_${nonceVal}`,
                      items: [
                        { key: `km1_${nonceVal}`, text: `First mixed ${nonceVal}` },
                        { key: `km2_${nonceVal}`, text: `Second mixed ${nonceVal}` }
                      ]
                    });
                  });
                  return { mixedEvents };
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        const items = res.mixedEvents.filter((e) => e.type === 'ITEM' || e.type === 'CHUNK');
        const done = res.mixedEvents.find((e) => e.type === 'DONE');
        assertEqual(items.length, 2, 'Mixed stream + fallback emits 2 items total');
        assertEqual(done?.translatedCount, 2, 'DONE translatedCount === 2');
        assertEqual(fallbackBodies.length, 1, 'Fallback called once for missed item');
        assertNotIncludes(fallbackBodies[0], `First mixed ${nonce}`, 'Fallback did NOT re-send already streamed item 0');
        assertIncludes(fallbackBodies[0], `Second mixed ${nonce}`, 'Fallback sent only missed item 1');

        scenario = 'cancel';
        const cancelRes = await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            return await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                try {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      model: 'mock-cancel-model',
                      targetLang: 'custom',
                      customTargetLang: `Cancel-${nonceVal}`,
                      streamTranslation: true
                    }
                  });
                  return await new Promise((resolve) => {
                    const events = [];
                    const port = chrome.runtime.connect({ name: 'kct-stream' });
                    port.onMessage.addListener((msg) => events.push(msg));
                    port.postMessage({
                      type: 'TRANSLATE_STREAM',
                      requestId: `can_${nonceVal}`,
                      items: [{ key: `kc_${nonceVal}`, text: `Cancel test ${nonceVal}` }]
                    });
                    setTimeout(() => {
                      port.postMessage({ type: 'CANCEL_STREAM', requestId: `can_${nonceVal}` });
                    }, 150);
                    setTimeout(() => {
                      port.disconnect();
                      resolve({ events });
                    }, 500);
                  });
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(
          cancelRes.events.some((e) => e.type === 'ERROR'),
          false,
          'CANCEL_STREAM aborts cleanly without ERROR'
        );
      } finally {
        await mockLlm.close();
      }
    }
  });

  addTest({
    id: 'F2-T3-01',
    tier: 3,
    feature: 'F2',
    name: 'Pairwise: thinkingEffort (fastest/balanced/deep) x protocol (gemini/openai) request parameters',
    usesBrowser: true,
    async run() {
      const captured = [];
      const mockLlm = await startMockLlmServer((req, res) => {
        captured.push({ url: req.url, body: req.body });
        if (req.url.includes(':generateContent')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: JSON.stringify({ translations: [{ id: 0, zh: '雙子譯文' }] }) }] } }]
            })
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ translations: [{ id: 0, zh: '開放譯文' }] }) } }]
            })
          );
        }
      });

      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            await page.evaluate(
              async ({ baseUrl, v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                try {
                  const cases = [
                    { protocol: 'gemini', base: baseUrl, model: 'gemini-3.5-flash-lite', effort: 'fastest' },
                    { protocol: 'gemini', base: baseUrl, model: 'gemini-3.5-flash-lite', effort: 'balanced' },
                    { protocol: 'gemini', base: baseUrl, model: 'gemini-2.5-flash', effort: 'deep' },
                    { protocol: 'openai', base: v1Url, model: 'gpt-4o-mini', effort: 'fastest' },
                    { protocol: 'openai', base: v1Url, model: 'gpt-4o-mini', effort: 'deep' }
                  ];
                  for (let idx = 0; idx < cases.length; idx++) {
                    const c = cases[idx];
                    await chrome.storage.local.set({
                      kct_settings_v1: {
                        ...(orig.kct_settings_v1 || {}),
                        settingsSchemaVersion: 5,
                        providerId: 'custom',
                        protocol: c.protocol,
                        baseUrl: c.base,
                        apiKey: '',
                        model: c.model,
                        thinkingEffort: c.effort,
                        targetLang: 'custom',
                        customTargetLang: `PW-${idx}-${nonceVal}`,
                        streamTranslation: false
                      }
                    });
                    const r = await chrome.runtime.sendMessage({
                      type: 'TRANSLATE_BATCH',
                      items: [{ key: `kpw_${idx}_${nonceVal}`, text: `Pairwise ${idx} ${nonceVal}` }]
                    });
                    if (!r?.ok) throw new Error(`Pairwise case ${idx} failed: ${r?.error}`);
                  }
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { baseUrl: mockLlm.baseUrl, v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(captured.length, 5, 'All 5 pairwise requests captured');
        assertEqual(captured[0].body.generationConfig?.thinkingConfig?.thinkingLevel, 'MINIMAL', 'gemini-3.5 fastest');
        assertEqual(captured[1].body.generationConfig?.thinkingConfig?.thinkingLevel, 'LOW', 'gemini-3.5 balanced');
        assertEqual(captured[2].body.generationConfig?.thinkingConfig?.thinkingBudget, 2048, 'gemini-2.5 deep');
        assertEqual(captured[3].body.response_format?.type, 'json_object', 'openai json_object');
        assertEqual(captured[4].body.model, 'gpt-4o-mini', 'openai model');
      } finally {
        await mockLlm.close();
      }
    }
  });

  addTest({
    id: 'F2-T3-02',
    tier: 3,
    feature: 'F2',
    name: 'Pairwise: Cache signature isolation across targetLang, model, and customGlossary changes',
    usesBrowser: true,
    async run() {
      let seq = 0;
      const mockLlm = await startMockLlmServer((req, res) => {
        seq++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 0, zh: `譯文_${seq}` }] }) } }] }));
      });

      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        const res = await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            return await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                const itemKey = `ksig_${nonceVal}`;
                const itemText = `Cache signature isolation text ${nonceVal}`;
                const sendWith = async (patch) => {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      streamTranslation: false,
                      ...patch
                    }
                  });
                  return await chrome.runtime.sendMessage({
                    type: 'TRANSLATE_BATCH',
                    items: [{ key: itemKey, text: itemText }]
                  });
                };

                try {
                  const r1 = await sendWith({ model: 'm-a', targetLang: 'custom', customTargetLang: `L1-${nonceVal}`, customGlossary: 'term1=甲' });
                  const r2 = await sendWith({ model: 'm-b', targetLang: 'custom', customTargetLang: `L1-${nonceVal}`, customGlossary: 'term1=甲' });
                  const r3 = await sendWith({ model: 'm-b', targetLang: 'custom', customTargetLang: `L2-${nonceVal}`, customGlossary: 'term1=甲' });
                  const r4 = await sendWith({ model: 'm-b', targetLang: 'custom', customTargetLang: `L2-${nonceVal}`, customGlossary: 'term1=乙' });
                  const r5 = await sendWith({ model: 'm-b', targetLang: 'custom', customTargetLang: `L2-${nonceVal}`, customGlossary: 'term1=乙' });
                  return {
                    t1: r1.results?.[itemKey]?.zh,
                    t2: r2.results?.[itemKey]?.zh,
                    t3: r3.results?.[itemKey]?.zh,
                    t4: r4.results?.[itemKey]?.zh,
                    t5: r5.results?.[itemKey]?.zh
                  };
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(mockLlm.requests.length, 4, 'model, targetLang, and customGlossary changes each bust cache (4 calls, 5th hits)');
        assertEqual(res.t1, '譯文_1');
        assertEqual(res.t2, '譯文_2');
        assertEqual(res.t3, '譯文_3');
        assertEqual(res.t4, '譯文_4');
        assertEqual(res.t5, '譯文_4', 'Identical signature hits cache');
      } finally {
        await mockLlm.close();
      }
    }
  });

  // Run F2-T2-04 last among F2 tests because transient 429 activates 90s adaptive pacing in service-worker
  addTest({
    id: 'F2-T2-04',
    tier: 2,
    feature: 'F2',
    name: 'HTTP 429 daily quota stops immediately (QUOTA_EXCEEDED) & transient 429 retries and recovers',
    usesBrowser: true,
    async run() {
      let mode = 'dailyQuota';
      let transientAttempts = 0;
      const mockLlm = await startMockLlmServer((req, res) => {
        if (mode === 'dailyQuota') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_day, quotaValue: "0"'
              }
            })
          );
          return;
        }
        transientAttempts++;
        if (transientAttempts === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
          res.end(JSON.stringify({ error: { message: 'Rate limit reached, retry in 0.1s' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 0, zh: '重試成功譯文' }] }) } }] }));
      });

      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        const resDaily = await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            return await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                try {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      model: 'mock-quota-model',
                      targetLang: 'custom',
                      customTargetLang: `Quota-${nonceVal}`,
                      streamTranslation: false
                    }
                  });
                  return await chrome.runtime.sendMessage({
                    type: 'TRANSLATE_BATCH',
                    items: [{ key: `kq_${nonceVal}`, text: `Daily quota ${nonceVal}` }]
                  });
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(resDaily.ok, false, 'Daily quota returns ok:false');
        assertEqual(resDaily.errorCode, 'QUOTA_EXCEEDED', 'errorCode is QUOTA_EXCEEDED');
        assertEqual(mockLlm.requests.length, 1, 'Daily quota stops immediately in 1 request (zero retries)');

        mode = 'transient';
        mockLlm.clearRequests();
        const resTransient = await runEgoScript(
          async ({ page, args, helpers }) => {
            await page.goto(`${helpers.EXT_ORIGIN}/options/options.html`, { waitUntil: 'domcontentloaded' });
            return await page.evaluate(
              async ({ v1Url, nonceVal }) => {
                const orig = await chrome.storage.local.get('kct_settings_v1');
                try {
                  await chrome.storage.local.set({
                    kct_settings_v1: {
                      ...(orig.kct_settings_v1 || {}),
                      settingsSchemaVersion: 5,
                      providerId: 'custom',
                      protocol: 'openai',
                      baseUrl: v1Url,
                      apiKey: '',
                      model: 'mock-retry-model',
                      targetLang: 'custom',
                      customTargetLang: `Retry-${nonceVal}`,
                      streamTranslation: false
                    }
                  });
                  return await chrome.runtime.sendMessage({
                    type: 'TRANSLATE_BATCH',
                    items: [{ key: `kr_${nonceVal}`, text: `Transient 429 ${nonceVal}` }]
                  });
                } finally {
                  if (orig.kct_settings_v1) {
                    await chrome.storage.local.set({ kct_settings_v1: orig.kct_settings_v1 });
                  } else {
                    await chrome.storage.local.remove('kct_settings_v1');
                  }
                }
              },
              args
            );
          },
          { args: { v1Url: mockLlm.v1Url, nonceVal: nonce } }
        );

        assertEqual(resTransient.ok, true, 'Transient 429 recovers on retry');
        assertEqual(resTransient.results?.[`kr_${nonce}`]?.zh, '重試成功譯文', 'Transient 429 returns translated text');
        assertEqual(mockLlm.requests.length, 2, 'Transient 429 took exactly 2 attempts');
      } finally {
        await mockLlm.close();
      }
    }
  });

  // =========================================================================
  // F9: Static, Build, Userscript & Android ZIP Parity
  // =========================================================================

  addTest({
    id: 'F9-T1-01',
    tier: 1,
    feature: 'F9',
    name: 'All repository and E2E .js/.mjs files pass node --check',
    usesBrowser: false,
    async run({ repoRoot }) {
      const files = walkFiles(repoRoot, (_full, name) => name.endsWith('.js') || name.endsWith('.mjs'));
      assertGreaterThanOrEqual(files.length, 18, 'At least 18 JS/MJS files checked');
      for (const f of files) {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      }
    }
  });

  addTest({
    id: 'F9-T1-02',
    tier: 1,
    feature: 'F9',
    name: 'docs/ PWA shell assets, .nojekyll, vendor/pdfjs & icons byte parity',
    usesBrowser: false,
    async run({ repoRoot }) {
      const docsDir = path.join(repoRoot, 'docs');
      assert(fs.existsSync(path.join(docsDir, '.nojekyll')), 'docs/.nojekyll exists');

      const manifest = JSON.parse(fs.readFileSync(path.join(docsDir, 'manifest.webmanifest'), 'utf8'));
      for (const icon of manifest.icons || []) {
        assert(fs.existsSync(path.join(docsDir, icon.src)), `Manifest icon exists: ${icon.src}`);
      }

      const swJs = fs.readFileSync(path.join(docsDir, 'sw.js'), 'utf8');
      const assetBlock = swJs.match(/APP_SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]/)?.[1] || '';
      const assets = [...assetBlock.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
      assertGreaterThanOrEqual(assets.length, 8, 'APP_SHELL_ASSETS populated');
      for (const rel of assets) {
        if (rel === './') continue;
        assert(fs.existsSync(path.join(docsDir, rel)), `sw.js asset exists: ${rel}`);
      }

      for (const pair of [
        ['vendor/pdfjs/pdf.min.mjs', 'docs/vendor/pdfjs/pdf.min.mjs'],
        ['vendor/pdfjs/pdf.worker.min.mjs', 'docs/vendor/pdfjs/pdf.worker.min.mjs'],
        ['icons/icon-16.png', 'docs/icons/icon-16.png'],
        ['icons/icon-48.png', 'docs/icons/icon-48.png'],
        ['icons/icon-128.png', 'docs/icons/icon-128.png']
      ]) {
        const a = fs.readFileSync(path.join(repoRoot, pair[0]));
        const b = fs.readFileSync(path.join(repoRoot, pair[1]));
        assert(a.equals(b), `Byte parity mismatch: ${pair[0]} vs ${pair[1]}`);
      }
    }
  });

  addTest({
    id: 'F9-T1-03',
    tier: 1,
    feature: 'F9',
    name: 'docs/nativeread.user.js ==UserScript== header metadata contract',
    usesBrowser: false,
    async run({ repoRoot }) {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
      const us = fs.readFileSync(path.join(repoRoot, 'docs/nativeread.user.js'), 'utf8');
      const header = us.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)?.[0] || '';
      assert(header.length > 0, '==UserScript== header block present');
      for (const line of [
        '@name',
        '@namespace    https://chih-kai-wang.github.io/native-read/',
        `@version      ${manifest.version}`,
        '@match        *://*/*',
        '@grant        GM_getValue',
        '@grant        GM_setValue',
        '@grant        GM_xmlhttpRequest',
        '@grant        GM.xmlHttpRequest',
        '@connect      *',
        '@run-at       document-idle'
      ]) {
        assertIncludes(header, line, `UserScript header contains ${line}`);
      }
    }
  });

  addTest({
    id: 'F9-T1-04',
    tier: 1,
    feature: 'F9',
    name: 'docs/nativeread-android-extension.zip allowlist & exclusion of tests/ and .agents/',
    usesBrowser: false,
    async run({ repoRoot }) {
      const zipPath = path.join(repoRoot, 'docs/nativeread-android-extension.zip');
      assert(fs.existsSync(zipPath), 'Android extension ZIP exists');
      const listOut = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
      const entries = listOut.split(/\r?\n/).filter(Boolean);

      for (const required of [
        'manifest.json',
        'shared/config.js',
        'shared/cache-db.js',
        'background/service-worker.js',
        'content/content.js',
        'popup/popup.html',
        'options/options.html',
        'viewer/pdf-viewer.html',
        'vendor/pdfjs/pdf.min.mjs',
        'icons/icon-128.png',
        'LICENSE',
        'README.md'
      ]) {
        assertIncludes(entries, required, `ZIP includes ${required}`);
      }
      for (const e of entries) {
        assert(!e.startsWith('tests/'), `ZIP must exclude tests/: ${e}`);
        assert(!e.startsWith('.agents/'), `ZIP must exclude .agents/: ${e}`);
        assert(!e.startsWith('docs/'), `ZIP must exclude docs/: ${e}`);
        assert(!e.startsWith('scripts/'), `ZIP must exclude scripts/: ${e}`);
        assert(!e.startsWith('.git/'), `ZIP must exclude .git/: ${e}`);
      }
    }
  });

  addTest({
    id: 'F9-T1-05',
    tier: 1,
    feature: 'F9',
    name: 'scripts/build-mobile.js isolated execution builds clean ZIP excluding dummy tests/ and .agents/',
    usesBrowser: false,
    async run({ repoRoot }) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr_build_iso_'));
      try {
        for (const item of [
          'manifest.json',
          'shared',
          'background',
          'content',
          'popup',
          'options',
          'viewer',
          'vendor',
          'icons',
          'docs',
          'scripts',
          'LICENSE',
          ...listRootReadmes(repoRoot)
        ]) {
          const src = path.join(repoRoot, item);
          if (fs.existsSync(src)) {
            fs.cpSync(src, path.join(tmpDir, item), { recursive: true });
          }
        }
        fs.mkdirSync(path.join(tmpDir, 'tests/e2e'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'tests/e2e/dummy.js'), '// dummy\n');
        fs.mkdirSync(path.join(tmpDir, '.agents/teamwork'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, '.agents/teamwork/dummy.md'), '# dummy\n');

        execFileSync(process.execPath, ['scripts/build-mobile.js'], { cwd: tmpDir, stdio: 'pipe' });

        const builtZip = path.join(tmpDir, 'docs/nativeread-android-extension.zip');
        assert(fs.existsSync(builtZip), 'Isolated build produced ZIP');
        const entries = execFileSync('unzip', ['-Z1', builtZip], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter(Boolean);
        assertIncludes(entries, 'manifest.json', 'Built ZIP includes manifest.json');
        for (const r of listRootReadmes(tmpDir)) {
          assertIncludes(entries, r, `Built ZIP includes ${r}`);
        }
        assert(!entries.some((e) => e.startsWith('tests/') || e.startsWith('.agents/')), 'Built ZIP excludes tests/ and .agents/');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  addTest({
    id: 'F9-T2-01',
    tier: 2,
    feature: 'F9',
    name: 'docs/nativeread.user.js embedded source parity with shared/config.js & content/*',
    usesBrowser: false,
    async run({ repoRoot }) {
      const us = fs.readFileSync(path.join(repoRoot, 'docs/nativeread.user.js'), 'utf8');
      for (const rel of ['shared/config.js', 'content/site-analyzer.js', 'content/code-overlay.js', 'content/renderer.js']) {
        const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8').trim();
        assertIncludes(us, src, `nativeread.user.js embeds up-to-date ${rel}`);
      }
      const css = fs.readFileSync(path.join(repoRoot, 'content/content.css'), 'utf8');
      assertIncludes(us, JSON.stringify(css), 'nativeread.user.js embeds up-to-date content/content.css');
    }
  });

  addTest({
    id: 'F9-T2-02',
    tier: 2,
    feature: 'F9',
    name: 'docs/nativeread.user.js M6 runtime parity contracts ([[L#]], baseUrl preserve, 429 retry, LRU ts)',
    usesBrowser: false,
    async run({ repoRoot }) {
      const us = fs.readFileSync(path.join(repoRoot, 'docs/nativeread.user.js'), 'utf8');
      assertIncludes(us, '[[L0]]', 'Userscript prompt instructs preserving [[L0]] inline links');
      assert(!/saveModalBtn[\s\S]{0,600}baseUrl:\s*preset\.baseUrl/.test(us), 'Userscript modal save must preserve custom baseUrl rather than overwriting with preset.baseUrl');
      assertMatch(us, /createIndex\(['"]ts['"]/, 'Userscript IndexedDB store creates ts index for LRU eviction');
      assertMatch(us, /status\s*===\s*429/, 'Userscript implements HTTP 429 retry handling');
    }
  });

  addTest({
    id: 'F9-T2-03',
    tier: 2,
    feature: 'F9',
    name: 'Live docs/nativeread-android-extension.zip byte parity for manifest.json, shared/*, and all README*.md',
    usesBrowser: false,
    async run({ repoRoot }) {
      const zipPath = path.join(repoRoot, 'docs/nativeread-android-extension.zip');
      const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean);
      const targets = ['manifest.json', 'shared/config.js', 'shared/cache-db.js', ...listRootReadmes(repoRoot)];
      for (const rel of targets) {
        assertIncludes(entries, rel, `Live ZIP includes ${rel}`);
        const zipBuf = execFileSync('unzip', ['-p', zipPath, rel]);
        const diskBuf = fs.readFileSync(path.join(repoRoot, rel));
        assert(zipBuf.equals(diskBuf), `Live ZIP byte parity mismatch for ${rel}`);
      }
    }
  });

  addTest({
    id: 'F9-T2-04',
    tier: 2,
    feature: 'F9',
    name: 'Local HTTP server MIME types (/docs redirect, .mjs, .webmanifest, .jpg, .pdf) & traversal 403',
    usesBrowser: false,
    async run({ fixtureServer }) {
      const rRedir = await fetch(`${fixtureServer.baseUrl}/docs`, { redirect: 'manual' });
      assertEqual(rRedir.status, 302, '/docs redirects 302');
      assertEqual(rRedir.headers.get('location'), '/docs/', 'Location /docs/');

      const rMjs = await fetch(`${fixtureServer.docsUrl}vendor/pdfjs/pdf.min.mjs`);
      assertEqual(rMjs.status, 200, '.mjs status 200');
      assertIncludes(rMjs.headers.get('content-type') || '', 'application/javascript', '.mjs MIME');

      const rMan = await fetch(`${fixtureServer.docsUrl}manifest.webmanifest`);
      assertEqual(rMan.status, 200, '.webmanifest status 200');
      assertIncludes(rMan.headers.get('content-type') || '', 'application/manifest+json', '.webmanifest MIME');

      const rJpg = await fetch(`${fixtureServer.fixturesUrl}assets/infographic.jpg`);
      assertEqual(rJpg.status, 200, 'infographic.jpg status 200');
      assertIncludes(rJpg.headers.get('content-type') || '', 'image/jpeg', 'infographic.jpg MIME');

      const rPdf = await fetch(`${fixtureServer.fixturesUrl}pdfs/two-col-academic.pdf`);
      assertEqual(rPdf.status, 200, 'PDF status 200');
      assertIncludes(rPdf.headers.get('content-type') || '', 'application/pdf', 'PDF MIME');

      const rTrav = await fetch(`${fixtureServer.baseUrl}/fixtures/../package.json`);
      assertEqual(rTrav.status, 403, 'Path traversal rejected with 403');
    }
  });

  addTest({
    id: 'F9-T2-05',
    tier: 2,
    feature: 'F9',
    name: 'scripts/build-mobile.js dynamically includes sibling README*.md files in temp build',
    usesBrowser: false,
    async run({ repoRoot }) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr_build_readme_'));
      try {
        for (const item of [
          'manifest.json', 'shared', 'background', 'content', 'popup', 'options',
          'viewer', 'vendor', 'icons', 'docs', 'scripts', 'LICENSE', 'README.md'
        ]) {
          fs.cpSync(path.join(repoRoot, item), path.join(tmpDir, item), { recursive: true });
        }
        fs.writeFileSync(path.join(tmpDir, 'README.ja.md'), '# NativeRead JA\n');
        execFileSync(process.execPath, ['scripts/build-mobile.js'], { cwd: tmpDir, stdio: 'pipe' });
        const entries = execFileSync('unzip', ['-Z1', path.join(tmpDir, 'docs/nativeread-android-extension.zip')], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter(Boolean);
        assertIncludes(entries, 'README.ja.md', 'build-mobile.js dynamically bundles README.ja.md into ZIP');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  addTest({
    id: 'F9-T3-01',
    tier: 3,
    feature: 'F9',
    name: 'Pairwise: manifest version === userscript @version === ZIP manifest & all sw.js assets serve 200',
    usesBrowser: false,
    async run({ repoRoot, fixtureServer }) {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
      const us = fs.readFileSync(path.join(repoRoot, 'docs/nativeread.user.js'), 'utf8');
      const usVer = us.match(/@version\s+([^\s]+)/)?.[1] || '';
      const zipManifest = JSON.parse(
        execFileSync('unzip', ['-p', path.join(repoRoot, 'docs/nativeread-android-extension.zip'), 'manifest.json'], {
          encoding: 'utf8'
        })
      );
      assertEqual(usVer, manifest.version, 'Userscript @version matches manifest.json');
      assertEqual(zipManifest.version, manifest.version, 'ZIP manifest version matches manifest.json');

      const swJs = fs.readFileSync(path.join(repoRoot, 'docs/sw.js'), 'utf8');
      const assetBlock = swJs.match(/APP_SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]/)?.[1] || '';
      const assets = [...assetBlock.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const rel of assets) {
        const clean = rel.replace(/^\.\//, '');
        const resp = await fetch(`${fixtureServer.docsUrl}${clean}`);
        assertEqual(resp.status, 200, `PWA sw.js asset ${rel} returns HTTP 200`);
      }
    }
  });

  // =========================================================================
  // F10: Multilingual Product, Technical & Security READMEs
  // =========================================================================

  addTest({
    id: 'F10-T1-01',
    tier: 1,
    feature: 'F10',
    name: 'Multilingual README suite > 3 languages with unique content per language',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      assert(readmes.length > 3, `Expected > 3 README*.md files, found ${readmes.length}`);
      for (const expected of [
        'README.md',
        'README.zh-TW.md',
        'README.zh-CN.md',
        'README.ja.md',
        'README.ko.md',
        'README.es.md',
        'README.fr.md',
        'README.de.md'
      ]) {
        assertIncludes(readmes, expected, `Missing multilingual README: ${expected}`);
      }
      const contents = readmes.map((f) => fs.readFileSync(path.join(repoRoot, f), 'utf8').trim());
      assertEqual(new Set(contents).size, readmes.length, 'Every README language version must be distinct');
    }
  });

  addTest({
    id: 'F10-T1-02',
    tier: 1,
    feature: 'F10',
    name: 'Complete N x (N-1) bidirectional cross-language navigation links across all README*.md',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      assert(readmes.length > 3, 'Requires > 3 README files for multilingual navigation');
      for (const file of readmes) {
        const md = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        const links = extractMarkdownAndHtmlLinks(md).map((l) => l.replace(/^\.\//, '').split('#')[0]);
        for (const sibling of readmes) {
          if (sibling === file) continue;
          assertIncludes(links, sibling, `${file} missing cross-language link to ${sibling}`);
        }
      }
    }
  });

  addTest({
    id: 'F10-T1-03',
    tier: 1,
    feature: 'F10',
    name: 'Zero broken relative file or Unicode #anchor links across all README*.md',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      const anchorCache = new Map();
      const getAnchors = (relPath) => {
        if (!anchorCache.has(relPath)) {
          anchorCache.set(relPath, extractHeadingAnchors(fs.readFileSync(path.join(repoRoot, relPath), 'utf8')));
        }
        return anchorCache.get(relPath);
      };

      for (const file of readmes) {
        const md = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        const links = extractMarkdownAndHtmlLinks(md);
        for (const rawTarget of links) {
          if (/^(?:https?:|mailto:|data:|javascript:)/i.test(rawTarget)) continue;
          const [relPart, hashPart] = rawTarget.split('#');
          const targetRel = relPart ? relPart.replace(/^\.\//, '') : file;
          const absTarget = path.resolve(repoRoot, targetRel);
          assert(fs.existsSync(absTarget), `${file} has broken relative link: ${rawTarget}`);
          if (hashPart && targetRel.endsWith('.md')) {
            const anchors = getAnchors(targetRel);
            const decoded = decodeURIComponent(hashPart);
            assert(
              anchors.has(hashPart) || anchors.has(decoded),
              `${file} has broken #anchor link: ${rawTarget}`
            );
          }
        }
      }
    }
  });

  addTest({
    id: 'F10-T1-04',
    tier: 1,
    feature: 'F10',
    name: 'Every README*.md covers Product Overview (extension, PDF.js, PWA, Userscript, Android ZIP, #nr_sync)',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      for (const file of readmes) {
        const md = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        for (const token of [
          'NativeRead',
          'Alt+T',
          'PDF.js',
          'nativeread.user.js',
          'nativeread-android-extension.zip',
          '#nr_sync',
          'QR'
        ]) {
          assertIncludes(md, token, `${file} Product Overview missing ${token}`);
        }
      }
    }
  });

  addTest({
    id: 'F10-T1-05',
    tier: 1,
    feature: 'F10',
    name: 'Every README*.md covers Technical Architecture (Decision Model, PDF pipeline, SSE/LRU, R4 Vision)',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      for (const file of readmes) {
        const md = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        for (const token of [
          'site-analyzer.js',
          'Shadow DOM',
          '[[C',
          '[[M',
          '[[L',
          'renderer.js',
          'pdf-viewer.js',
          'SSE',
          'NDJSON',
          'IntersectionObserver',
          'kct_cache_db_v2'
        ]) {
          assertIncludes(md, token, `${file} Technical Architecture missing ${token}`);
        }
        assertMatch(
          md,
          /TRANSLATE_IMAGE|Vision|inlineData|image_url|box_2d|0[–-]1000/i,
          `${file} missing R4 Vision Image Overlay architecture explanation`
        );
      }
    }
  });

  addTest({
    id: 'F10-T2-01',
    tier: 2,
    feature: 'F10',
    name: 'Every README*.md includes migrated Privacy & Security Architecture section',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      for (const file of readmes) {
        const md = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        for (const token of [
          'chrome.storage.local',
          'IndexedDB',
          'createTextNode',
          'isEvalSupported',
          'content_scripts',
          'autoTranslate'
        ]) {
          assertIncludes(md, token, `${file} Security section missing ${token}`);
        }
      }
    }
  });

  addTest({
    id: 'F10-T2-02',
    tier: 2,
    feature: 'F10',
    name: 'Section count parity across all multilingual README*.md (>= 6 H2 sections)',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      assert(readmes.length > 3, 'Requires > 3 README files');
      for (const file of readmes) {
        const md = stripFencedCodeBlocks(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
        const h2Count = (md.match(/^##\s+/gm) || []).length;
        assertGreaterThanOrEqual(h2Count, 6, `${file} H2 section count >= 6`);
      }
    }
  });

  addTest({
    id: 'F10-T2-03',
    tier: 2,
    feature: 'F10',
    name: 'Zero raw API key patterns leaked in any README*.md',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      const secretRe = /AIza[0-9A-Za-z_-]{16,}|\bsk-(?:or-|proj-)?[0-9A-Za-z_-]{16,}|\bAQ\.[0-9A-Za-z_.-]{16,}/;
      for (const file of readmes) {
        const md = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        assertNotMatch(md, secretRe, `${file} must not contain raw API keys`);
      }
    }
  });

  addTest({
    id: 'F10-T2-04',
    tier: 2,
    feature: 'F10',
    name: 'Every README*.md includes Mermaid architecture diagram and repository tree',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      for (const file of readmes) {
        const md = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        assertIncludes(md, '```mermaid', `${file} missing mermaid diagram`);
        assertIncludes(md, 'manifest.json', `${file} missing project structure manifest.json`);
        assertIncludes(md, 'service-worker.js', `${file} missing service-worker.js in structure`);
      }
    }
  });

  addTest({
    id: 'F10-T2-05',
    tier: 2,
    feature: 'F10',
    name: 'Cross-language switcher appears in header (first 40 lines) of every README*.md',
    usesBrowser: false,
    async run({ repoRoot }) {
      const readmes = listRootReadmes(repoRoot);
      assert(readmes.length > 3, 'Requires > 3 README files');
      for (const file of readmes) {
        const topLines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split(/\r?\n/).slice(0, 40).join('\n');
        for (const sibling of readmes) {
          if (sibling === file) continue;
          assertIncludes(topLines, sibling, `${file} header switcher (top 40 lines) missing ${sibling}`);
        }
      }
    }
  });

  addTest({
    id: 'F10-T3-01',
    tier: 3,
    feature: 'F10',
    name: 'Cross-check documented repo paths and LICENSE links exist on disk for every README*.md',
    usesBrowser: false,
    async run({ repoRoot }) {
      const documentedFiles = [
        'manifest.json',
        'shared/config.js',
        'shared/cache-db.js',
        'background/service-worker.js',
        'content/site-analyzer.js',
        'content/renderer.js',
        'viewer/pdf-viewer.js',
        'docs/nativeread.user.js',
        'scripts/build-mobile.js',
        'LICENSE',
        'vendor/pdfjs/LICENSE'
      ];
      for (const rel of documentedFiles) {
        assert(fs.existsSync(path.join(repoRoot, rel)), `Documented file missing on disk: ${rel}`);
      }
      for (const file of listRootReadmes(repoRoot)) {
        const md = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        assertIncludes(md, 'LICENSE', `${file} links LICENSE`);
      }
    }
  });
}
