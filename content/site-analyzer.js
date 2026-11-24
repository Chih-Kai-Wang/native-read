(() => {
  if (globalThis.KCTSiteAnalyzer) return;

  const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th, figcaption, summary, dt, dd';

  const SKIP_ANCESTOR_SELECTOR = [
    '[data-kct-ui]',
    '[translate="no"]',
    '.notranslate',
    'pre',
    'code',
    'kbd',
    'samp',
    'var',
    'textarea',
    'input',
    'select',
    'option',
    'svg',
    'canvas',
    'script',
    'style',
    'noscript',
    '.CodeMirror',
    '.cm-editor',
    '.monaco-editor',
    '.blob-code',
    '.react-code-lines',
    '.jp-CodeCell .jp-InputArea',
    '.jp-InputPrompt',
    '.jp-CodeMirrorEditor',
    '.jp-OutputArea-prompt',
    '.jp-CodeCell .jp-OutputArea-output',
    '.jp-OutputArea-executeResult',
    '.output_result',
    '.output_subarea',
    '.katex',
    '.MathJax',
    'mjx-container',
    'table.dataframe',
    '.dataframe',
    '.material-icons',
    '.material-icons-outlined',
    '.material-symbols-outlined',
    '.material-symbols-rounded',
    '.google-symbols',
    '.anchor-link',
    '.jp-InternalAnchorLink',
    '[contenteditable]:not([contenteditable="false"])'
  ].join(', ');

  const NAV_EXCLUDE_SELECTOR = [
    'nav',
    'footer',
    'aside',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="complementary"]',
    '[role="contentinfo"]',
    '[role="tablist"]',
    'button'
  ].join(', ');

  const LESSON_CELL_SELECTOR = [
    '.jp-RenderedHTMLCommon',
    '.jp-MarkdownOutput',
    '.rendered_html',
    '.text_cell_render',
    '.markdown-converter__text--rendered'
  ].join(', ');

  const COURSE_CONTAINER_SELECTOR = [
    LESSON_CELL_SELECTOR,
    'main',
    'article',
    '[role="main"]'
  ].join(', ');

  const SEMANTIC_ROOT_SELECTOR = [
    LESSON_CELL_SELECTOR,
    'article',
    'main',
    '[role="main"]',
    '.markdown-body',
    '.rst-content',
    '.wy-nav-content',
    '.md-content',
    '.vp-doc',
    '.theme-doc-markdown',
    '.prose',
    '.post-content',
    '.article-content',
    '.entry-content',
    '#mw-content-text',
    '[itemprop="articleBody"]'
  ].join(', ');

  const INLINE_PROTECT_SELECTOR = 'code, kbd, var, .katex, .MathJax, mjx-container, math, .mwe-math-element, sup.reference';

  const SHADOW_SKIP_SELECTOR = '[data-kct-ui], script, style, svg, pre, code, noscript, template, iframe, .cm-editor, .CodeMirror, .monaco-editor';

  const PROSE_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'DD', 'FIGCAPTION']);

  const LEAF_CANDIDATE_TAGS = new Set(['DIV', 'SPAN', 'A', 'LABEL', 'BUTTON']);

  const CHILD_BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, ul, ol, blockquote, table, td, th, section, article, main, nav, aside, header, footer, form, div, pre, hr, iframe, figure, figcaption, details, summary, dl, dt, dd, fieldset, dialog';

  const LEAF_FORBIDDEN_DESCENDANT_SELECTOR = 'button, input, select, textarea, img, picture, video, audio, canvas, svg, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [contenteditable]:not([contenteditable="false"]), .material-icons, .material-icons-outlined, .material-symbols-outlined, .material-symbols-rounded, .google-symbols';

  const LEAF_UI_CONTROL_SELECTOR = 'button, [role="button"], [role="menu"], [role="menuitem"], [role="tab"], time, [datetime]';

  const PURE_METADATA_REGEX = /^(?:@\w+|\d[\d,.]*\s*(?:k|m|b|views?|likes?|replies?|comments?|points?|hours?|mins?|minutes?|days?|weeks?|months?|years?|ago|entries|teams|votes?)?)$/i;

  const TECH_TITLE_REGEX = /\b(machine learning|deep learning|neural network|llm|transformer|python|pytorch|tensorflow|pandas|scikit|sklearn|kaggle|dataset|algorithm|gradient|xgboost|lightgbm|regression|classification|reinforcement learning|data science|jupyter|notebook|api|sdk|typescript|javascript|kubernetes|docker)\b/i;

  function isTopFrame() {
    try {
      return window === window.top;
    } catch (_) {
      return false;
    }
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden], .sr-only, [aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  function isInsideExcludedChrome(el) {
    if (el.closest(NAV_EXCLUDE_SELECTOR)) return true;
    const hdr = el.closest('header');
    if (hdr) {
      // Allow <article><header><h1>...</h1></header></article> while excluding top site navbars
      const insideContent = Boolean(hdr.closest('article, main, [role="main"]'));
      const isSiteBanner = hdr.getAttribute('role') === 'banner' || Boolean(hdr.querySelector('nav'));
      if (!insideContent || isSiteBanner) return true;
    }
    return false;
  }

  function extractMicroTitle() {
    const docTitle = String(document.title || '').replace(/\s+/g, ' ').trim();
    const h1El = document.querySelector('main h1, article h1, h1');
    const h1Text = h1El ? String(h1El.textContent || '').replace(/\s+/g, ' ').replace(/\s*¶\s*$/, '').trim() : '';

    let combined = docTitle;
    if (h1Text) {
      const probe = h1Text.slice(0, 24).toLowerCase();
      if (!docTitle) {
        combined = h1Text;
      } else if (!docTitle.toLowerCase().includes(probe)) {
        combined = `${h1Text} — ${docTitle}`;
      }
    }
    return combined.slice(0, 120);
  }

  function classifyPage() {
    const host = String(location.hostname || '').toLowerCase();
    const title = extractMicroTitle();
    const hasCodeWidgets = Boolean(
      document.querySelector('pre, .cm-editor, .CodeMirror, .monaco-editor, .jp-Cell')
    );
    const useTechGlossary = Boolean(
      hasCodeWidgets ||
      document.querySelector('.katex, .MathJax, mjx-container, .markdown-body') ||
      TECH_TITLE_REGEX.test(title)
    );

    return {
      pageType: 'universal',
      hasCodeWidgets,
      title,
      host,
      useTechGlossary
    };
  }

  function dedupeTopmost(nodes) {
    return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
  }

  function scoreReadabilityContainer(el) {
    if (!el || !isElementVisible(el)) return { score: 0, textLen: 0, linkRatio: 1 };
    const blocks = el.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, figcaption');
    let textLen = 0;
    let linkLen = 0;
    let pCount = 0;

    for (const b of blocks) {
      if (b.closest('[data-kct-ui], nav, footer, aside, [role="navigation"], [role="banner"], [role="complementary"], pre, code, script, style')) {
        continue;
      }
      const txt = String(b.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt.length < 4) continue;
      textLen += txt.length;
      if (b.tagName === 'P' && txt.length >= 25) pCount += 1;

      const links = b.querySelectorAll('a');
      for (const a of links) {
        linkLen += String(a.textContent || '').replace(/\s+/g, ' ').trim().length;
      }
    }

    // Modern SPA fallback: when semantic containers use div/span instead of <p>
    if (textLen < 30) {
      let sampled = 0;
      const leaves = el.querySelectorAll('div, span');
      for (const node of leaves) {
        if (sampled >= 80) break;
        if (node.querySelector('div, p, li, nav, footer, aside, header')) continue;
        if (node.closest('[data-kct-ui], nav, footer, aside, [role="navigation"], [role="banner"], [role="complementary"], pre, code, script, style, button')) {
          continue;
        }
        const txt = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt.length < 12 || PURE_METADATA_REGEX.test(txt)) continue;
        textLen += txt.length;
        sampled += 1;
        if (node.closest('a')) linkLen += txt.length;
      }
    }

    if (textLen < 30) {
      return { score: textLen * 0.1, textLen, linkRatio: 1 };
    }

    const linkRatio = Math.min(1, linkLen / textLen);
    let score = textLen + pCount * 40;
    if (linkRatio > 0.55) {
      score *= Math.max(0.05, 1 - linkRatio);
    }

    if (
      el.tagName === 'ARTICLE' ||
      el.id === 'mw-content-text' ||
      el.matches('.markdown-body, .rst-content, .post-content, .article-content, .entry-content, .vp-doc, .theme-doc-markdown, [itemprop="articleBody"]')
    ) {
      score *= 1.25;
    }

    return { score, textLen, linkRatio };
  }

  function findContentRoots(scope) {
    if (scope === 'all') {
      return [document.body].filter(Boolean);
    }

    // Generic interactive IDE shell skip: cells live inside the editor's embedded iframe
    if (isTopFrame() && document.querySelector('[data-testid="notebook-editor-render-tid"]')) {
      return [];
    }

    // Dedicated multi-page document viewer containers (e.g. Google Drive PDF Viewer)
    const gdrivePages = Array.from(document.querySelectorAll('.ndfHFb-c4YZDc-cYSp0e-DARUcf'));
    if (gdrivePages.length > 0) {
      return [document.body];
    }
    const gdrivePdfRoot = document.querySelector(
      '.ndfHFb-c4YZDc-cYSp0e-DARUcf-gSKZZ, .ndfHFb-c4YZDc-cYSp0e-s2gQvd'
    );
    if (gdrivePdfRoot && isElementVisible(gdrivePdfRoot)) {
      return [document.body];
    }

    // Dedicated embedded rendered-cell containers (e.g. Jupyter / Notebook outputs)
    const cells = Array.from(document.querySelectorAll(LESSON_CELL_SELECTOR)).filter(
      (node) => isElementVisible(node) && !node.closest('[data-testid="notebook-editor-render-tid"]')
    );
    if (cells.length > 0) {
      const dedupedCells = dedupeTopmost(cells);
      const h1 = document.querySelector('main h1');
      if (h1 && isElementVisible(h1) && !dedupedCells.some((c) => c.contains(h1))) {
        return [h1, ...dedupedCells];
      }
      return dedupedCells;
    }

    // Universal main-content detection via semantic containers + Readability scoring
    const semanticNodes = Array.from(document.querySelectorAll(SEMANTIC_ROOT_SELECTOR)).filter(
      (node) =>
        isElementVisible(node) &&
        !node.closest('[data-kct-ui], [data-testid="notebook-editor-render-tid"], nav, footer, aside, [role="navigation"], [role="complementary"]')
    );

    if (semanticNodes.length > 0) {
      const scored = semanticNodes
        .map((node) => ({ node, ...scoreReadabilityContainer(node) }))
        .filter((item) => item.score >= 30);

      if (scored.length > 0) {
        // Prefer tighter inner semantic containers (e.g. <article> inside <main>) when they capture main content cleanly
        const refined = scored.filter((outer) => {
          const betterInner = scored.some((inner) => (
            inner !== outer &&
            outer.node.contains(inner.node) &&
            inner.textLen >= outer.textLen * 0.65 &&
            inner.linkRatio <= outer.linkRatio + 0.08
          ));
          return !betterInner;
        });

        const maxScore = Math.max(...refined.map((x) => x.score));
        const winners = refined
          .filter((x) => x.score >= Math.max(40, maxScore * 0.25))
          .map((x) => x.node);

        const dedupedWinners = dedupeTopmost(winners);
        if (dedupedWinners.length > 0) {
          const topH1 = document.querySelector('#firstHeading, main h1, article h1, [role="main"] h1');
          if (topH1 && isElementVisible(topH1) && !dedupedWinners.some((w) => w.contains(topH1))) {
            return [topH1, ...dedupedWinners];
          }
          return dedupedWinners;
        }
      }
    }

    // Readability fallback on div/section containers for non-semantic layouts
    if (document.body) {
      const rawCandidates = [];
      const seenParents = new Set();
      const paragraphs = document.querySelectorAll('p, blockquote');
      for (const p of paragraphs) {
        if (p.closest('[data-kct-ui], nav, header, footer, aside, [role="navigation"], [role="banner"], [role="complementary"]')) {
          continue;
        }
        const parent = p.parentElement;
        if (!parent || parent === document.body || seenParents.has(parent)) continue;
        seenParents.add(parent);
        rawCandidates.push(parent);
        if (rawCandidates.length >= 60) break;
      }

      if (rawCandidates.length > 0) {
        const scoredFallback = rawCandidates
          .map((node) => ({ node, ...scoreReadabilityContainer(node) }))
          .filter((x) => x.score >= 120 && x.linkRatio <= 0.55)
          .sort((a, b) => b.score - a.score);

        if (scoredFallback.length > 0) {
          const topScore = scoredFallback[0].score;
          const selected = scoredFallback
            .filter((x) => x.score >= topScore * 0.35)
            .slice(0, 6)
            .map((x) => x.node);
          const deduped = dedupeTopmost(selected);
          if (deduped.length > 0) return deduped;
        }
      }

      return [document.body];
    }

    return [];
  }

  function queryAllDeep(root, selector, depth = 0) {
    const results = [];
    if (!root || depth > 5) return results;

    if (root.nodeType === Node.ELEMENT_NODE) {
      if (root.matches(SHADOW_SKIP_SELECTOR)) return results;
      if (root.matches(selector)) {
        results.push(root);
      }
    }

    try {
      const directMatches = root.querySelectorAll(selector);
      for (const el of directMatches) {
        results.push(el);
      }
    } catch (_) {
      return results;
    }

    if (depth >= 5) return results;

    // Traverse open shadowRoot hosts without entering skipped subtrees
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.matches && node.matches(SHADOW_SKIP_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let current;
    while ((current = walker.nextNode())) {
      if (current.shadowRoot) {
        const nested = queryAllDeep(current.shadowRoot, selector, depth + 1);
        for (const item of nested) {
          results.push(item);
        }
      }
    }

    return results;
  }

  function shouldTranslateText(text, targetLangId = 'zh-TW') {
    const clean = String(text || '').replace(/\[\[\s*\/?[CMLAS]\d+\s*\]\]/g, '').trim();
    if (clean.length < 2) return false;

    // Skip URLs, emails, file paths, and Jupyter cell prompts
    if (/^(?:https?:\/\/|mailto:|ftp:\/\/)\S+$/i.test(clean)) return false;
    if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(clean)) return false;
    if (/^(?:\/[\w.@+-]+){2,}\/?$/.test(clean)) return false;
    if (/^[a-zA-Z]:\\[\w\\.-]+$/.test(clean)) return false;
    if (/^(In|Out)\s*\[\s*\d*\s*\]:?$/i.test(clean)) return false;

    // Skip ASCII single-token code identifiers like train_test_split or model.fit(X, y)
    const isAsciiOnly = /^[\x00-\x7F]+$/.test(clean);
    if (isAsciiOnly) {
      if (clean.length < 3) return false;
      if (!/[a-zA-Z]{2,}/.test(clean)) return false;
      if (!/\s/.test(clean) && /[_().=<>[\]{}:/\\]/.test(clean)) return false;
    }

    const letters = clean.match(/\p{L}/gu) || [];
    if (letters.length < 2) return false;

    const letterTotal = letters.length;
    const hanCount = (clean.match(/\p{Script=Han}/gu) || []).length;
    const kanaCount = (clean.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const hangulCount = (clean.match(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g) || []).length;

    const target = String(targetLangId || 'zh-TW');

    if (target === 'zh-TW' || target === 'zh-CN') {
      // If text has meaningful Hiragana/Katakana, it is Japanese -> DO translate into Chinese
      if (kanaCount / letterTotal >= 0.12) {
        return true;
      }
      const cjkRatio = hanCount / letterTotal;
      if (cjkRatio >= 0.55) {
        // Check if there is still a substantial foreign sentence mixed in (e.g. >= 6 Latin words)
        const latinWords = clean.match(/[a-zA-Z]{2,}/g) || [];
        if (latinWords.length < 6) {
          return false;
        }
      }
    } else if (target === 'ja') {
      const kanaRatio = kanaCount / letterTotal;
      const jpRatio = (hanCount + kanaCount) / letterTotal;
      if (kanaRatio >= 0.15 && jpRatio >= 0.45) {
        return false;
      }
    } else if (target === 'ko') {
      if (hangulCount / letterTotal >= 0.45) {
        return false;
      }
    }

    return true;
  }

  const renderedSerifCache = new Map();
  const KNOWN_SANS_RE = /sans|helvetica|arial|roboto|inter|system-ui|-apple-system|segoe|noto sans|pingfang|droid sans|verdana|tahoma|open sans|lato|montserrat/i;

  function detectRenderedSerif(family) {
    const clean = String(family || '').replace(/^['"]+|['"]+$/g, '').trim();
    if (!clean) return false;
    if (renderedSerifCache.has(clean)) {
      return renderedSerifCache.get(clean);
    }

    let isSerif = false;
    try {
      const safeName = clean.replace(/"/g, '\\"');
      if (document.fonts && document.fonts.check(`16px "${safeName}"`)) {
        const W = 160;
        const H = 180;
        const canvas = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(W, H)
          : document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.clearRect(0, 0, W, H);
          ctx.fillStyle = '#000';
          ctx.textBaseline = 'top';
          ctx.font = `400 120px "${safeName}", monospace`;
          ctx.fillText('I', 20, 20);

          const data = ctx.getImageData(0, 0, W, H).data;
          const rowWidths = [];
          for (let y = 0; y < H; y++) {
            let minX = -1;
            let maxX = -1;
            const rowOffset = y * W * 4;
            for (let x = 0; x < W; x++) {
              if (data[rowOffset + x * 4 + 3] > 32) {
                if (minX === -1) minX = x;
                maxX = x;
              }
            }
            if (minX !== -1) {
              rowWidths.push(maxX - minX + 1);
            }
          }

          const n = rowWidths.length;
          if (n >= 10) {
            const topCount = Math.max(1, Math.ceil(n * 0.1));
            let topWidth = 0;
            for (let i = 0; i < topCount; i++) {
              if (rowWidths[i] > topWidth) topWidth = rowWidths[i];
            }

            const midStart = Math.floor(n * 0.3);
            const midEnd = Math.max(midStart + 1, Math.ceil(n * 0.7));
            const midSlice = rowWidths.slice(midStart, midEnd).sort((a, b) => a - b);
            const midMedian = midSlice[Math.floor(midSlice.length / 2)] || 0;

            if (midMedian > 0 && (topWidth / midMedian) >= 1.8) {
              isSerif = true;
            }
          }
        }
      }
    } catch {
      isSerif = false;
    }

    renderedSerifCache.set(clean, isSerif);
    return isSerif;
  }

  function probeTypography(el) {
    const style = getComputedStyle(el);
    const origFontFamily = style.fontFamily || '';
    const ffLower = origFontFamily.toLowerCase();

    let archetype = 'sans';
    if (/(?:^|[\s,'"])(?:mono|monospace|consolas|menlo|monaco|courier|fira\s*code|jetbrains|sfmono|inconsolata|source\s*code|roboto\s*mono|ibm\s*plex\s*mono)/i.test(ffLower)) {
      archetype = 'mono';
    } else {
      const withoutSans = ffLower.replace(/sans-serif/g, '');
      if (/(?:serif|georgia|times|garamond|palatino|charter|merriweather|newsreader|playfair|libre\s*baskerville|baskerville|cambria|minion|source\s*serif|noto\s*serif|pt\s*serif|lora|eb\s*garamond|crimson|mincho|songti|mingliu|pmingliu|simsun)/i.test(withoutSans)) {
        archetype = 'serif';
      } else {
        const firstFamily = origFontFamily.split(',')[0].replace(/^[\s'"]+|[\s'"]+$/g, '');
        if (firstFamily && !KNOWN_SANS_RE.test(firstFamily) && detectRenderedSerif(firstFamily)) {
          archetype = 'serif';
        }
      }
    }

    let needsLineHeightLift = false;
    if (PROSE_TAGS.has(el.tagName)) {
      const lineClamp = style.webkitLineClamp || style.getPropertyValue('-webkit-line-clamp');
      const isClamped = Boolean(lineClamp && lineClamp !== 'none' && lineClamp !== '0');
      if (!isClamped) {
        const fs = parseFloat(style.fontSize);
        const lh = parseFloat(style.lineHeight);
        if (Number.isFinite(fs) && fs > 0 && Number.isFinite(lh) && (lh / fs) < 1.62) {
          needsLineHeightLift = true;
        }
      }
    }

    return {
      archetype,
      needsLineHeightLift,
      origFontFamily
    };
  }

  const PAIRED_STYLE_TAGS = new Set([
    'B', 'STRONG', 'I', 'EM', 'U', 'MARK', 'S', 'SMALL', 'SUB', 'SUP'
  ]);

  const STYLE_PRESERVE_PROPS = ['fontSize', 'fontWeight', 'fontStyle', 'fontFamily', 'color', 'textDecorationLine', 'textTransform', 'verticalAlign', 'backgroundColor'];

  function needsInlineStylePreserve(node, cs) {
    if (/^H[1-6]$/.test(node.tagName)) return true;
    if (isVisuallyHiddenStyle(cs)) return true;
    const parent = node.parentElement;
    if (!parent) return false;
    let ps = null;
    try { ps = getComputedStyle(parent); } catch (_) { return false; }
    for (const prop of STYLE_PRESERVE_PROPS) {
      if (prop === 'backgroundColor') {
        if (cs.backgroundColor !== ps.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) return true;
        continue;
      }
      if (cs[prop] !== ps[prop]) return true;
    }
    return false;
  }

  // Typography each kept element had in its ORIGINAL position. The renderer re-applies it when the
  // clone lands in a different DOM position where the site's selectors (e.g. `.title > a`) miss.
  const SNAPSHOT_PROPS = ['fontSize', 'fontWeight', 'fontStyle', 'color', 'textDecorationLine', 'letterSpacing', 'textTransform'];

  // snap[prop] = the element's value; snap.__parent[prop] = its original parent's value (to know
  // which properties were the element's OWN styling); snap.__display = its original display.
  function snapshotTypography(node) {
    try {
      const cs = getComputedStyle(node);
      const snap = { __display: cs.display, __parent: null };
      for (const prop of SNAPSHOT_PROPS) snap[prop] = cs[prop];
      if (node.parentElement) {
        const ps = getComputedStyle(node.parentElement);
        snap.__parent = {};
        for (const prop of SNAPSHOT_PROPS) snap.__parent[prop] = ps[prop];
      }
      return snap;
    } catch (_) {
      return null;
    }
  }

  const KEEP_ATOMIC_SELECTOR = 'svg, canvas, textarea, input, select, button, [role="button"], img, picture, video, audio, iframe, object, embed, progress, meter, slot, .anchor-link, .jp-InternalAnchorLink, .material-icons, .material-icons-outlined, .material-symbols-outlined, .material-symbols-rounded, .google-symbols, [aria-hidden="true"], [translate="no"], .notranslate';

  // Rendered = generates visible output. display:contents has no box of its own, so look at children.
  function isRenderedNode(node, cs) {
    let style = cs;
    if (!style) {
      try { style = getComputedStyle(node); } catch (_) { return false; }
    }
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.display === 'contents') {
      for (const child of node.children) {
        if (isRenderedNode(child, null)) return true;
      }
      return /\S/.test(node.textContent || '');
    }
    return node.getClientRects().length > 0;
  }

  const PHRASING_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'KBD', 'LABEL', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR']);

  // Units are extracted once while segmenting; the caller (content.js) reuses that result instead
  // of walking and styling every descendant a second time. Cleared at the start of every scan.
  let segmentationExtractCache = new WeakMap();

  function extractBlockContent(el) {
    const cached = segmentationExtractCache.get(el);
    if (cached) {
      segmentationExtractCache.delete(el);
      return cached;
    }
    return extractBlockContentUncached(el);
  }

  function extractBlockContentUncached(el) {
    const placeholders = new Map();
    const styleSnapshots = new Map();
    placeholders.styleSnapshots = styleSnapshots;
    const remember = (node) => {
      if (!styleSnapshots.has(node)) {
        const snap = snapshotTypography(node);
        if (snap) styleSnapshots.set(node, snap);
      }
    };
    let codeIdx = 0;
    let mathIdx = 0;
    let linkIdx = 0;
    let anchorIdx = 0;
    let styleIdx = 0;
    let nestedListEl = null;

    function walkChildren(parent, insideLiRoot) {
      const buf = [];
      for (const child of parent.childNodes) {
        walk(child, insideLiRoot, buf);
      }
      return buf.join('');
    }

    function keepAtomic(node, out, kind) {
      const token = kind === 'M' ? `[[M${mathIdx++}]]` : kind === 'L' ? `[[L${linkIdx++}]]` : `[[C${codeIdx++}]]`;
      placeholders.set(token, node);
      remember(node);
      out.push(token);
    }

    function pairedTag(node, insideLiRoot, out, kind) {
      const inner = walkChildren(node, insideLiRoot);
      if (!inner.replace(PLACEHOLDER_STRIP_RE, '').trim() && !/\[\[/.test(inner)) {
        // Nothing translatable inside, but it may still be visible (CSS ::before/::after content,
        // a background image, a coloured chip): keep it in place rather than dropping it.
        if (isRenderedNode(node, null)) keepAtomic(node, out, kind === 'A' ? 'L' : 'C');
        else if (inner) out.push(inner);
        return;
      }
      const id = kind === 'A' ? anchorIdx++ : styleIdx++;
      const open = `[[${kind}${id}]]`;
      const close = `[[/${kind}${id}]]`;
      placeholders.set(open, node);
      remember(node);
      out.push(open, inner, close);
    }

    function walk(node, insideLiRoot, out) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        out.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches('[data-kct-ui]')) return;
      if (node.matches('script, style, noscript, template')) return;

      // For <li>, stop before nested <ul>/<ol> so we only translate the parent bullet's own text
      if (insideLiRoot && (node.tagName === 'UL' || node.tagName === 'OL')) {
        if (!nestedListEl) nestedListEl = node;
        return;
      }

      if (node.tagName === 'BR') {
        out.push('\n');
        return;
      }

      let cs = null;
      if (node !== el) {
        try { cs = getComputedStyle(node); } catch (_) { cs = null; }
        // What the reader cannot see is not part of the translation: display:none, hidden, and
        // visually-hidden screen-reader text (checked BEFORE links/emphasis, so a hidden link or
        // label never resurfaces inside the translation where parent-scoped CSS no longer hides it).
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse')) return;
        if (cs && isVisuallyHiddenStyle(cs)) return;
      }

      if (node.matches(INLINE_PROTECT_SELECTOR)) {
        const isMath = node.matches('.katex, .MathJax, mjx-container, math, .mwe-math-element, sup.reference');
        keepAtomic(node, out, isMath ? 'M' : 'C');
        return;
      }

      // Rendered but not translatable (icons, aria-hidden visuals, controls, media, translate="no"):
      // keep it in place as an atomic token. Dropping it would make it vanish, because the original
      // moves into the hidden .kct-orig-wrap.
      const iconFont = node !== el && cs && ICON_FONT_FIRST_RE.test(String(cs.fontFamily || '').split(',')[0]);
      if (node !== el && (iconFont || node.matches(KEEP_ATOMIC_SELECTOR))) {
        if (isRenderedNode(node, cs)) keepAtomic(node, out, 'C');
        return;
      }

      if (node !== el && cs) {
        // A block-level or out-of-flow descendant is not part of this unit's inline flow (the
        // segmenter treats it as its own box or as excluded chrome). Keep it exactly as it is, in
        // place, as an atomic token: never merge its text into this sentence, never drop it.
        const d = cs.display || 'inline';
        let inFlowInline = d.startsWith('inline') || d === 'contents' || d.startsWith('ruby');
        if (!inFlowInline && PHRASING_TAGS.has(node.tagName) && node.parentElement) {
          // A phrasing element (<b>, <span>, <a>…) only computes as block because a flex/grid parent
          // blockified it; in the translation it is part of the sentence (the renderer groups runs).
          try {
            if (/flex|grid/.test(getComputedStyle(node.parentElement).display || '')) inFlowInline = true;
          } catch (_) { /* ignore */ }
        }
        const outOfFlow = cs.position === 'absolute' || cs.position === 'fixed' || (cs.float && cs.float !== 'none');
        // A floated drop cap (<span style="float:left">T</span>he …) is part of the word, not a box.
        const dropCap = outOfFlow && cs.position !== 'absolute' && cs.position !== 'fixed' &&
          node.children.length === 0 && String(node.textContent || '').trim().length <= 2;
        if (dropCap) {
          // Keep the letter in its word for the translation (the drop-cap styling is not carried over).
          for (const child of node.childNodes) walk(child, insideLiRoot, out);
          return;
        }
        if (!inFlowInline || outOfFlow) {
          keepAtomic(node, out, 'C');
          return;
        }
      }

      if (node.tagName === 'A' && node !== el && node.hasAttribute('href')) {
        const aText = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!aText) {
          // Icon-only / image-only link: keep it (clickable) in place.
          if (isRenderedNode(node, cs)) keepAtomic(node, out, 'L');
          return;
        }
        if (!shouldTranslateText(aText)) {
          keepAtomic(node, out, 'L');
          return;
        }
        pairedTag(node, insideLiRoot, out, 'A');
        return;
      }

      if (node !== el && PAIRED_STYLE_TAGS.has(node.tagName)) {
        pairedTag(node, insideLiRoot, out, 'S');
        return;
      }

      // Any inline element that LOOKS different from its parent (an inline <h2>, a styled span, a
      // font change...) is kept as a paired tag, so the translation is rebuilt inside a clone of it.
      if (node !== el && cs && needsInlineStylePreserve(node, cs)) {
        pairedTag(node, insideLiRoot, out, 'S');
        return;
      }

      for (const child of node.childNodes) {
        walk(child, insideLiRoot, out);
      }
    }

    const parts = [];
    const isLi = el.tagName === 'LI';
    for (const child of el.childNodes) {
      walk(child, isLi, parts);
    }

    let text = parts.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (/^H[1-6]$/.test(el.tagName)) {
      text = text.replace(/\s*¶\s*$/g, '').trim();
    }
    return { text, placeholders, nestedListEl };
  }

  // Descend from a block into the single inline chain that holds all of its text (li > a > b),
  // so the translation is rendered INSIDE the original link / emphasis and stays clickable.
  const INLINE_DESCENT_TAGS = new Set([
    'A', 'B', 'STRONG', 'I', 'EM', 'U', 'MARK', 'SMALL',
    'SPAN', 'FONT', 'CITE', 'Q', 'S', 'INS', 'DEL', 'ABBR'
  ]);
  const FORM_CONTROL_SELECTOR = 'input, textarea, select, button, option, optgroup, label, output, meter, progress';

  function resolveInlineHost(block) {
    if (!block || block.nodeType !== Node.ELEMENT_NODE) return block;
    const isStartLi = block.tagName === 'LI';
    let cur = block;

    while (true) {
      let onlyChildEl = null;
      let blocked = false;

      for (const child of cur.childNodes) {
        if (child.nodeType === Node.COMMENT_NODE) continue;
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.nodeValue && child.nodeValue.trim().length > 0) {
            blocked = true;
            break;
          }
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) {
          blocked = true;
          break;
        }
        if (child.matches('[data-kct-ui]')) continue;
        if (isStartLi && (child.tagName === 'UL' || child.tagName === 'OL')) continue;

        if (onlyChildEl) {
          blocked = true;
          break;
        }
        onlyChildEl = child;
      }

      if (blocked || !onlyChildEl) break;
      if (!INLINE_DESCENT_TAGS.has(onlyChildEl.tagName)) break;
      if (onlyChildEl.matches(INLINE_PROTECT_SELECTOR)) break;
      if (onlyChildEl.matches(FORM_CONTROL_SELECTOR)) break;
      // Never descend into a flex/grid container: its children are separate layout cells.
      let childDisplay = '';
      try { childDisplay = getComputedStyle(onlyChildEl).display || ''; } catch (_) { /* ignore */ }
      if (/flex|grid/.test(childDisplay)) break;

      cur = onlyChildEl;
    }

    return cur;
  }

  function parsePctBoxStyle(styleStr) {
    if (!styleStr) return null;
    const get = (k) => {
      const m = styleStr.match(new RegExp(`(?:^|;|\\s)${k}\\s*:\\s*([\\d.]+)%`, 'i'));
      return m ? parseFloat(m[1]) : null;
    };
    const left = get('left');
    const top = get('top');
    const width = get('width');
    const height = get('height');
    if (left === null || top === null || width === null || height === null) return null;
    return { left, top, width, height };
  }

  const PDF_TOC_LINE_REGEX = /^(.*\p{L}.*?)[\s.·•…_\-–—]+(\d{1,4}|[ivxlcdm]{1,7})$/iu;

  // Table-of-contents rows ("Title ........ 12") are single lines whose page numbers share one right edge.
  // Require >= 3 aligned rows on the same page so body lines that merely end in a number are never caught.
  function detectPdfTocEntries(groups) {
    const result = new Map();
    const candidates = [];
    for (const g of groups) {
      if (g.lineCount !== 1) continue;
      const m = g.text.match(PDF_TOC_LINE_REGEX);
      if (!m) continue;
      const title = m[1].replace(/[\s.·•…_]+$/u, '').trim();
      if (title.length < 2) continue;
      candidates.push({ g, title, num: m[2], right: g.left + g.width });
    }
    if (candidates.length < 3) return result;

    const rights = candidates.map((c) => c.right).sort((a, b) => a - b);
    const medianRight = rights[Math.floor(rights.length / 2)];
    const aligned = candidates.filter((c) => Math.abs(c.right - medianRight) <= 1.2);
    if (aligned.length < 3) return result;

    for (const c of aligned) {
      result.set(c.g, { title: c.title, num: c.num });
    }
    return result;
  }

  function preparePdfOverlayLayers(roots) {
    const searchRoots = Array.isArray(roots) && roots.length > 0 ? roots : [document.body];
    const layerSelector = '.ndfHFb-c4YZDc-cYSp0e-DARUcf-Df1ZY-bN97Pc-haAclf';
    const layers = new Set();

    for (const r of searchRoots) {
      if (!r || r.nodeType !== Node.ELEMENT_NODE) continue;
      if (r.matches && r.matches(layerSelector)) layers.add(r);
      const found = r.querySelectorAll ? r.querySelectorAll(layerSelector) : [];
      for (const l of found) layers.add(l);
    }

    for (const layer of layers) {
      layer.setAttribute('data-kct-pdf-layer', '1');
      const ps = Array.from(layer.querySelectorAll('p'));
      if (ps.length === 0) continue;

      if (
        layer.getAttribute('data-kct-pdf-merged-count') === String(ps.length) &&
        layer.querySelector('p[data-kct-pdf-block="1"]')
      ) {
        continue;
      }

      // Skip if any <p> in this layer is already wrapped with active translation spans
      if (layer.querySelector('p[data-kct-has-trans="1"]')) {
        continue;
      }

      const items = [];
      for (const p of ps) {
        if (!p.hasAttribute('data-kct-orig-style')) {
          p.setAttribute('data-kct-orig-style', p.getAttribute('style') || '');
        }
        if (!p.hasAttribute('data-kct-orig-text')) {
          p.setAttribute('data-kct-orig-text', p.textContent || '');
        }
        p.removeAttribute('data-kct-pdf-merged');
        p.removeAttribute('data-kct-pdf-block');

        const origStyle = p.getAttribute('data-kct-orig-style') || '';
        const box = parsePctBoxStyle(origStyle);
        const origText = (p.getAttribute('data-kct-orig-text') || '').replace(/\s+/g, ' ').trim();
        if (!box || !origText) continue;

        items.push({
          el: p,
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          text: origText
        });
      }

      if (items.length === 0) continue;

      items.sort((a, b) => (Math.abs(a.top - b.top) > 0.55 ? a.top - b.top : a.left - b.left));

      const groups = [];
      for (const item of items) {
        let matchedGroup = null;
        for (let gi = groups.length - 1; gi >= 0; gi--) {
          const candidate = groups[gi];
          const prevBottom = candidate.top + candidate.height;
          const vGap = item.top - prevBottom;
          if (vGap > 1.2 * Math.max(candidate.avgLineH, item.height, 1)) {
            continue;
          }
          const hRatio = Math.abs(item.height - candidate.avgLineH) / Math.max(item.height, candidate.avgLineH, 0.1);
          const leftDiff = Math.abs(item.left - candidate.left);
          const isTocLine = /\s+\d{1,3}$/.test(candidate.lastLineText) || /\s+\d{1,3}$/.test(item.text);
          const colEndThreshold = candidate.width > 50 ? 44 : candidate.width * 0.72;
          const prevEndedShort = candidate.lastWidth < colEndThreshold && /[.!?。！？]$/.test(candidate.text);

          if (
            !isTocLine &&
            !prevEndedShort &&
            hRatio <= 0.36 &&
            leftDiff <= 3.6 &&
            vGap >= -0.45 * candidate.avgLineH &&
            vGap <= 0.88 * candidate.avgLineH
          ) {
            matchedGroup = candidate;
            break;
          }
        }

        if (matchedGroup) {
          const prevBottom = matchedGroup.top + matchedGroup.height;
          const newLeft = Math.min(matchedGroup.left, item.left);
          const newRight = Math.max(matchedGroup.left + matchedGroup.width, item.left + item.width);
          const newBottom = Math.max(prevBottom, item.top + item.height);
          matchedGroup.left = newLeft;
          matchedGroup.width = newRight - newLeft;
          matchedGroup.height = newBottom - matchedGroup.top;
          matchedGroup.avgLineH = (matchedGroup.avgLineH * matchedGroup.lineCount + item.height) / (matchedGroup.lineCount + 1);
          matchedGroup.lineCount += 1;
          matchedGroup.lastWidth = item.width;
          matchedGroup.lastLineText = item.text;
          matchedGroup.lastTop = item.top;
          matchedGroup.text = matchedGroup.text.endsWith('-') && /^[a-z]/.test(item.text)
            ? matchedGroup.text.slice(0, -1) + item.text
            : `${matchedGroup.text} ${item.text}`;
          matchedGroup.members.push(item);
          continue;
        }

        groups.push({
          left: item.left,
          top: item.top,
          width: item.width,
          height: item.height,
          avgLineH: item.height,
          lineCount: 1,
          lastWidth: item.width,
          lastLineText: item.text,
          lastTop: item.top,
          text: item.text,
          members: [item]
        });
      }

      const tocEntries = detectPdfTocEntries(groups);

      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        let nearestBelowTop = 98.5;
        for (let oj = 0; oj < groups.length; oj++) {
          if (gi === oj) continue;
          const other = groups[oj];
          if (other.top < g.top + g.height - 0.4) continue;
          const xOverlap = Math.min(g.left + g.width, other.left + other.width) - Math.max(g.left, other.left);
          if (xOverlap > 1.5 && other.top < nearestBelowTop) {
            nearestBelowTop = other.top;
          }
        }
        const safeHeight = Math.max(g.height, Math.min(g.height + g.avgLineH * 0.45, nearestBelowTop - g.top - 0.25));
        const primary = g.members[0].el;
        primary.setAttribute(
          'style',
          `left: ${g.left.toFixed(4)}%; top: ${g.top.toFixed(4)}%; width: ${g.width.toFixed(4)}%; height: ${safeHeight.toFixed(4)}%;`
        );
        primary.setAttribute('data-kct-pdf-block', '1');
        primary.setAttribute('data-kct-pdf-lines', String(g.lineCount));
        primary.setAttribute('data-kct-pdf-line-h', g.avgLineH.toFixed(4));
        primary.setAttribute(
          'data-kct-pdf-box',
          `${g.left.toFixed(3)},${g.top.toFixed(3)},${g.width.toFixed(3)},${g.height.toFixed(3)}`
        );
        const pitch = g.lineCount > 1 ? (g.lastTop - g.top) / (g.lineCount - 1) : 0;
        if (pitch > 0) {
          primary.setAttribute('data-kct-pdf-pitch', pitch.toFixed(4));
        } else {
          primary.removeAttribute('data-kct-pdf-pitch');
        }

        const toc = tocEntries.get(g);
        if (toc) {
          // Translate only the entry title; the page number + dot leader are re-drawn natively by the renderer
          primary.setAttribute('data-kct-pdf-toc', '1');
          primary.setAttribute('data-kct-pdf-toc-num', toc.num);
          primary.textContent = toc.title;
        } else {
          primary.removeAttribute('data-kct-pdf-toc');
          primary.removeAttribute('data-kct-pdf-toc-num');
          primary.textContent = g.text;
        }

        for (let i = 1; i < g.members.length; i++) {
          const absorbed = g.members[i].el;
          absorbed.setAttribute('data-kct-pdf-merged', 'absorbed');
        }
      }

      layer.setAttribute('data-kct-pdf-merged-count', String(ps.length));
      delete layer._kctTypoKey; // blocks changed: re-measure native glyph sizes on next fit
    }
  }

  function restorePdfOverlayLayers(root = document) {
    const layers = root.querySelectorAll ? root.querySelectorAll('[data-kct-pdf-layer="1"]') : [];
    for (const layer of layers) {
      layer.removeAttribute('data-kct-pdf-merged-count');
      const ps = layer.querySelectorAll('p[data-kct-orig-style], p[data-kct-orig-text]');
      for (const p of ps) {
        if (p.hasAttribute('data-kct-orig-style')) {
          p.setAttribute('style', p.getAttribute('data-kct-orig-style') || '');
          p.removeAttribute('data-kct-orig-style');
        }
        if (p.hasAttribute('data-kct-orig-text')) {
          p.textContent = p.getAttribute('data-kct-orig-text') || '';
          p.removeAttribute('data-kct-orig-text');
        }
        p.removeAttribute('data-kct-pdf-block');
        p.removeAttribute('data-kct-pdf-lines');
        p.removeAttribute('data-kct-pdf-line-h');
        p.removeAttribute('data-kct-pdf-box');
        p.removeAttribute('data-kct-pdf-merged');
        p.removeAttribute('data-kct-pdf-pitch');
        p.removeAttribute('data-kct-pdf-toc');
        p.removeAttribute('data-kct-pdf-toc-num');
        p.removeAttribute('data-kct-pdf-typo-key');
        p.removeAttribute('data-kct-pdf-fs-pct');
        p.removeAttribute('data-kct-pdf-bold');
        p.removeAttribute('data-kct-pdf-toc-leader');
        p.style.removeProperty('--kct-pdf-bg');
        p.style.removeProperty('--kct-pdf-fg');
      }
      layer.removeAttribute('data-kct-pdf-layer');
      delete layer._kctTypoKey;
    }
  }

  // A semantic block is only translatable as ONE unit when all of its text flows in a single
  // inline formatting context. Rows built from flex/grid/block cells (e.g. forum list items with
  // title, author, vote count and comment count in separate boxes) are layout containers: merging
  // their cells into one sentence glues unrelated values together and breaks the layout, so they
  // are left to Pass 2, which translates each text cell on its own.
  const COMPOSITE_IGNORE_SELECTOR = 'script, style, noscript, template, svg, math, button, [role="button"], .notranslate, [translate="no"], [aria-hidden="true"], [data-kct-ui], .material-icons, .material-symbols-outlined, .material-symbols-rounded, .google-symbols';
  const COMPOSITE_TEXT_RE = /[\p{L}\p{N}]/u;
  const COMPOSITE_MAX_TEXT_NODES = 400;

  function isCompositeLayoutBlock(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const view = el.ownerDocument?.defaultView || window;
    const displayCache = new Map();
    const displayOf = (node) => {
      if (!displayCache.has(node)) {
        let d = 'inline';
        try { d = view.getComputedStyle(node).display || 'inline'; } catch (_) { /* ignore */ }
        displayCache.set(node, d);
      }
      return displayCache.get(node);
    };
    const isLi = el.tagName === 'LI';
    const boxes = new Set();
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (++seen > COMPOSITE_MAX_TEXT_NODES) break;
      if (!COMPOSITE_TEXT_RE.test(node.nodeValue || '')) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      let box = el;
      let skip = false;
      for (let cur = parent; cur && cur !== el; cur = cur.parentElement) {
        if (cur.matches(COMPOSITE_IGNORE_SELECTOR)) { skip = true; break; }
        if (isLi && (cur.tagName === 'UL' || cur.tagName === 'OL')) { skip = true; break; }
        const d = displayOf(cur);
        if (d === 'none') { skip = true; break; }
        if (box !== el) continue; // nearest box already found; keep scanning only for ignored ancestors
        const parentDisplay = cur.parentElement ? displayOf(cur.parentElement) : '';
        const blockified = /(^|\s)(flex|grid|inline-flex|inline-grid)$/.test(parentDisplay);
        if (blockified || !d.startsWith('inline')) box = cur;
      }
      if (skip) continue;
      boxes.add(box);
      if (boxes.size >= 2) return true;
    }
    return false;
  }

  function shouldSkipBlock(el, scope, elementState) {
    if (!el || !el.isConnected) return true;
    if (el.getAttribute('data-kct-pdf-merged') === 'absorbed') return true;
    if (el.classList && el.classList.contains('ndfHFb-c4YZDc-cYSp0e-DARUcf-Df1ZY-tJHJj')) return true;
    if (elementState && elementState.has(el)) return true;
    if (el.closest(SKIP_ANCESTOR_SELECTOR)) return true;
    if (scope !== 'all' && isInsideExcludedChrome(el)) return true;
    if (!isElementVisible(el)) return true;

    if (el.hasAttribute('data-kct-has-trans') || el.querySelector('[data-kct-ui="trans"]')) return true;

    // Leaf-block check: if element contains child block elements (other than nested ul/ol in li), let child blocks handle it
    const nestedSelector = el.tagName === 'LI'
      ? 'p, h1, h2, h3, h4, h5, h6, blockquote, td, th'
      : 'p, h1, h2, h3, h4, h5, h6, blockquote, td, th, li, dt, dd';
    const childBlock = el.querySelector(nestedSelector);
    if (childBlock && childBlock !== el) {
      return true;
    }

    return false;
  }

  function hasClaimedAncestor(el, claimedSet) {
    let cur = el.parentElement;
    if (!cur && el.getRootNode) {
      const root = el.getRootNode();
      if (root instanceof ShadowRoot) cur = root.host;
    }
    while (cur) {
      if (claimedSet.has(cur)) return true;
      if (cur.parentElement) {
        cur = cur.parentElement;
      } else if (cur.getRootNode) {
        const root = cur.getRootNode();
        cur = root instanceof ShadowRoot ? root.host : null;
      } else {
        cur = null;
      }
    }
    return false;
  }

  function isMeaningfulLeafText(text) {
    const clean = String(text || '')
      .replace(/\[\[\s*\/?[CMLAS]\d+\s*\]\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return false;
    if (PURE_METADATA_REGEX.test(clean)) return false;

    if (clean.length >= 12) return true;
    const asciiWords = clean.match(/[a-zA-Z]{2,}/g) || [];
    if (asciiWords.length >= 3) return true;
    const cjkLetters = clean.match(/[\p{Script=Han}\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/gu) || [];
    if (cjkLetters.length >= 4) return true;

    return false;
  }

  // =========================================================
  // Layout-Model Segmenter (CSS Formatting Contexts)
  // =========================================================

  const SEMANTIC_BLOCK_TAGS = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'P', 'LI', 'BLOCKQUOTE', 'TD', 'TH',
    'FIGCAPTION', 'SUMMARY', 'DT', 'DD'
  ]);

  const HARD_OUT_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED',
    'PRE', 'SAMP',
    'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP', 'OUTPUT', 'METER', 'PROGRESS'
  ]);

  const NAV_OUT_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE']); // buttons are live controls (barriers), not chrome

  const HARD_OUT_ATTR_SELECTOR = [
    '[data-kct-ui]',
    '[hidden]',
    '.sr-only',
    '[aria-hidden="true"]',
    '[translate="no"]',
    '.notranslate',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]'
  ].join(', ');

  const VISIBLE_CONTROL_OUT_SELECTOR = 'button, input, textarea, select, option, optgroup, output, meter, progress, [role="button"], [role="checkbox"], [role="radio"], [role="switch"]';
  const BLOCKING_MEDIA_TAGS = new Set(['IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG']);
  // Media whose state or content cannot survive cloneNode (playback, drawing, embedded documents).
  const LIVE_MEDIA_TAGS = new Set(['VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED']);
  // Interactive controls: a clone would have no listeners/state, so they are never inside a unit.
  const LIVE_CONTROL_SELECTOR = 'button, input, select, textarea, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [contenteditable]:not([contenteditable="false"])';
  const ICON_FONT_FIRST_RE = /(?:material\s*(?:icons|symbols)|google\s*symbols|font\s*awesome|fontawesome|icomoon|ionicons|octicons|codicon|bootstrap-icons|glyphicon)/i;
  const FLEX_OR_GRID_RE = /(?:^|\s)(?:inline-)?(?:flex|grid)(?:\s|$)/;
  const CLIP_RECT_RE = /^rect\(\s*([^,)\s]+)[,\s]+([^,)\s]+)[,\s]+([^,)\s]+)[,\s]+([^,)\s]+)\s*\)$/i;
  const LETTER_RE = /\p{L}/u;
  const PLACEHOLDER_STRIP_RE = /\[\[\s*\/?[CMLAS]\d+\s*\]\]/g;
  const MAX_SUBSTANTIVE_SCAN_NODES = 400;

  let lastSegmentationStats = {
    units: 0,
    mixedSkipped: 0,
    outSkipped: 0,
    ms: 0
  };

  function getLastSegmentationStats() {
    return { ...lastSegmentationStats };
  }

  function isVisuallyHiddenStyle(style) {
    const clip = style.clip;
    if (clip && clip !== 'auto') {
      const m = clip.match(CLIP_RECT_RE);
      if (m) {
        const top = parseFloat(m[1]);
        const right = parseFloat(m[2]);
        const bottom = parseFloat(m[3]);
        const left = parseFloat(m[4]);
        if (
          Number.isFinite(top) && Number.isFinite(right) &&
          Number.isFinite(bottom) && Number.isFinite(left) &&
          ((right - left) <= 1 || (bottom - top) <= 1)
        ) {
          return true;
        }
      }
    }

    const clipPath = style.clipPath;
    if (clipPath && clipPath !== 'none') {
      const insetMatch = clipPath.match(/^inset\(\s*([^)]+)\)/i);
      if (insetMatch) {
        const rawVals = insetMatch[1].split(/\s+round\s+/i)[0].trim().split(/\s+/);
        const pct = (s) => (s && s.endsWith('%') ? parseFloat(s) : null);
        const p0 = pct(rawVals[0]);
        const p1 = rawVals.length > 1 ? pct(rawVals[1]) : p0;
        const p2 = rawVals.length > 2 ? pct(rawVals[2]) : p0;
        const p3 = rawVals.length > 3 ? pct(rawVals[3]) : p1;
        if (
          (p0 !== null && p2 !== null && (p0 + p2) >= 100) ||
          (p1 !== null && p3 !== null && (p1 + p3) >= 100) ||
          (p0 !== null && p0 >= 100) ||
          (p1 !== null && p1 >= 100) ||
          (p2 !== null && p2 >= 100) ||
          (p3 !== null && p3 >= 100)
        ) {
          return true;
        }
      }
    }

    const ov = style.overflow;
    const ovHidden = (
      ov === 'hidden' ||
      ov === 'clip' ||
      ((style.overflowX === 'hidden' || style.overflowX === 'clip') &&
        (style.overflowY === 'hidden' || style.overflowY === 'clip'))
    );
    if (ovHidden) {
      const wStr = style.width;
      const hStr = style.height;
      if (wStr && hStr && wStr.endsWith('px') && hStr.endsWith('px')) {
        if (parseFloat(wStr) <= 1 && parseFloat(hStr) <= 1) {
          return true;
        }
      }
    }

    return false;
  }

  function isExcludedChromeElement(el) {
    // Controls are not chrome to skip silently: they must act as barriers so no unit swallows them.
    if (el.matches(LIVE_CONTROL_SELECTOR)) return false;
    if (NAV_OUT_TAGS.has(el.tagName)) return true;
    if (el.matches(NAV_EXCLUDE_SELECTOR)) return true;
    if (el.tagName === 'HEADER') {
      const insideContent = Boolean(el.closest('article, main, [role="main"]'));
      const isSiteBanner = el.getAttribute('role') === 'banner' || Boolean(el.querySelector('nav'));
      if (!insideContent || isSiteBanner) return true;
    }
    return false;
  }

  function getLayoutInfo(el, cache) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return { role: 'OUT', walkableOut: false, atomicInline: false, display: 'none', style: null, hardReason: 'non-element' };
    }
    if (cache && cache.has(el)) {
      return cache.get(el);
    }

    const store = (info) => {
      if (cache) cache.set(el, info);
      return info;
    };

    // PDF absorbed / overlay chrome
    if (
      el.getAttribute('data-kct-pdf-merged') === 'absorbed' ||
      (el.classList && el.classList.contains('ndfHFb-c4YZDc-cYSp0e-DARUcf-Df1ZY-tJHJj'))
    ) {
      return store({ role: 'OUT', walkableOut: false, atomicInline: false, display: 'none', style: null, hardReason: 'pdf' });
    }

    // Fast O(1) tag and attribute checks before getComputedStyle
    const tag = el.tagName;
    if (HARD_OUT_TAGS.has(tag)) {
      const isControl = (
        tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        tag === 'OPTION' || tag === 'OPTGROUP' || tag === 'OUTPUT' || tag === 'METER' || tag === 'PROGRESS'
      );
      const isMedia = BLOCKING_MEDIA_TAGS.has(tag);
      return store({
        role: 'OUT',
        walkableOut: false,
        atomicInline: false,
        display: 'none',
        style: null,
        hardReason: isControl ? 'control' : (isMedia ? 'media' : 'tag')
      });
    }

    if (el.matches(HARD_OUT_ATTR_SELECTOR)) {
      const isControl = el.matches('[role="button"], [role="checkbox"], [role="radio"], [role="switch"]');
      return store({
        role: 'OUT',
        walkableOut: false,
        atomicInline: false,
        display: 'none',
        style: null,
        hardReason: isControl ? 'control' : 'attr'
      });
    }

    const view = el.ownerDocument?.defaultView || window;
    const readStyle = () => {
      try {
        return view.getComputedStyle(el);
      } catch (_) {
        return null;
      }
    };

    // Atomic inline-protect elements (code, kbd, var, math, .katex, mjx-container, .mwe-math-element, sup.reference)
    // remain atomic INLINE leaves regardless of their inner/outer display (e.g. display: block math).
    if (el.matches(INLINE_PROTECT_SELECTOR)) {
      if (tag === 'CODE' && el.parentElement && el.parentElement.tagName === 'PRE') {
        return store({ role: 'OUT', walkableOut: false, atomicInline: false, display: 'none', style: null, hardReason: 'skip' });
      }
      const style = readStyle();
      const display = style?.display || 'inline';
      if (
        !style ||
        display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        isVisuallyHiddenStyle(style)
      ) {
        return store({ role: 'OUT', walkableOut: false, atomicInline: false, display, style, hardReason: 'hidden' });
      }
      return store({ role: 'INLINE', walkableOut: false, atomicInline: true, display, style, hardReason: null });
    }

    if (el.matches(SKIP_ANCESTOR_SELECTOR)) {
      return store({ role: 'OUT', walkableOut: false, atomicInline: false, display: 'none', style: null, hardReason: 'skip' });
    }

    const style = readStyle();
    if (!style) {
      return store({ role: 'OUT', walkableOut: false, atomicInline: false, display: 'none', style: null, hardReason: 'hidden' });
    }

    const display = style.display || 'inline';
    if (display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return store({ role: 'OUT', walkableOut: false, atomicInline: false, display, style, hardReason: 'hidden' });
    }

    if (isVisuallyHiddenStyle(style)) {
      return store({ role: 'OUT', walkableOut: false, atomicInline: false, display, style, hardReason: 'visually-hidden' });
    }

    if (style.fontFamily) {
      const firstFamily = style.fontFamily.split(',')[0];
      if (firstFamily && ICON_FONT_FIRST_RE.test(firstFamily)) {
        return store({ role: 'OUT', walkableOut: false, atomicInline: false, display, style, hardReason: 'icon-font' });
      }
    }

    if (display === 'contents') {
      return store({ role: 'CONTENTS', walkableOut: false, atomicInline: false, display, style, hardReason: null });
    }

    const pos = style.position;
    const flt = style.float || style.cssFloat || 'none';
    if (pos === 'absolute' || pos === 'fixed' || (flt && flt !== 'none')) {
      // Off-screen absolute/fixed screen-reader elements (left/top <= -5000px) are never walkable prose
      if (pos === 'absolute' || pos === 'fixed') {
        const lStr = style.left;
        const tStr = style.top;
        if (
          (lStr && lStr.endsWith('px') && parseFloat(lStr) <= -5000) ||
          (tStr && tStr.endsWith('px') && parseFloat(tStr) <= -5000)
        ) {
          return store({ role: 'OUT', walkableOut: false, atomicInline: false, display, style, hardReason: 'visually-hidden' });
        }
      }
      return store({ role: 'OUT', walkableOut: true, atomicInline: false, display, style, hardReason: null });
    }

    // Determine effective parent display (skipping transparent display: contents ancestors, crossing ShadowRoot host)
    let parentDisplay = '';
    let parentEl = el.parentElement;
    if (!parentEl && el.getRootNode) {
      const rootNode = el.getRootNode();
      if (rootNode instanceof ShadowRoot && rootNode.host) {
        parentEl = rootNode.host;
      }
    }
    while (parentEl && parentEl.nodeType === Node.ELEMENT_NODE) {
      const pInfo = getLayoutInfo(parentEl, cache);
      if (pInfo.role !== 'CONTENTS') {
        parentDisplay = pInfo.display || '';
        break;
      }
      parentEl = parentEl.parentElement;
    }

    const blockified = FLEX_OR_GRID_RE.test(parentDisplay);
    const isInlineDisplay = (
      display === 'inline' ||
      display.startsWith('inline-') ||
      display.startsWith('inline ') ||
      display === 'ruby' ||
      display.startsWith('ruby-') ||
      display === 'math'
    );

    const role = (blockified || !isInlineDisplay) ? 'BOX' : 'INLINE';
    return store({ role, walkableOut: false, atomicInline: false, display, style, hardReason: null });
  }

  function classifyLayoutRole(el, cache) {
    const map = cache instanceof Map ? cache : new Map();
    return getLayoutInfo(el, map).role;
  }

  function isUiControlHost(host) {
    if (!host || host.nodeType !== Node.ELEMENT_NODE) return false;
    if (host.closest(LEAF_UI_CONTROL_SELECTOR)) return true;
    if (host.querySelector('time, [datetime]')) {
      let otherText = 0;
      for (const cn of host.childNodes) {
        if (cn.nodeType === Node.TEXT_NODE) {
          otherText += cn.nodeValue.trim().length;
        } else if (cn.nodeType === Node.ELEMENT_NODE && !cn.matches('time, [datetime], [data-kct-ui]')) {
          otherText += (cn.textContent || '').trim().length;
        }
      }
      if (otherText < 4) return true;
    }
    return false;
  }

  function isPdfLenientUnit(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.hasAttribute('data-kct-pdf-block')) return true;
    return Boolean(el.closest && el.closest('.textLayer'));
  }

  function hasVisibleControlStyle(el, styleCache) {
    if (el.matches('[hidden], .sr-only, [aria-hidden="true"], [data-kct-ui]')) return false;
    const cached = styleCache.get(el);
    if (cached && cached.style) {
      return cached.style.display !== 'none' && cached.style.visibility !== 'hidden';
    }
    try {
      const view = el.ownerDocument?.defaultView || window;
      const st = view.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && !isVisuallyHiddenStyle(st);
    } catch (_) {
      return false;
    }
  }

  // Returns true iff a BOX child contains visible non-OUT, non-protect alphanumeric text
  // or a visible interactive control (so claiming the parent would merge cells or destroy UI).
  function isSubstantiveBox(boxEl, styleCache, scope) {
    let seen = 0;
    const stack = [boxEl];
    while (stack.length > 0 && seen < MAX_SUBSTANTIVE_SCAN_NODES) {
      const node = stack.pop();
      if (!node) continue;
      seen += 1;

      if (node.nodeType === Node.TEXT_NODE) {
        if (COMPOSITE_TEXT_RE.test(node.nodeValue || '')) {
          return true;
        }
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      // Already translated content counts as substantive, so a rescan never claims its parent.
      if (node.hasAttribute('data-kct-has-trans')) return true;
      // Live content that a clone cannot reproduce (playback, drawing, embedded documents, custom
      // elements with their own shadow tree) must never be swallowed into a parent unit.
      if (node !== boxEl && (LIVE_MEDIA_TAGS.has(node.tagName) || node.shadowRoot || node.matches(LIVE_CONTROL_SELECTOR)) && hasVisibleControlStyle(node, styleCache)) return true;

      if (node !== boxEl) {
        if (scope !== 'all' && isExcludedChromeElement(node)) continue;
        const info = getLayoutInfo(node, styleCache);
        if (info.atomicInline) continue;
        if (info.role === 'OUT') {
          if (info.hardReason === 'control' && hasVisibleControlStyle(node, styleCache)) {
            return true;
          }
          continue;
        }
      }

      if (node.tagName === 'SLOT' && node.assignedNodes && node.assignedNodes().length > 0) {
        continue;
      }

      const children = node.childNodes;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
    // Scan budget exhausted on a large subtree: assume it matters rather than cloning it whole.
    return stack.length > 0;
  }

  function collectTranslationUnits(roots, scope, elementState) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const stats = { units: 0, mixedSkipped: 0, outSkipped: 0, ms: 0 };

    if (!Array.isArray(roots) || roots.length === 0) {
      lastSegmentationStats = stats;
      return [];
    }

    preparePdfOverlayLayers(roots);
    segmentationExtractCache = new WeakMap();

    const styleCache = new Map();
    const visited = new Set();
    const claimedSet = new Set();
    const results = [];

    const tryClaimUnit = (candidateEl, isSemantic) => {
      if (!candidateEl || !candidateEl.isConnected) return false;
      if (candidateEl.shadowRoot) return false;
      if (elementState && elementState.has(candidateEl)) return false;
      if (candidateEl.hasAttribute('data-kct-has-trans')) return false;

      const host = resolveInlineHost(candidateEl);
      if (!host || !host.isConnected || host.shadowRoot) return false;
      if (claimedSet.has(host)) return false;
      if (elementState && elementState.has(host)) return false;
      if (host.hasAttribute('data-kct-has-trans')) return false;
      if (host.querySelector(':scope > [data-kct-ui="trans"]')) return false;

      const lenient = isSemantic || isPdfLenientUnit(host);
      if (scope !== 'all' && !lenient && isUiControlHost(host)) {
        return false;
      }

      const extracted = extractBlockContentUncached(host);
      const { text } = extracted;
      if (lenient) {
        const clean = String(text || '').replace(PLACEHOLDER_STRIP_RE, '').replace(/\s+/g, ' ').trim();
        if (!clean || !LETTER_RE.test(clean)) return false;
      } else {
        if (!isMeaningfulLeafText(text)) return false;
      }

      segmentationExtractCache.set(host, extracted);
      claimedSet.add(host);
      if (host !== candidateEl) {
        let cur = host.parentElement;
        while (cur && cur !== candidateEl) {
          claimedSet.add(cur);
          cur = cur.parentElement;
        }
      }
      results.push(host);
      stats.units += 1;
      return true;
    };

    const scanInlineSubtree = (rootInline, insideLiRoot) => {
      const sub = {
        ifcText: '',
        nonLinkTextLen: 0,
        links: [],
        innerBoxes: [],
        innerNestedLists: [],
        innerWalkableOuts: [],
        hasClaimedDescendant: false,
        hasForbiddenControl: false,
        hasLiveControl: false
      };

      const walkInline = (node, insideLink) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const val = node.nodeValue || '';
          if (val) {
            sub.ifcText += val;
            if (!insideLink) {
              sub.nonLinkTextLen += val.trim().length;
            }
          }
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        if (elementState && elementState.has(node)) {
          sub.hasClaimedDescendant = true;
        }
        if (node.hasAttribute('data-kct-has-trans')) {
          sub.hasClaimedDescendant = true;
        }

        if (node !== rootInline) {
          if (scope !== 'all' && isExcludedChromeElement(node)) {
            stats.outSkipped += 1;
            return;
          }
          const info = getLayoutInfo(node, styleCache);
          if (info.role === 'OUT') {
            if (info.walkableOut) {
              sub.innerWalkableOuts.push(node);
            } else {
              stats.outSkipped += 1;
              const live = info.hardReason === 'control' || LIVE_MEDIA_TAGS.has(node.tagName) || node.matches(LIVE_CONTROL_SELECTOR);
              if (
                (live || info.hardReason === 'media') &&
                hasVisibleControlStyle(node, styleCache)
              ) {
                sub.hasForbiddenControl = true;
                if (live) sub.hasLiveControl = true;
              }
            }
            return;
          }
          if (info.role === 'BOX') {
            if (insideLiRoot && (node.tagName === 'UL' || node.tagName === 'OL')) {
              sub.innerNestedLists.push(node);
            } else {
              sub.innerBoxes.push(node);
            }
            return;
          }
          if (info.atomicInline) {
            return;
          }
          if (BLOCKING_MEDIA_TAGS.has(node.tagName)) {
            sub.hasForbiddenControl = true;
            return;
          }
          if (node.shadowRoot) {
            sub.innerBoxes.push(node);
            return;
          }
        }

        if (node.tagName === 'SLOT' && node.assignedNodes && node.assignedNodes().length > 0) {
          sub.hasForbiddenControl = true;
          sub.hasLiveControl = true;
          return;
        }

        let nextInsideLink = insideLink;
        if (node.tagName === 'A' && node.hasAttribute('href') && !insideLink) {
          sub.links.push(node);
          nextInsideLink = true;
        }

        for (const child of node.childNodes) {
          walkInline(child, nextInsideLink);
        }
      };

      walkInline(rootInline, false);
      return sub;
    };

    const walkShadowRoot = (shadowRoot, shadowDepth) => {
      if (!shadowRoot || shadowDepth > 5) return;
      for (const child of shadowRoot.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (scope !== 'all' && isExcludedChromeElement(child)) {
          stats.outSkipped += 1;
          continue;
        }
        const info = getLayoutInfo(child, styleCache);
        if (info.role === 'OUT' && !info.walkableOut) {
          stats.outSkipped += 1;
          continue;
        }
        visitContainer(child, shadowDepth);
      }
    };

    const visitContainer = (el, shadowDepth) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.isConnected) return;
      if (visited.has(el)) return;
      visited.add(el);

      const isLi = el.tagName === 'LI';
      const isAlreadyClaimed = (
        claimedSet.has(el) ||
        (elementState && elementState.has(el)) ||
        el.hasAttribute('data-kct-has-trans') ||
        Boolean(el.querySelector(':scope > [data-kct-ui="trans"]'))
      );

      // Shadow host: never claim the host itself; walk its shadow DOM and light DOM children
      if (el.shadowRoot) {
        if (shadowDepth < 5 && !el.matches(SHADOW_SKIP_SELECTOR)) {
          walkShadowRoot(el.shadowRoot, shadowDepth + 1);
        }
        for (const child of el.childNodes) {
          if (child.nodeType !== Node.ELEMENT_NODE) continue;
          if (scope !== 'all' && isExcludedChromeElement(child)) {
            stats.outSkipped += 1;
            continue;
          }
          const cInfo = getLayoutInfo(child, styleCache);
          if (cInfo.role === 'OUT' && !cInfo.walkableOut) {
            stats.outSkipped += 1;
            continue;
          }
          visitContainer(child, shadowDepth);
        }
        return;
      }

      if (isAlreadyClaimed) {
        // Still recurse into nested UL/OL inside an already-translated LI
        if (isLi) {
          for (const child of el.childNodes) {
            if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) {
              visitContainer(child, shadowDepth);
            }
          }
        }
        return;
      }

      const isSemantic = SEMANTIC_BLOCK_TAGS.has(el.tagName);

      // Collect effective children in DOM order, transparently flattening display: contents
      const items = [];
      let ownIfcText = '';
      let ownNonLinkTextLen = 0;
      const ifcLinks = [];
      let hasClaimedInIfc = false;
      let hasForbiddenInIfc = false;
      let hasLiveInIfc = false;

      const collectChildList = (parentNode) => {
        for (const child of parentNode.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const val = child.nodeValue || '';
            if (val.trim().length > 0) {
              ownIfcText += val;
              ownNonLinkTextLen += val.trim().length;
              items.push({ kind: 'TEXT', node: child, text: val });
            }
            continue;
          }
          if (child.nodeType !== Node.ELEMENT_NODE) continue;

          if (child.tagName === 'SLOT' && child.assignedNodes && child.assignedNodes().length > 0) {
            items.push({ kind: 'BARRIER', node: child });
            continue;
          }

          if (scope !== 'all' && isExcludedChromeElement(child)) {
            stats.outSkipped += 1;
            continue;
          }

          const info = getLayoutInfo(child, styleCache);

          if (info.role === 'CONTENTS') {
            if (child.shadowRoot) {
              items.push({ kind: 'BOX', node: child });
            } else {
              collectChildList(child);
            }
            continue;
          }

          if (info.role === 'OUT') {
            if (info.walkableOut) {
              items.push({ kind: 'WALKABLE_OUT', node: child });
            } else {
              stats.outSkipped += 1;
              const live = info.hardReason === 'control' || LIVE_MEDIA_TAGS.has(child.tagName) || child.matches(LIVE_CONTROL_SELECTOR);
              if (
                (live || (!isSemantic && info.hardReason === 'media')) &&
                hasVisibleControlStyle(child, styleCache)
              ) {
                // Live controls/media cannot be cloned into a translation (state, listeners, ids):
                // they split the block even inside semantic tags.
                items.push({ kind: 'BARRIER', node: child });
              }
            }
            continue;
          }

          if (info.role === 'BOX') {
            if (isLi && (child.tagName === 'UL' || child.tagName === 'OL')) {
              items.push({ kind: 'NESTED_LIST', node: child });
            } else {
              items.push({ kind: 'BOX', node: child });
            }
            continue;
          }

          // INLINE
          if (info.atomicInline) {
            items.push({ kind: 'IFC_ATOMIC', node: child });
            continue;
          }

          if (child.tagName === 'BR' || child.tagName === 'WBR') {
            items.push({ kind: 'IFC_BR', node: child });
            continue;
          }

          if (BLOCKING_MEDIA_TAGS.has(child.tagName)) {
            if (!isSemantic) {
              items.push({ kind: 'BARRIER', node: child });
            }
            continue;
          }

          if (child.shadowRoot) {
            items.push({ kind: 'BOX', node: child });
            continue;
          }

          // inline-block / inline-flex / inline-grid / inline-table are atomic inline boxes: inside a
          // sentence they are part of it; a row made only of them (cards, chips) is a row of cells.
          if (/^inline-(block|flex|grid|table)/.test(info.display || '')) {
            const aSub = scanInlineSubtree(child, isLi);
            if (aSub.hasClaimedDescendant) hasClaimedInIfc = true;
            if (aSub.hasForbiddenControl) hasForbiddenInIfc = true;
            if (aSub.hasLiveControl) hasLiveInIfc = true;
            items.push({ kind: 'IFC_EL', node: child, sub: aSub, atomicBox: true });
            continue;
          }

          const sub = scanInlineSubtree(child, isLi);
          if (sub.hasClaimedDescendant) hasClaimedInIfc = true;
          if (sub.hasForbiddenControl) hasForbiddenInIfc = true;
          if (sub.hasLiveControl) hasLiveInIfc = true;

          const hasSubstantiveInnerBox = sub.innerBoxes.some((b) => isSubstantiveBox(b, styleCache, scope));
          if (hasSubstantiveInnerBox) {
            if (sub.ifcText) ownIfcText += sub.ifcText;
            items.push({ kind: 'INLINE_WITH_BOX', node: child, sub });
          } else {
            if (sub.ifcText) ownIfcText += sub.ifcText;
            ownNonLinkTextLen += sub.nonLinkTextLen;
            for (const a of sub.links) ifcLinks.push(a);
            items.push({ kind: 'IFC_EL', node: child, sub });
          }
        }
      };

      collectChildList(el);

      // Resolve atomic inline boxes now that the surrounding text is known.
      const sentenceAround = LETTER_RE.test(ownIfcText);
      for (const item of items) {
        if (!item.atomicBox) continue;
        if (!sentenceAround && LETTER_RE.test(item.sub.ifcText)) {
          item.kind = 'BOX';
        } else {
          if (item.sub.ifcText) ownIfcText += item.sub.ifcText;
          ownNonLinkTextLen += item.sub.nonLinkTextLen;
          for (const a of item.sub.links) ifcLinks.push(a);
        }
      }

      const hasOwnLetters = LETTER_RE.test(ownIfcText);

      // Case 1: Pure layout container (no own IFC letters) -> recurse into child containers in DOM order
      if (!hasOwnLetters) {
        for (const item of items) {
          if (item.kind === 'BOX' || item.kind === 'NESTED_LIST' || item.kind === 'WALKABLE_OUT') {
            visitContainer(item.node, shadowDepth);
          } else if (item.kind === 'INLINE_WITH_BOX') {
            for (const b of item.sub.innerBoxes) visitContainer(b, shadowDepth);
            for (const nl of item.sub.innerNestedLists) visitContainer(nl, shadowDepth);
            for (const wo of item.sub.innerWalkableOuts) visitContainer(wo, shadowDepth);
          } else if (item.kind === 'IFC_EL') {
            for (const nl of item.sub.innerNestedLists) visitContainer(nl, shadowDepth);
            for (const wo of item.sub.innerWalkableOuts) visitContainer(wo, shadowDepth);
          }
        }
        return;
      }

      // Case 2: Container has own IFC text. Determine whether any BOX/BARRIER splits it.
      let hasBlockingChild = false;
      for (const item of items) {
        if (item.kind === 'BOX') {
          item.substantive = isSubstantiveBox(item.node, styleCache, scope);
          if (item.substantive) hasBlockingChild = true;
        } else if (item.kind === 'INLINE_WITH_BOX' || item.kind === 'BARRIER') {
          hasBlockingChild = true;
        }
      }

      // Step 3: Single clean IFC (no text-bearing BOX children, no already-claimed inline descendants)
      if (!hasBlockingChild && !hasClaimedInIfc) {
        // Generic container whose inline descendant contains visible controls/media (e.g. <div><a><img><span>Title</span></a></div>):
        // descend into inline children instead of destroying the control/media.
        if ((!isSemantic && hasForbiddenInIfc) || hasLiveInIfc) {
          for (const item of items) {
            if (item.kind === 'IFC_EL' && item.sub.hasForbiddenControl) {
              visitContainer(item.node, shadowDepth);
            } else if (item.kind === 'IFC_EL' && LETTER_RE.test(item.sub.ifcText)) {
              tryClaimUnit(item.node, false);
            } else if (item.kind === 'TEXT' && LETTER_RE.test(item.text)) {
              stats.mixedSkipped += 1;
            } else if (item.kind === 'NESTED_LIST' || item.kind === 'WALKABLE_OUT') {
              visitContainer(item.node, shadowDepth);
            }
          }
          return;
        }

        // Link-wrapper deferral: a <div>/<span> wrapping links with <4 chars of own non-link text
        // defers to its <a> children (keeps multi-link bars/tags independent & clickable).
        if (
          (el.tagName === 'DIV' || el.tagName === 'SPAN') &&
          ifcLinks.length > 0 &&
          ownNonLinkTextLen < 4
        ) {
          if (ifcLinks.length === 1 && resolveInlineHost(el) === ifcLinks[0]) {
            tryClaimUnit(el, false);
          } else {
            for (const a of ifcLinks) {
              tryClaimUnit(a, false);
            }
          }
        } else {
          tryClaimUnit(el, isSemantic);
        }

        // Step 5 & 7: Always recurse into nested UL/OL inside LI and into walkable OUT boxes (floats/absolute)
        for (const item of items) {
          if (item.kind === 'NESTED_LIST' || item.kind === 'WALKABLE_OUT') {
            visitContainer(item.node, shadowDepth);
          } else if (item.kind === 'IFC_EL') {
            for (const nl of item.sub.innerNestedLists) visitContainer(nl, shadowDepth);
            for (const wo of item.sub.innerWalkableOuts) visitContainer(wo, shadowDepth);
          }
        }
        return;
      }

      // Step 4: Mixed content (own IFC text + substantive BOX / BARRIER children)
      // Split effective child list into maximal IFC runs between split boundaries in DOM order.
      const flushRun = (run) => {
        if (run.length === 0) return;

        const significant = [];
        let runText = '';
        let hasBareText = false;

        for (const it of run) {
          if (it.kind === 'IFC_BR') continue;
          significant.push(it);
          if (it.kind === 'TEXT') {
            runText += it.text;
            if (LETTER_RE.test(it.text)) hasBareText = true;
          } else if (it.kind === 'IFC_EL') {
            runText += it.sub.ifcText;
          }
        }

        if (!LETTER_RE.test(runText)) return;

        if (!hasBareText && significant.length === 1 && significant[0].kind === 'IFC_EL') {
          const loneItem = significant[0];
          if (loneItem.sub.hasClaimedDescendant) {
            visitContainer(loneItem.node, shadowDepth);
          } else if (!isSemantic && loneItem.sub.hasForbiddenControl) {
            visitContainer(loneItem.node, shadowDepth);
          } else {
            tryClaimUnit(loneItem.node, false);
            for (const nl of loneItem.sub.innerNestedLists) visitContainer(nl, shadowDepth);
            for (const wo of loneItem.sub.innerWalkableOuts) visitContainer(wo, shadowDepth);
          }
          return;
        }

        // Run contains bare text nodes (or multiple unwrapped inline siblings): cannot wrap safely.
        stats.mixedSkipped += 1;
        for (const it of significant) {
          if (it.kind === 'IFC_EL') {
            for (const nl of it.sub.innerNestedLists) visitContainer(nl, shadowDepth);
            for (const wo of it.sub.innerWalkableOuts) visitContainer(wo, shadowDepth);
          }
        }
      };

      let currentRun = [];
      for (const item of items) {
        if (
          item.kind === 'TEXT' ||
          item.kind === 'IFC_EL' ||
          item.kind === 'IFC_ATOMIC' ||
          item.kind === 'IFC_BR'
        ) {
          currentRun.push(item);
          continue;
        }

        if (item.kind === 'WALKABLE_OUT') {
          // Out-of-flow boxes do not split the in-flow run, but must be walked independently.
          continue;
        }

        if (item.kind === 'BOX' && !item.substantive) {
          continue;
        }

        // Split boundary: substantive BOX, INLINE_WITH_BOX, BARRIER, or NESTED_LIST
        flushRun(currentRun);
        currentRun = [];

        if (item.kind === 'BOX' || item.kind === 'NESTED_LIST') {
          visitContainer(item.node, shadowDepth);
        } else if (item.kind === 'INLINE_WITH_BOX') {
          if (LETTER_RE.test(item.sub.ifcText)) {
            stats.mixedSkipped += 1;
          }
          for (const b of item.sub.innerBoxes) visitContainer(b, shadowDepth);
          for (const nl of item.sub.innerNestedLists) visitContainer(nl, shadowDepth);
          for (const wo of item.sub.innerWalkableOuts) visitContainer(wo, shadowDepth);
        }
      }
      flushRun(currentRun);

      // Walk any out-of-flow boxes encountered in this mixed container
      for (const item of items) {
        if (item.kind === 'WALKABLE_OUT') {
          visitContainer(item.node, shadowDepth);
        }
      }
    };

    const uniqueRoots = roots.length > 1
      ? dedupeTopmost(roots.filter((r) => r && r.nodeType === Node.ELEMENT_NODE && r.isConnected))
      : roots.filter((r) => r && r.nodeType === Node.ELEMENT_NODE && r.isConnected);

    for (const root of uniqueRoots) {
      if (root.closest && root.closest(SKIP_ANCESTOR_SELECTOR)) continue;
      if (scope !== 'all' && root.closest && isInsideExcludedChrome(root)) continue;
      const rootInfo = getLayoutInfo(root, styleCache);
      if (rootInfo.role === 'OUT' && !rootInfo.walkableOut) {
        stats.outSkipped += 1;
        continue;
      }
      visitContainer(root, 0);
    }

    // A unit never contains another unit: the outer host renders its whole inline content, so an
    // inner host (e.g. a float walked separately) would be moved into the outer's original wrapper.
    let finalUnits = results;
    if (results.length > 1) {
      const hostSet = new Set(results);
      finalUnits = results.filter((u) => {
        let crossedNestedList = false;
        for (let cur = u.parentElement; cur; cur = cur.parentElement) {
          // An LI host only renders its own text up to its nested <ul>/<ol>; units inside that
          // nested list are separate units, not nested ones.
          if ((cur.tagName === 'UL' || cur.tagName === 'OL') && cur.parentElement && cur.parentElement.closest('li')) {
            crossedNestedList = true;
          }
          if (hostSet.has(cur) && !(cur.tagName === 'LI' && crossedNestedList)) {
            stats.nestedDropped = (stats.nestedDropped || 0) + 1;
            return false;
          }
        }
        return true;
      });
    }

    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    stats.ms = Math.round((t1 - t0) * 10) / 10;
    stats.units = finalUnits.length;
    lastSegmentationStats = stats;

    return finalUnits;
  }

  function collectUniversalCandidateElementsLegacy(roots, scope, elementState) {
    if (!Array.isArray(roots) || roots.length === 0) return [];

    preparePdfOverlayLayers(roots);

    const claimedSet = new Set();
    const pass1 = [];
    const pass2 = [];

    // Pass 1: Semantic prose & structure blocks
    for (const root of roots) {
      if (!root) continue;
      const semanticCandidates = queryAllDeep(root, BLOCK_SELECTOR);
      for (const el of semanticCandidates) {
        if (claimedSet.has(el)) continue;
        if (shouldSkipBlock(el, scope, elementState)) continue;

        const host = resolveInlineHost(el);
        if (claimedSet.has(host) || elementState?.has(host)) continue;

        let cur = host;
        while (cur) {
          claimedSet.add(cur);
          if (cur === el) break;
          cur = cur.parentElement;
        }
        claimedSet.add(el);
        pass1.push(host);
      }
    }

    // Pass 2: Universal div / span / a / label leaf text blocks for modern SPAs (ordered cheapest-first)
    const tryClaimLeaf = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      if (!LEAF_CANDIDATE_TAGS.has(el.tagName)) return false;
      if (el.shadowRoot) return false; // Never wrap a Shadow DOM host or its slotted projection breaks
      if (claimedSet.has(el) || hasClaimedAncestor(el, claimedSet)) return false;
      if (elementState && elementState.has(el)) return false;
      if (el.hasAttribute('data-kct-has-trans')) return false;

      const rawText = String(el.textContent || '').trim();
      if (rawText.length < 4) return false;

      if (el.querySelector(CHILD_BLOCK_SELECTOR)) return false;
      if (el.querySelector(LEAF_FORBIDDEN_DESCENDANT_SELECTOR)) return false;
      if (el.querySelector('[data-kct-ui="trans"]')) return false;
      if (el.closest(SKIP_ANCESTOR_SELECTOR)) return false;
      if (scope !== 'all' && (isInsideExcludedChrome(el) || el.closest(LEAF_UI_CONTROL_SELECTOR))) {
        return false;
      }

      // If a <div> or <span> only wraps <a> link(s) with no own substantial text outside links,
      // defer to the <a> element(s) so hyperlinks remain clickable in replace mode
      if ((el.tagName === 'DIV' || el.tagName === 'SPAN') && el.querySelector('a[href]')) {
        let ownTextLen = 0;
        for (const cn of el.childNodes) {
          if (cn.nodeType === Node.TEXT_NODE) {
            ownTextLen += cn.nodeValue.trim().length;
          }
        }
        if (ownTextLen < 4) return false;
      }

      if (!isElementVisible(el)) return false;

      const { text } = extractBlockContent(el);
      if (!isMeaningfulLeafText(text)) return false;

      claimedSet.add(el);
      pass2.push(el);
      return true;
    };

    const walkLeafCandidates = (rootNode, depth = 0) => {
      if (!rootNode || depth > 5) return;

      if (rootNode.nodeType === Node.ELEMENT_NODE) {
        if (
          claimedSet.has(rootNode) ||
          (elementState && elementState.has(rootNode)) ||
          rootNode.matches('[data-kct-ui], [data-kct-has-trans]') ||
          rootNode.matches(SKIP_ANCESTOR_SELECTOR)
        ) {
          return;
        }
        if (tryClaimLeaf(rootNode)) {
          return;
        }
      }

      const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
          if (claimedSet.has(node)) return NodeFilter.FILTER_REJECT;
          if (elementState && elementState.has(node)) return NodeFilter.FILTER_REJECT;
          if (node.matches && (
            node.matches('[data-kct-ui], [data-kct-has-trans]') ||
            node.matches(SKIP_ANCESTOR_SELECTOR)
          )) {
            return NodeFilter.FILTER_REJECT;
          }
          if (scope !== 'all' && node.matches && node.matches(NAV_EXCLUDE_SELECTOR)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      let current;
      while ((current = walker.nextNode())) {
        if (current.shadowRoot && depth < 5) {
          walkLeafCandidates(current.shadowRoot, depth + 1);
        }
        tryClaimLeaf(current);
      }
    };

    for (const root of roots) {
      if (!root) continue;
      walkLeafCandidates(root, 0);
    }

    if (pass2.length === 0) return pass1;
    if (pass1.length === 0) return pass2;

    const combined = [...pass1, ...pass2];
    combined.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return combined;
  }

  function collectUniversalCandidateElements(roots, scope, elementState) {
    return collectTranslationUnits(roots, scope, elementState);
  }

  globalThis.KCTSiteAnalyzer = {
    isCompositeLayoutBlock,
    classifyLayoutRole,
    collectTranslationUnits,
    collectUniversalCandidateElementsLegacy,
    getLastSegmentationStats,
    BLOCK_SELECTOR,
    SKIP_ANCESTOR_SELECTOR,
    NAV_EXCLUDE_SELECTOR,
    LESSON_CELL_SELECTOR,
    COURSE_CONTAINER_SELECTOR,
    INLINE_PROTECT_SELECTOR,
    isTopFrame,
    isElementVisible,
    classifyPage,
    findContentRoots,
    queryAllDeep,
    shouldTranslateText,
    probeTypography,
    extractBlockContent,
    shouldSkipBlock,
    preparePdfOverlayLayers,
    restorePdfOverlayLayers,
    collectUniversalCandidateElements
  };
})();
