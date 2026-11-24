(() => {
  if (globalThis.KCTRenderer) return;

  const { resolveTargetLanguage } = globalThis.KCTConfig;
  const KCTSiteAnalyzer = globalThis.KCTSiteAnalyzer;

  const SHADOW_MODE_CSS = [
    ':host-context(html.kct-mode-replace) .kct-orig-wrap { display: none !important; }',
    ':host-context(html.kct-mode-replace) .kct-trans-wrap { display: contents; }',
    ':host-context(html.kct-mode-original) .kct-trans-wrap { display: none !important; }',
    ':host-context(html.kct-mode-original) .kct-orig-wrap { display: contents; }',
    ':host-context(html.kct-mode-bilingual) .kct-orig-wrap { display: contents; }',
    ':host-context(html.kct-mode-bilingual) .kct-trans-wrap { display: block; margin-top: 0.35em; padding-left: 10px; border-left: 2px solid rgba(148,163,184,0.45); font-size: 0.94em; line-height: 1.7; opacity: 0.88; }',
    ':host-context(html.kct-mode-bilingual) .kct-trans-wrap [data-kct-atomic="box"] { display: none !important; }',
    ':host-context(html.kct-mode-replace) [data-kct-structure-fallback="1"] > .kct-orig-wrap { display: contents !important; }',
    '.kct-flex-run { min-width: 0; }'
  ].join('\n');

  const GENERIC_FONT_TOKENS = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-serif',
    'ui-sans-serif',
    'ui-monospace',
    'ui-rounded',
    '-apple-system',
    'blinkmacsystemfont',
    'emoji',
    'math',
    'fangsong'
  ]);

  function sanitizeFontFamily(rawFont) {
    if (!rawFont) return '';
    // Split on commas outside quotes so we can strip generic catch-all families
    // (which would otherwise intercept CJK fallback before --kct-font-* is reached)
    // and avoid slicing mid-quote.
    const tokens = [];
    let buf = '';
    let quote = null;
    for (let i = 0; i < rawFont.length; i++) {
      const ch = rawFont[i];
      if (quote) {
        if (ch === '\\' && i + 1 < rawFont.length) {
          i += 1;
          continue;
        }
        if (ch === quote) quote = null;
        else buf += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ',') {
        tokens.push(buf.trim());
        buf = '';
      } else {
        buf += ch;
      }
    }
    if (buf.trim()) tokens.push(buf.trim());

    const kept = [];
    for (const rawTok of tokens) {
      if (/[;:{}\\<>@`\r\n]/.test(rawTok)) continue;
      const clean = rawTok.replace(/["']/g, '').trim();
      if (!clean || clean.length > 60) continue;
      if (GENERIC_FONT_TOKENS.has(clean.toLowerCase())) continue;
      kept.push(/\s/.test(clean) ? `"${clean}"` : clean);
      if (kept.length >= 5) break;
    }
    return kept.join(', ');
  }

  function ensureShadowModeStyle(el) {
    const rootNode = el.getRootNode ? el.getRootNode() : null;
    if (!rootNode || !(rootNode instanceof ShadowRoot)) return;
    if (rootNode.querySelector('style[data-kct-ui="shadow-mode-style"]')) return;
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-kct-ui', 'shadow-mode-style');
    styleEl.textContent = SHADOW_MODE_CSS;
    rootNode.appendChild(styleEl);
  }

  function detectPageDarkBackground() {
    if (
      document.body?.dataset?.jpThemeLight === 'false' ||
      document.documentElement?.getAttribute('data-theme') === 'dark' ||
      document.documentElement?.classList.contains('dark') ||
      document.body?.classList.contains('theme-dark')
    ) {
      return true;
    }
    const candidates = [document.body, document.documentElement].filter(Boolean);
    for (const el of candidates) {
      const bg = getComputedStyle(el).backgroundColor || '';
      const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
      if (m) {
        const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
        if (alpha < 0.15) continue;
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return lum < 115;
      }
    }
    return false;
  }

  function applyDisplayModeClass(settings) {
    const root = document.documentElement;
    if (!root) return;

    root.classList.toggle('kct-active', settings?.enabled !== false);
    root.classList.toggle('kct-page-dark', detectPageDarkBackground());

    root.classList.remove('kct-mode-bilingual', 'kct-mode-replace', 'kct-mode-original');
    const resolvedMode = settings?.displayMode || 'replace';
    if (resolvedMode === 'original') {
      root.classList.add('kct-mode-original');
    } else if (resolvedMode === 'bilingual') {
      root.classList.add('kct-mode-bilingual');
    } else {
      root.classList.add('kct-mode-replace');
    }

    root.classList.toggle('kct-comments-on', settings?.translateCodeComments !== false);

    root.classList.remove('kct-lang-tc', 'kct-lang-sc', 'kct-lang-ja', 'kct-lang-ko', 'kct-lang-latin');
    const langInfo = resolveTargetLanguage(settings);
    root.classList.add(langInfo.fontClass || 'kct-lang-tc');

    root.classList.remove('kct-typo-native', 'kct-typo-system', 'kct-typo-preserve');
    const typoMode = settings?.typographyMatch || 'native';
    if (typoMode === 'system') {
      root.classList.add('kct-typo-system');
    } else if (typoMode === 'preserve') {
      root.classList.add('kct-typo-preserve');
    } else {
      root.classList.add('kct-typo-native');
    }
  }

  const TOKEN_SPLIT_RE = /(\[\[\s*\/?[CMLAS]\d+\s*\]\])/g;
  const TOKEN_MATCH_RE = /^\[\[\s*(\/?)([CMLAS])(\d+)\s*\]\]$/;

  function normalizeBracketTokens(zhText) {
    return String(zhText || '')
      .replace(/[［【]{2}\s*(\/?)\s*([cmlasCMLAS])\s*(\d+)\s*[］】]{2}/g, (_, slash, type, id) => {
        return `[[${slash}${type.toUpperCase()}${id}]]`;
      })
      .replace(/\[\[\s*(\/?)([cmlas])(\d+)\s*\]\]/g, (_, slash, type, id) => {
        return `[[${slash}${type.toUpperCase()}${id}]]`;
      });
  }

  function stripAllTokens(zhText) {
    return String(zhText || '').replace(/\[\[\s*\/?[CMLAS]\d+\s*\]\]/g, '');
  }

  function validateTranslatedTokens(zhText, placeholders) {
    const text = String(zhText || '');
    const map = placeholders instanceof Map ? placeholders : new Map();

    const atomicCounts = new Map();
    const openCounts = new Map();
    const closeCounts = new Map();

    for (const key of map.keys()) {
      const km = key.match(/^\[\[([CMLAS])(\d+)\]\]$/);
      if (!km) continue;
      const type = km[1];
      if (type === 'A' || type === 'S') {
        openCounts.set(key, 0);
        closeCounts.set(key, 0);
      } else {
        atomicCounts.set(key, 0);
      }
    }

    const stack = [];
    const scanRe = /\[\[\s*(\/?)([CMLAS])(\d+)\s*\]\]/g;
    let m;
    while ((m = scanRe.exec(text)) !== null) {
      const isClose = m[1] === '/';
      const type = m[2];
      const id = m[3];
      const openKey = `[[${type}${id}]]`;

      if (!map.has(openKey)) {
        return { ok: false, reason: `unknown token ${m[0]}` };
      }

      if (type === 'C' || type === 'M' || type === 'L') {
        if (isClose) {
          return { ok: false, reason: `unexpected closing atomic token ${m[0]}` };
        }
        const nextCount = (atomicCounts.get(openKey) || 0) + 1;
        if (nextCount > 1) {
          return { ok: false, reason: `duplicate atomic token ${openKey}` };
        }
        atomicCounts.set(openKey, nextCount);
      } else {
        if (!isClose) {
          const nextCount = (openCounts.get(openKey) || 0) + 1;
          if (nextCount > 1) {
            return { ok: false, reason: `duplicate opening token ${openKey}` };
          }
          openCounts.set(openKey, nextCount);
          stack.push(openKey);
        } else {
          const nextCount = (closeCounts.get(openKey) || 0) + 1;
          if (nextCount > 1) {
            return { ok: false, reason: `duplicate closing token [[/${type}${id}]]` };
          }
          if (stack.length === 0 || stack[stack.length - 1] !== openKey) {
            return { ok: false, reason: `mismatched or misnested closing token [[/${type}${id}]]` };
          }
          stack.pop();
          closeCounts.set(openKey, nextCount);
        }
      }
    }

    if (stack.length > 0) {
      return { ok: false, reason: `unclosed token ${stack[stack.length - 1]}` };
    }

    for (const [key, count] of atomicCounts.entries()) {
      if (count !== 1) {
        return { ok: false, reason: `missing atomic token ${key}` };
      }
    }
    for (const [key, count] of openCounts.entries()) {
      if (count !== 1 || closeCounts.get(key) !== 1) {
        return { ok: false, reason: `missing paired token ${key}` };
      }
    }

    return { ok: true, reason: '' };
  }

  let cloneIdSeq = 0;

  function stripDuplicateIds(node, deep) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    if (deep && node.querySelector('svg [id], svg[id]')) {
      // SVG paints reference ids (url(#grad), <use href="#icon">). Rename them inside the clone and
      // rewrite the references, so the clone does not point at definitions in the hidden original.
      const suffix = `-kct${++cloneIdSeq}`;
      const renamed = new Map();
      for (const desc of node.querySelectorAll('svg [id], svg[id]')) {
        const id = desc.getAttribute('id');
        renamed.set(id, id + suffix);
        desc.setAttribute('id', id + suffix);
      }
      const rewrite = (value) => value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (m, q, id) => (renamed.has(id) ? `url(#${renamed.get(id)})` : m));
      for (const el of node.querySelectorAll('svg *, svg')) {
        for (const attr of Array.from(el.attributes)) {
          if ((attr.name === 'href' || attr.name === 'xlink:href') && attr.value.startsWith('#') && renamed.has(attr.value.slice(1))) {
            el.setAttribute(attr.name, '#' + renamed.get(attr.value.slice(1)));
          } else if (attr.value.includes('url(#')) {
            el.setAttribute(attr.name, rewrite(attr.value));
          }
        }
      }
    }
    if (node.hasAttribute('id')) node.removeAttribute('id');
    if (deep) {
      for (const desc of node.querySelectorAll('[id]')) {
        if (desc.closest('svg')) continue;
        desc.removeAttribute('id');
      }
    }
  }

  const ATOMIC_BOX_SELECTOR = 'img, picture, svg, video, canvas, iframe, object, embed, input, select, textarea, button, progress, meter';
  const LAZY_SRC_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy'];

  // Mark the clone's kind (bilingual mode hides media/box copies, since the original is visible
  // there too) and give lazy-loaded images their real source (the hidden original never loads).
  function prepareAtomicClone(clone, origNode, snap) {
    const display = snap?.__display || '';
    const isBox = clone.matches(ATOMIC_BOX_SELECTOR) || Boolean(clone.querySelector(ATOMIC_BOX_SELECTOR)) ||
      (display && !display.startsWith('inline') && display !== 'contents');
    clone.setAttribute('data-kct-atomic', isBox ? 'box' : 'inline');
    const imgs = clone.matches('img') ? [clone] : Array.from(clone.querySelectorAll('img'));
    const origImgs = origNode.matches('img') ? [origNode] : Array.from(origNode.querySelectorAll('img'));
    imgs.forEach((img, i) => {
      const orig = origImgs[i];
      const live = orig && orig.complete && orig.naturalWidth > 0 ? orig.currentSrc || orig.src : '';
      const lazy = LAZY_SRC_ATTRS.map((a) => img.getAttribute(a)).find(Boolean);
      if (live) img.setAttribute('src', live);
      else if (lazy) img.setAttribute('src', lazy);
      if (img.getAttribute('loading') === 'lazy') img.removeAttribute('loading');
      if (live || lazy) img.removeAttribute('srcset');
    });
  }

  function appendTextWithBreaks(parent, str) {
    if (!str) return;
    const lines = str.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        parent.appendChild(document.createElement('br'));
      }
      if (lines[i]) {
        parent.appendChild(document.createTextNode(lines[i]));
      }
    }
  }

  function buildTranslatedFragment(zhText, placeholders) {
    const frag = document.createDocumentFragment();
    const map = placeholders instanceof Map ? placeholders : null;
    const stack = [{ key: null, node: frag }];
    const tokens = String(zhText || '').split(TOKEN_SPLIT_RE);

    for (const part of tokens) {
      if (!part) continue;
      const m = part.match(TOKEN_MATCH_RE);
      if (m) {
        const isClose = m[1] === '/';
        const type = m[2];
        const id = m[3];
        const openKey = `[[${type}${id}]]`;
        const currentParent = stack[stack.length - 1].node;

        if (!map || !map.has(openKey)) {
          continue;
        }

        if (type === 'C' || type === 'M' || type === 'L') {
          if (isClose) continue;
          const origNode = map.get(openKey);
          if (origNode) {
            const clone = origNode.cloneNode(true);
            stripDuplicateIds(clone, true);
            prepareAtomicClone(clone, origNode, map.styleSnapshots?.get(origNode));
            currentParent.appendChild(clone);
            if (map.clonePairs) map.clonePairs.push([clone, origNode]);
          }
          continue;
        }

        if (!isClose) {
          const origNode = map.get(openKey);
          if (origNode) {
            const clone = origNode.cloneNode(false);
            stripDuplicateIds(clone, false);
            if (map.clonePairs) map.clonePairs.push([clone, origNode]);
            // A paired tag is rebuilt around translated prose; never let a flex/grid original turn
            // the translated text runs into separate layout cells (block originals keep their box).
            try {
              // The original is already inside the detached .kct-orig-wrap here, so use the display
              // recorded at extraction time.
              const d = map.styleSnapshots?.get(origNode)?.__display || '';
              if (/flex|grid/.test(d)) clone.style.display = 'inline';
            } catch (_) { /* ignore */ }
            currentParent.appendChild(clone);
            stack.push({ key: openKey, node: clone });
          }
          continue;
        } else {
          if (stack.length > 1 && stack[stack.length - 1].key === openKey) {
            stack.pop();
          }
          continue;
        }
      }

      appendTextWithBreaks(stack[stack.length - 1].node, part);
    }

    return frag;
  }

  function needsInlineInjection(el) {
    const tag = el.tagName;
    if (tag === 'TD' || tag === 'TH' || tag === 'A' || tag === 'SPAN' || tag === 'BUTTON') {
      return true;
    }
    const display = getComputedStyle(el).display || '';
    if (display.includes('inline') || display.includes('flex') || display.includes('grid')) return true;
    const parent = el.parentElement;
    if (!parent) return false;
    const parentDisplay = getComputedStyle(parent).display || '';
    return parentDisplay.includes('flex') || parentDisplay.includes('grid');
  }

  function samplePdfImageColors(img, boxStr) {
    if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight || !boxStr) {
      return { bg: '#ffffff', fg: '#1e293b', ready: false };
    }
    const parts = boxStr.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return { bg: '#ffffff', fg: '#1e293b', ready: true };
    }
    const [leftPct, topPct, widthPct, heightPct] = parts;

    try {
      const W = 400;
      const H = 520;
      const srcKey = img.currentSrc || img.src || '';
      if (!img._kctSamplePixels || img._kctSampleSrc !== srcKey) {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, W, H);
        img._kctSamplePixels = ctx.getImageData(0, 0, W, H).data;
        img._kctSampleSrc = srcKey;
      }
      const data = img._kctSamplePixels;
      const x0 = Math.max(0, Math.min(W - 1, Math.floor((leftPct / 100) * W)));
      const y0 = Math.max(0, Math.min(H - 1, Math.floor((topPct / 100) * H)));
      const x1 = Math.max(x0, Math.min(W - 1, Math.ceil(((leftPct + widthPct) / 100) * W)));
      const y1 = Math.max(y0, Math.min(H - 1, Math.ceil(((topPct + heightPct) / 100) * H)));

      const borderRs = [];
      const borderGs = [];
      const borderBs = [];
      const pushPixel = (px, py) => {
        const idx = (py * W + px) * 4;
        if (data[idx + 3] < 128) return;
        borderRs.push(data[idx]);
        borderGs.push(data[idx + 1]);
        borderBs.push(data[idx + 2]);
      };

      for (let x = x0; x <= x1; x += 2) {
        pushPixel(x, y0);
        pushPixel(x, y1);
      }
      for (let y = y0; y <= y1; y += 2) {
        pushPixel(x0, y);
        pushPixel(x1, y);
      }

      if (borderRs.length === 0) {
        return { bg: '#ffffff', fg: '#1e293b', ready: true };
      }
      borderRs.sort((a, b) => a - b);
      borderGs.sort((a, b) => a - b);
      borderBs.sort((a, b) => a - b);
      const mid = Math.floor(borderRs.length / 2);
      const bgR = borderRs[mid];
      const bgG = borderGs[mid];
      const bgB = borderBs[mid];
      const bgLum = 0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB;

      const contrastPixels = [];
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const idx = (y * W + x) * 4;
          if (data[idx + 3] < 128) continue;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const diff = Math.abs(lum - bgLum);
          if (diff >= 40) {
            contrastPixels.push({ r, g, b, lum, diff });
          }
        }
      }

      let fg = bgLum > 140 ? '#1e293b' : '#f8fafc';
      if (contrastPixels.length >= 3) {
        contrastPixels.sort((a, b) => b.diff - a.diff);
        const take = Math.max(2, Math.min(20, Math.ceil(contrastPixels.length * 0.08)));
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        for (let i = 0; i < take; i++) {
          sumR += contrastPixels[i].r;
          sumG += contrastPixels[i].g;
          sumB += contrastPixels[i].b;
        }
        let fgR = Math.round(sumR / take);
        let fgG = Math.round(sumG / take);
        let fgB = Math.round(sumB / take);
        const fgLum = 0.2126 * fgR + 0.7152 * fgG + 0.0722 * fgB;
        // Compensate for anti-aliased raster downsampling so body text stays crisp & readable
        if (bgLum > 160 && fgLum > 95) {
          const darken = fgLum > 135 ? 0.58 : 0.76;
          fgR = Math.round(fgR * darken);
          fgG = Math.round(fgG * darken);
          fgB = Math.round(fgB * darken);
        } else if (bgLum <= 95 && fgLum < 185) {
          fgR = Math.min(255, Math.round(fgR + (255 - fgR) * 0.45));
          fgG = Math.min(255, Math.round(fgG + (255 - fgG) * 0.45));
          fgB = Math.min(255, Math.round(fgB + (255 - fgB) * 0.45));
        }
        fg = `rgb(${fgR}, ${fgG}, ${fgB})`;
      }

      const bg = `rgb(${bgR}, ${bgG}, ${bgB})`;
      return { bg, fg, ready: true };
    } catch (_) {
      return { bg: '#ffffff', fg: '#1e293b', ready: true };
    }
  }

  // ---- Native glyph metrics measured from the rasterised PDF page image ----
  const PDF_LATIN_XHEIGHT_RATIO = 0.53; // x-height / em of typical Latin text faces
  const PDF_CJK_GLYPH_RATIO = 0.88;     // ink height / em of CJK source glyphs
  const PDF_TARGET_EM_SCALE = 0.94;     // CJK glyphs fill more of the em box than Latin, so step down slightly
  const PDF_SIZE_CLUSTER_TOLERANCE = 1.08;
  const PDF_BOLD_STROKE_RATIO = 1.3;

  function parsePdfBox(boxStr) {
    const parts = String(boxStr || '').split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    return { left: parts[0], top: parts[1], width: parts[2], height: parts[3] };
  }

  function readInkGrid(ctx, canvas, img, sx, sy, sw, sh) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    sx = Math.max(0, Math.min(nw - 1, Math.floor(sx)));
    sy = Math.max(0, Math.min(nh - 1, Math.floor(sy)));
    sw = Math.max(1, Math.min(nw - sx, Math.ceil(sw)));
    sh = Math.max(1, Math.min(nh - sy, Math.ceil(sh)));
    canvas.width = sw;
    canvas.height = sh;
    ctx.clearRect(0, 0, sw, sh);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;
    const lums = new Float32Array(sw * sh);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; j < lums.length; i += 4, j += 1) {
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      lums[j] = lum;
      hist[Math.min(255, Math.round(lum))] += 1;
    }
    // Background = dominant luminance (the paper), robust to light-on-dark pages
    let bgLum = 255;
    let bgCount = -1;
    for (let v = 0; v < 256; v++) {
      if (hist[v] > bgCount) {
        bgCount = hist[v];
        bgLum = v;
      }
    }
    return { lums, sw, sh, bgLum };
  }

  function measurePdfBlockGlyphs(ctx, canvas, img, el) {
    const box = parsePdfBox(el.getAttribute('data-kct-pdf-box'));
    if (!box) return null;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const lineHPct = parseFloat(el.getAttribute('data-kct-pdf-line-h')) || box.height;
    const isToc = el.getAttribute('data-kct-pdf-toc') === '1';

    // Only the first line is needed; TOC rows only measure the title area so leader dots don't skew the result
    const widthFrac = isToc ? 0.3 : 1;
    const grid = readInkGrid(
      ctx,
      canvas,
      img,
      (box.left / 100) * nw,
      ((box.top - lineHPct * 0.2) / 100) * nh,
      Math.min((box.width * widthFrac / 100) * nw, 1400),
      (lineHPct * 1.4 / 100) * nh
    );
    const { lums, sw, sh, bgLum } = grid;
    const rowInk = new Uint32Array(sh);
    let runSum = 0;
    let runCount = 0;
    for (let y = 0; y < sh; y++) {
      let run = 0;
      for (let x = 0; x < sw; x++) {
        if (Math.abs(lums[y * sw + x] - bgLum) >= 70) {
          rowInk[y] += 1;
          run += 1;
        } else if (run) {
          runSum += run;
          runCount += 1;
          run = 0;
        }
      }
      if (run) {
        runSum += run;
        runCount += 1;
      }
    }

    let maxRow = 0;
    for (let y = 0; y < sh; y++) if (rowInk[y] > maxRow) maxRow = rowInk[y];
    if (maxRow < 3 || runCount < 6) return null;

    // x-height band = longest contiguous run of densely inked rows
    let best = 0;
    let cur = 0;
    for (let y = 0; y < sh; y++) {
      if (rowInk[y] >= maxRow * 0.4) {
        cur += 1;
        if (cur > best) best = cur;
      } else {
        cur = 0;
      }
    }
    if (best < 4) return null;

    const sourceText = el.getAttribute('data-kct-orig-text') || '';
    const cjk = (sourceText.match(/[\p{Script=Han}\u3040-\u30ff\uac00-\ud7af]/gu) || []).length;
    const glyphRatio = cjk > sourceText.length * 0.3 ? PDF_CJK_GLYPH_RATIO : PDF_LATIN_XHEIGHT_RATIO;

    const result = {
      fsPct: (best / glyphRatio / nh) * 100,
      strokeRatio: (runSum / runCount) / best,
      leader: null
    };

    if (isToc) {
      // Look for leader dots between the title and the page number (55%-85% of the row)
      const gap = readInkGrid(
        ctx,
        canvas,
        img,
        ((box.left + box.width * 0.55) / 100) * nw,
        (box.top / 100) * nh,
        (box.width * 0.3 / 100) * nw,
        (box.height / 100) * nh
      );
      let inkCols = 0;
      for (let x = 0; x < gap.sw; x++) {
        for (let y = 0; y < gap.sh; y++) {
          if (Math.abs(gap.lums[y * gap.sw + x] - gap.bgLum) >= 50) {
            inkCols += 1;
            break;
          }
        }
      }
      result.leader = inkCols >= gap.sw * 0.12 ? 'dots' : 'none';
    }
    return result;
  }

  function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // Measure every merged block of one page together, then snap near-equal sizes to one shared size so
  // sibling rows (TOC entries, body paragraphs) never drift apart just because Drive's text boxes differ.
  function ensurePdfLayerTypography(layer, img) {
    if (!layer || !img || !img.complete || !img.naturalWidth || !img.naturalHeight) return false;
    const blocks = Array.from(layer.querySelectorAll(':scope > p[data-kct-pdf-block="1"]'));
    const key = `${img.currentSrc || img.src}|${img.naturalWidth}x${img.naturalHeight}|${blocks.length}`;
    if (layer._kctTypoKey === key) return true;

    let canvas;
    let ctx;
    try {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    } catch (_) {
      return false;
    }

    const measured = [];
    for (const el of blocks) {
      let m = null;
      try {
        m = measurePdfBlockGlyphs(ctx, canvas, img, el);
      } catch (_) {
        // Tainted or unreadable image: keep the geometric fallback for this layer
        layer._kctTypoKey = key;
        return false;
      }
      if (m) {
        measured.push({ el, ...m });
      } else {
        el.removeAttribute('data-kct-pdf-fs-pct');
        el.removeAttribute('data-kct-pdf-bold');
      }
    }

    // TOC entries always share one size
    const tocItems = measured.filter((m) => m.el.getAttribute('data-kct-pdf-toc') === '1');
    if (tocItems.length > 0) {
      const tocFs = median(tocItems.map((m) => m.fsPct));
      const dotted = tocItems.filter((m) => m.leader === 'dots').length;
      const sharedLeader = dotted * 2 >= tocItems.length ? 'dots' : 'none';
      for (const m of tocItems) {
        m.fsPct = tocFs;
        m.leader = sharedLeader; // one TOC = one leader style, even if a single row's sample was off
      }
    }

    // Cluster remaining sizes: consecutive values within ~8% collapse to their median
    const sorted = [...measured].sort((a, b) => a.fsPct - b.fsPct);
    let cluster = [];
    const flush = () => {
      if (cluster.length === 0) return;
      const shared = median(cluster.map((m) => m.fsPct));
      for (const m of cluster) m.fsPct = shared;
      cluster = [];
    };
    for (const m of sorted) {
      if (cluster.length > 0 && m.fsPct > cluster[0].fsPct * PDF_SIZE_CLUSTER_TOLERANCE) flush();
      cluster.push(m);
    }
    flush();

    const strokeBaseline = median(measured.map((m) => m.strokeRatio));
    for (const m of measured) {
      m.el.setAttribute('data-kct-pdf-fs-pct', m.fsPct.toFixed(4));
      if (strokeBaseline > 0 && m.strokeRatio >= strokeBaseline * PDF_BOLD_STROKE_RATIO) {
        m.el.setAttribute('data-kct-pdf-bold', '1');
      } else {
        m.el.removeAttribute('data-kct-pdf-bold');
      }
      if (m.leader) m.el.setAttribute('data-kct-pdf-toc-leader', m.leader);
    }

    layer._kctTypoKey = key;
    return true;
  }

  function appendPdfTocTail(el) {
    const num = el.getAttribute('data-kct-pdf-toc-num');
    const existing = el.querySelector(':scope > [data-kct-ui="toc"]');
    if (existing) existing.remove();
    if (!num) return;
    const tail = document.createElement('span');
    tail.className = 'kct-pdf-toc-tail';
    tail.setAttribute('data-kct-ui', 'toc');
    tail.setAttribute('translate', 'no');
    const leader = document.createElement('span');
    leader.className = 'kct-pdf-toc-leader';
    leader.setAttribute('aria-hidden', 'true');
    const numEl = document.createElement('span');
    numEl.className = 'kct-pdf-toc-num';
    numEl.textContent = num;
    tail.append(leader, numEl);
    el.appendChild(tail);
  }

  function styleAndFitPdfOverlayBlock(el) {
    if (!el || !el.isConnected || el.getAttribute('data-kct-pdf-block') !== '1') return;
    const layer = el.closest('[data-kct-pdf-layer="1"]');
    const pageContainer = layer?.parentElement || el.parentElement;
    const boxStr = el.getAttribute('data-kct-pdf-box') || '';

    const applyColorsFromImg = () => {
      if (!el.isConnected) return false;
      const img = pageContainer?.querySelector('img');
      const sampled = samplePdfImageColors(img, boxStr);
      el.style.setProperty('--kct-pdf-bg', sampled.bg);
      el.style.setProperty('--kct-pdf-fg', sampled.fg);
      if (!sampled.ready && img) {
        img.addEventListener('load', () => {
          const retry = samplePdfImageColors(img, boxStr);
          if (el.isConnected) {
            el.style.setProperty('--kct-pdf-bg', retry.bg);
            el.style.setProperty('--kct-pdf-fg', retry.fg);
          }
        }, { once: true });
      }
      return sampled.ready;
    };

    if (!applyColorsFromImg()) {
      setTimeout(applyColorsFromImg, 650);
    }

    const rectSource = layer || pageContainer;
    const pageH = rectSource?.getBoundingClientRect?.().height || 1035.5;
    const avgLineHPct = parseFloat(el.getAttribute('data-kct-pdf-line-h')) || 1.8;
    const lineCount = parseInt(el.getAttribute('data-kct-pdf-lines'), 10) || 1;
    const linePx = (avgLineHPct / 100) * pageH;
    const isToc = el.getAttribute('data-kct-pdf-toc') === '1';

    const img = pageContainer?.querySelector('img');
    const measuredReady = ensurePdfLayerTypography(layer, img);
    if (!measuredReady && img && !img.complete && !el._kctFitOnLoad) {
      el._kctFitOnLoad = true;
      img.addEventListener('load', () => {
        el._kctFitOnLoad = false;
        if (el.isConnected && el.hasAttribute('data-kct-has-trans')) styleAndFitPdfOverlayBlock(el);
      }, { once: true });
    }

    let fontSize;
    let lineHeight;
    let fontWeight = '400';
    const fsPct = parseFloat(el.getAttribute('data-kct-pdf-fs-pct'));

    if (Number.isFinite(fsPct) && fsPct > 0) {
      // Native size measured from the page raster
      fontSize = +((fsPct / 100) * pageH * PDF_TARGET_EM_SCALE).toFixed(2);
      fontWeight = el.getAttribute('data-kct-pdf-bold') === '1' ? '600' : '400';
      const pitchPct = parseFloat(el.getAttribute('data-kct-pdf-pitch'));
      if (lineCount > 1 && Number.isFinite(pitchPct) && pitchPct > 0) {
        // Keep the original line pitch so the paragraph occupies the same vertical rhythm
        lineHeight = Math.max(1.3, Math.min(1.9, ((pitchPct / 100) * pageH) / fontSize)).toFixed(2);
      } else {
        lineHeight = '1.3';
      }
    } else if (lineCount === 1 && avgLineHPct >= 2.2) {
      fontSize = Math.round(linePx * 0.80);
      lineHeight = '1.22';
      fontWeight = '600';
    } else if (avgLineHPct >= 2.8) {
      fontSize = Math.round(linePx * 0.74);
      lineHeight = '1.28';
    } else {
      fontSize = Math.round(linePx * 0.78);
      lineHeight = '1.42';
    }

    fontSize = Math.max(9, Math.min(48, fontSize));
    el.style.setProperty('--kct-pdf-fs', `${fontSize}px`);
    el.style.setProperty('--kct-pdf-lh', lineHeight);
    el.style.setProperty('--kct-pdf-fw', fontWeight);

    let fs = fontSize;
    let guard = 0;
    if (isToc) {
      // TOC rows never wrap: only shrink if the translated title cannot fit beside its page number
      const titleEl = el.querySelector(':scope > [data-kct-ui="trans"]');
      while (
        titleEl &&
        guard < 12 &&
        fs > 9.5 &&
        titleEl.scrollWidth > titleEl.clientWidth + 1
      ) {
        fs = Math.max(9.5, +(fs * 0.94).toFixed(2));
        el.style.setProperty('--kct-pdf-fs', `${fs}px`);
        guard += 1;
      }
      return;
    }

    // A single-line source block may overflow its (often too tight) text-layer box vertically,
    // as long as the translation itself still fits on one line; only wrapping should trigger shrinking.
    const targetH = lineCount === 1
      ? Math.max(el.clientHeight, fontSize * parseFloat(lineHeight) + 4)
      : el.clientHeight;
    const targetW = el.clientWidth;
    if (targetH > 8 && targetW > 12) {
      while (
        guard < 16 &&
        fs > 9.5 &&
        (el.scrollHeight > targetH + 3 || el.scrollWidth > targetW + 6)
      ) {
        fs = Math.max(9.5, +(fs - (fs > 18 ? 1.5 : 0.75)).toFixed(2));
        el.style.setProperty('--kct-pdf-fs', `${fs}px`);
        guard += 1;
      }
    }
  }

  // Clones sit in a new DOM position (inside .kct-trans-wrap), where site selectors that depend on
  // the original parent (`.titleline > a`) no longer match. Re-apply the typography recorded at
  // extraction time wherever the clone now renders differently, so translation looks like the original.
  function restoreCloneTypography(placeholders) {
    const pairs = placeholders?.clonePairs;
    const snaps = placeholders?.styleSnapshots;
    if (!pairs || !snaps) return;
    // Read everything first, then write (avoids a style recalculation per property).
    const writes = [];
    for (const [clone, origNode] of pairs) {
      const snap = snaps.get(origNode);
      if (!snap || !snap.__parent || !clone.isConnected || !clone.parentElement) continue;
      let cs = null;
      let ps = null;
      try { cs = getComputedStyle(clone); ps = getComputedStyle(clone.parentElement); } catch (_) { continue; }
      for (const prop of Object.keys(snap)) {
        if (prop.startsWith('__')) continue;
        // Only the element's OWN styling (it differed from its original parent) is restored, and only
        // when the clone lost it (it now matches its new parent).
        if (snap[prop] === snap.__parent[prop]) continue;
        if (prop === 'fontSize') {
          const own = parseFloat(snap.fontSize);
          const par = parseFloat(snap.__parent.fontSize);
          const nowPar = parseFloat(ps.fontSize);
          const now = parseFloat(cs.fontSize);
          if (!own || !par || !nowPar) continue;
          const want = (own / par) * nowPar; // keep the relative size (bilingual mode scales the wrapper)
          if (Math.abs(now - want) > 0.5) writes.push([clone, 'font-size', `${want.toFixed(2)}px`]);
          continue;
        }
        if (cs[prop] === ps[prop] && cs[prop] !== snap[prop]) {
          writes.push([clone, prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), snap[prop]]);
        }
      }
    }
    for (const [clone, prop, value] of writes) clone.style.setProperty(prop, value);
    placeholders.clonePairs = null;
  }


  // Inside a flex/grid host every child node is its own layout item. Mirror the original item
  // structure: atomic clones (icons, code, kept boxes) stay separate items, and each run of translated
  // text + inline tags between them becomes ONE item, so a sentence is never split into cells.
  function groupFlexRuns(transWrap) {
    let run = null;
    for (const node of Array.from(transWrap.childNodes)) {
      const isItem = node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('data-kct-atomic');
      if (isItem) {
        run = null;
        continue;
      }
      if (!run) {
        if (node.nodeType === Node.TEXT_NODE && !node.nodeValue.trim()) continue;
        run = document.createElement('span');
        run.className = 'kct-flex-run';
        transWrap.insertBefore(run, node);
      }
      run.appendChild(node);
    }
  }

  function applyBlockTranslation(job, settings, state) {
    const { el, zh, placeholders, nestedListEl, typo } = job;
    if (!el || !el.isConnected) {
      return 'disconnected';
    }
    if (el.hasAttribute('data-kct-has-trans') || el.querySelector(':scope > [data-kct-ui="trans"]')) {
      if (state?.elementState) state.elementState.set(el, 'done');
      return 'already';
    }

    ensureShadowModeStyle(el);

    const origWrap = document.createElement('span');
    origWrap.className = 'kct-orig-wrap';
    origWrap.setAttribute('data-kct-ui', 'orig');

    // The nested list (or the wrapper that contains it, e.g. a display:contents <div>) stays in place.
    let listAnchor = null;
    if (nestedListEl && el.contains(nestedListEl)) {
      for (const child of el.childNodes) {
        if (child === nestedListEl || (child.nodeType === Node.ELEMENT_NODE && child.contains(nestedListEl))) {
          listAnchor = child;
          break;
        }
      }
    }
    const children = Array.from(el.childNodes);
    for (const child of children) {
      if (listAnchor && child === listAnchor) break;
      origWrap.appendChild(child);
    }

    const normalizedZh = normalizeBracketTokens(zh);
    const validation = validateTranslatedTokens(normalizedZh, placeholders);
    const transWrap = document.createElement('span');
    transWrap.className = 'kct-trans-wrap';
    transWrap.setAttribute('data-kct-ui', 'trans');
    transWrap.setAttribute('translate', 'no');

    if (validation.ok) {
      el.removeAttribute('data-kct-structure-fallback');
      if (placeholders instanceof Map) placeholders.clonePairs = [];
      transWrap.appendChild(buildTranslatedFragment(normalizedZh, placeholders));
    } else {
      console.debug('[NativeRead] structure fallback:', validation.reason);
      el.setAttribute('data-kct-structure-fallback', '1');
      transWrap.appendChild(buildTranslatedFragment(stripAllTokens(normalizedZh), null));
    }

    if (needsInlineInjection(el)) {
      el.setAttribute('data-kct-inline-layout', '1');
    }
    // In replace mode the translation wrapper is display:contents. Inside a flex/grid host that
    // would turn every translated text run and link into its own layout cell, so the wrapper
    // becomes ONE cell there instead.
    try {
      if (/flex|grid/.test(getComputedStyle(el).display || '')) {
        el.setAttribute('data-kct-flex-host', '1');
        groupFlexRuns(transWrap);
      }
    } catch (_) { /* ignore */ }

    const typoInfo = typo || KCTSiteAnalyzer?.probeTypography?.(el) || {
      archetype: 'sans',
      needsLineHeightLift: false,
      origFontFamily: ''
    };

    const archetype = typoInfo.archetype || 'sans';
    el.setAttribute('data-kct-typo', archetype);
    if (typoInfo.needsLineHeightLift) {
      el.setAttribute('data-kct-lh-lift', '1');
    }

    const safeFont = sanitizeFontFamily(typoInfo.origFontFamily);
    if (safeFont) {
      el.style.setProperty('--kct-orig-font', safeFont);
      el.setAttribute('data-kct-has-orig-font', '1');
    } else {
      el.style.removeProperty('--kct-orig-font');
      el.removeAttribute('data-kct-has-orig-font');
    }

    if (listAnchor && listAnchor.parentNode === el) {
      el.insertBefore(origWrap, listAnchor);
      el.insertBefore(transWrap, listAnchor);
    } else {
      el.append(origWrap, transWrap);
    }

    el.setAttribute('data-kct-has-trans', '1');
    restoreCloneTypography(placeholders);
    if (el.getAttribute('data-kct-pdf-block') === '1') {
      if (el.getAttribute('data-kct-pdf-toc') === '1') appendPdfTocTail(el);
      styleAndFitPdfOverlayBlock(el);
    }
    if (state?.elementState) state.elementState.set(el, 'done');
    return 'rendered';
  }

  function nextFrameOrFallback() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimeout(finish, 600);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  async function renderJobsWithRAF(jobs, settings, notebookAdapter, state) {
    if (!jobs || jobs.length === 0) return;
    const MAX_PER_FRAME = 15;

    for (let i = 0; i < jobs.length; i += MAX_PER_FRAME) {
      const slice = jobs.slice(i, i + MAX_PER_FRAME);
      await nextFrameOrFallback();

      for (const job of slice) {
        if (job.epoch !== undefined && state && job.epoch !== state.translationEpoch) {
          continue;
        }
        try {
          if (job.kind === 'comment') {
            const outcome = notebookAdapter.renderCommentTranslation(job, settings, state);
            if (outcome === 'rendered') {
              state.totalTranslated += 1;
            } else {
              state.totalDetected = Math.max(state.totalTranslated, state.totalDetected - 1);
            }
          } else {
            const outcome = applyBlockTranslation(job, settings, state);
            if (outcome === 'rendered') {
              state.totalTranslated += 1;
            } else {
              state.totalDetected = Math.max(state.totalTranslated, state.totalDetected - 1);
            }
          }
        } catch (jobErr) {
          console.warn('[KCT] render job error:', jobErr);
          if (state && !state.lastErrorMsg) {
            state.lastErrorMsg = `渲染錯誤: ${jobErr?.message || jobErr}`;
          }
        }
      }

      if (i + MAX_PER_FRAME < jobs.length && typeof globalThis.scheduler?.yield === 'function') {
        try {
          await globalThis.scheduler.yield();
        } catch (_) {}
      }
    }
  }

  function clearAllInjectedTranslations(state, notebookAdapter) {
    const wrappedHosts = KCTSiteAnalyzer?.queryAllDeep
      ? KCTSiteAnalyzer.queryAllDeep(document.body || document.documentElement, '[data-kct-has-trans="1"]')
      : Array.from(document.querySelectorAll('[data-kct-has-trans="1"]'));

    for (const el of wrappedHosts) {
      const origWrap = el.querySelector(':scope > [data-kct-ui="orig"]');
      const transWrap = el.querySelector(':scope > [data-kct-ui="trans"]');
      if (origWrap) {
        while (origWrap.firstChild) {
          el.insertBefore(origWrap.firstChild, origWrap);
        }
        origWrap.remove();
      }
      if (transWrap) {
        transWrap.remove();
      }
      const tocTail = el.querySelector(':scope > [data-kct-ui="toc"]');
      if (tocTail) tocTail.remove();
      el.removeAttribute('data-kct-has-trans');
      el.removeAttribute('data-kct-structure-fallback');
      el.removeAttribute('data-kct-inline-layout');
      el.removeAttribute('data-kct-flex-host');
      el.removeAttribute('data-kct-typo');
      el.removeAttribute('data-kct-lh-lift');
      el.removeAttribute('data-kct-has-orig-font');
      el.style.removeProperty('--kct-orig-font');
      el.style.removeProperty('--kct-pdf-bg');
      el.style.removeProperty('--kct-pdf-fg');
      el.style.removeProperty('--kct-pdf-fs');
      el.style.removeProperty('--kct-pdf-lh');
      el.style.removeProperty('--kct-pdf-fw');
    }

    if (KCTSiteAnalyzer?.restorePdfOverlayLayers) {
      KCTSiteAnalyzer.restorePdfOverlayLayers(document);
    }

    if (notebookAdapter?.clearNotebookOverlays) {
      notebookAdapter.clearNotebookOverlays(state);
    }

    clearAllImageVisionOverlays();

    if (state) {
      // Reset WeakMap completely so any previously 'queued' or 'observed' blocks can be re-scanned
      state.elementState = new WeakMap();
      state.translationEpoch += 1;
      if (Array.isArray(state.pendingItems)) {
        state.pendingItems.length = 0;
      }
      state.totalDetected = 0;
      state.totalTranslated = 0;
      state.lastErrorMsg = '';
    }
  }

  function refitAllPdfOverlayBlocks() {
    const blocks = document.querySelectorAll('p[data-kct-pdf-block="1"][data-kct-has-trans="1"]');
    for (const el of blocks) {
      styleAndFitPdfOverlayBlock(el);
    }
    refitAllImageVisionOverlays();
  }

  // =========================================================
  // R4: On-Demand Vision Image Overlay Renderer
  // =========================================================
  function fitVisionOverlayBlock(blockEl, role) {
    if (!blockEl || !blockEl.isConnected) return;
    const h = blockEl.clientHeight;
    const w = blockEl.clientWidth;
    if (h < 6 || w < 10) return;

    let fs = role === 'title'
      ? Math.min(24, Math.max(11, Math.round(h * 0.42)))
      : (role === 'badge'
        ? Math.min(15, Math.max(9.5, Math.round(h * 0.62)))
        : Math.min(16, Math.max(10, Math.round(h * 0.34))));

    blockEl.style.fontSize = `${fs}px`;
    let guard = 0;
    while (
      guard < 16 &&
      fs > 8.5 &&
      (blockEl.scrollHeight > h + 3 || blockEl.scrollWidth > w + 4)
    ) {
      fs = Math.max(8.5, +(fs - (fs > 15 ? 1.25 : 0.65)).toFixed(2));
      blockEl.style.fontSize = `${fs}px`;
      guard += 1;
    }
  }

  // Sibling labels of the same role (all card titles, all badges, all body lines) share one size,
  // like the original design; the smallest fitted size is used so every label still fits its box.
  function unifyVisionOverlayRoleSizes(layer) {
    if (!layer) return;
    const byRole = new Map();
    for (const blockEl of layer.querySelectorAll('.kct-img-overlay-block')) {
      const fs = parseFloat(blockEl.style.fontSize);
      if (!Number.isFinite(fs)) continue;
      const role = blockEl.getAttribute('data-kct-role') || 'body';
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push({ blockEl, fs });
    }
    for (const items of byRole.values()) {
      if (items.length < 2) continue;
      const shared = Math.min(...items.map((it) => it.fs));
      for (const it of items) it.blockEl.style.fontSize = `${shared}px`;
    }
  }

  function renderImageVisionOverlay(imgEl, blocks) {
    if (!imgEl || !imgEl.isConnected || !Array.isArray(blocks)) return null;
    const parent = imgEl.parentElement;
    if (!parent) return null;

    // Reuse or wrap inside a dedicated relative host so overlay tracks exact image geometry
    let host = imgEl.closest('.kct-img-overlay-host[data-kct-ui="img-host"]');
    if (!host) {
      host = document.createElement('span');
      host.className = 'kct-img-overlay-host';
      host.setAttribute('data-kct-ui', 'img-host');
      const imgCs = getComputedStyle(imgEl);
      host.style.display = imgCs.display === 'block' ? 'block' : 'inline-block';
      host.style.position = 'relative';
      host.style.maxWidth = '100%';
      parent.insertBefore(host, imgEl);
      host.appendChild(imgEl);
    }

    let layer = host.querySelector(':scope > .kct-img-overlay-layer[data-kct-ui="img-overlay"]');
    if (layer) layer.remove();

    layer = document.createElement('div');
    layer.className = 'kct-img-overlay-layer';
    layer.setAttribute('data-kct-ui', 'img-overlay');
    layer.setAttribute('translate', 'no');

    const syncLayerBounds = () => {
      if (!imgEl.isConnected || !layer.isConnected) return;
      layer.style.left = `${imgEl.offsetLeft}px`;
      layer.style.top = `${imgEl.offsetTop}px`;
      layer.style.width = `${imgEl.clientWidth || imgEl.offsetWidth}px`;
      layer.style.height = `${imgEl.clientHeight || imgEl.offsetHeight}px`;
    };
    syncLayerBounds();

    for (const b of blocks) {
      const item = document.createElement('div');
      item.className = `kct-img-overlay-block kct-img-role-${b.role || 'body'}`;
      item.setAttribute('data-kct-ui', 'img-block');
      item.setAttribute('data-kct-role', b.role || 'body');
      const leftPct = Math.max(0, Math.min(99, b.xmin / 10));
      const topPct = Math.max(0, Math.min(99, b.ymin / 10));
      const widthPct = Math.max(1, Math.min(100 - leftPct, (b.xmax - b.xmin) / 10));
      const heightPct = Math.max(1, Math.min(100 - topPct, (b.ymax - b.ymin) / 10));
      item.style.left = `${leftPct.toFixed(2)}%`;
      item.style.top = `${topPct.toFixed(2)}%`;
      item.style.width = `${widthPct.toFixed(2)}%`;
      item.style.height = `${heightPct.toFixed(2)}%`;
      item.style.setProperty('--kct-img-bg', b.bg || '#ffffff');
      item.style.setProperty('--kct-img-fg', b.fg || '#1e293b');
      // Vision output sometimes inserts spaces between CJK characters; drop them so the label reads naturally
      const labelText = String(b.text || '').replace(/([\p{Script=Han}\u3000-\u303f\uff00-\uffef])\s+(?=[\p{Script=Han}\u3000-\u303f\uff00-\uffef])/gu, '$1');
      item.appendChild(document.createTextNode(labelText));
      layer.appendChild(item);
    }

    host.appendChild(layer);
    imgEl.setAttribute('data-kct-img-translated', '1');
    imgEl.setAttribute('data-kct-img-mode', 'translated');

    requestAnimationFrame(() => {
      syncLayerBounds();
      for (const blockEl of layer.querySelectorAll('.kct-img-overlay-block')) {
        fitVisionOverlayBlock(blockEl, blockEl.getAttribute('data-kct-role') || 'body');
      }
      unifyVisionOverlayRoleSizes(layer);
    });

    return layer;
  }

  function refitAllImageVisionOverlays() {
    const hosts = document.querySelectorAll('.kct-img-overlay-host[data-kct-ui="img-host"]');
    for (const host of hosts) {
      const imgEl = host.querySelector('img');
      const layer = host.querySelector(':scope > .kct-img-overlay-layer[data-kct-ui="img-overlay"]');
      if (!imgEl || !layer) continue;
      layer.style.left = `${imgEl.offsetLeft}px`;
      layer.style.top = `${imgEl.offsetTop}px`;
      layer.style.width = `${imgEl.clientWidth || imgEl.offsetWidth}px`;
      layer.style.height = `${imgEl.clientHeight || imgEl.offsetHeight}px`;
      for (const blockEl of layer.querySelectorAll('.kct-img-overlay-block')) {
        fitVisionOverlayBlock(blockEl, blockEl.getAttribute('data-kct-role') || 'body');
      }
      unifyVisionOverlayRoleSizes(layer);
    }
  }

  function clearAllImageVisionOverlays() {
    const hosts = Array.from(document.querySelectorAll('.kct-img-overlay-host[data-kct-ui="img-host"]'));
    for (const host of hosts) {
      const img = host.querySelector('img');
      if (img && host.parentElement) {
        img.removeAttribute('data-kct-img-translated');
        img.removeAttribute('data-kct-img-mode');
        host.parentElement.insertBefore(img, host);
      }
      host.remove();
    }
  }

  globalThis.KCTRenderer = {
    applyDisplayModeClass,
    applyBlockTranslation,
    renderJobsWithRAF,
    clearAllInjectedTranslations,
    buildTranslatedFragment,
    validateTranslatedTokens,
    stripAllTokens,
    sanitizeFontFamily,
    styleAndFitPdfOverlayBlock,
    refitAllPdfOverlayBlocks,
    renderImageVisionOverlay,
    refitAllImageVisionOverlays,
    clearAllImageVisionOverlays
  };
})();
