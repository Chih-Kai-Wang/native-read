(() => {
  if (globalThis.KCTCodeOverlay) return;

  const { hashText } = globalThis.KCTConfig;
  const { isElementVisible, shouldTranslateText } = globalThis.KCTSiteAnalyzer;

  const STATIC_COMMENT_SELECTOR = [
    'span.c1',
    'span.c',
    'span.cm',
    'span.cs',
    'span.ch',
    'span.token.comment',
    'span.hljs-comment',
    'span.pl-c'
  ].join(', ');

  const PRAGMA_COMMENT_REGEX = /^(?:type:\s*ignore|noqa\b|pylint:|pyright:|mypy:|eslint-|@ts-|prettier-ignore|noinspection|-\*-|coding[:=]|!\/|In\s*\[|Out\s*\[|%%\w+|%%|[-=*#_~]{3,}$)/i;

  function ensureAdapterState(state) {
    if (!state.commentState) state.commentState = new WeakMap();
    if (!state.cmOverlayBySpan) state.cmOverlayBySpan = new WeakMap();
    if (!state.cmSpanByOverlay) state.cmSpanByOverlay = new WeakMap();
    if (!state.commentCacheByBody) state.commentCacheByBody = new Map();
    return state;
  }

  function getTextOffsetInParent(parent, targetNode) {
    let offset = 0;
    const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (targetNode === node || targetNode.contains(node)) {
        return offset;
      }
      offset += node.nodeValue ? node.nodeValue.length : 0;
    }
    return -1;
  }

  function isCommentOffsetInPythonLine(lineText, targetOffset) {
    if (targetOffset < 0) return false;
    let quote = null;
    for (let i = 0; i < targetOffset; i++) {
      const ch = lineText[i];
      if (quote) {
        if (ch === '\\') {
          i += 1;
          continue;
        }
        if (quote.length === 3) {
          if (lineText.slice(i, i + 3) === quote) {
            quote = null;
            i += 2;
          }
        } else if (ch === quote) {
          quote = null;
        }
      } else {
        if (ch === '#') {
          return i === targetOffset;
        }
        const tri = lineText.slice(i, i + 3);
        if (tri === "'''" || tri === '"""') {
          quote = tri;
          i += 2;
        } else if (ch === "'" || ch === '"') {
          quote = ch;
        }
      }
    }
    return quote === null;
  }

  function parseTranslatableComment(rawText, targetLangId = 'zh-TW', allowSlash = false) {
    const raw = String(rawText || '');
    if (!raw || raw.includes('\n')) return null;

    const match = allowSlash
      ? raw.match(/^(\s*)(#+|\/\/+)(\s*)(.*)$/)
      : raw.match(/^(\s*)(#+)(\s*)(.*)$/);
    if (!match) return null;

    const [, leadWs, prefix, midWs, body] = match;
    const trimmedBody = body.trim();
    if (trimmedBody.length < 3) return null;
    if (PRAGMA_COMMENT_REGEX.test(trimmedBody)) return null;
    if (!shouldTranslateText(trimmedBody, targetLangId)) return null;

    return {
      leadWs,
      hashes: prefix,
      midWs: midWs || ' ',
      body: trimmedBody
    };
  }

  function ensureCodeFontSizeVar(containerEl, sampleSpan) {
    if (!containerEl || containerEl.dataset.kctFontMeasured === '1') return;
    const fs = getComputedStyle(sampleSpan).fontSize;
    if (fs && fs !== '0px') {
      containerEl.style.setProperty('--kct-code-font-size', fs);
      containerEl.dataset.kctFontMeasured = '1';
    }
  }

  function resolveOpaqueBackground(el) {
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      const bg = getComputedStyle(cur).backgroundColor;
      if (bg && bg !== 'transparent') {
        const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\)/i);
        if (!m || m[4] === undefined || parseFloat(m[4]) > 0.85) {
          return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : bg;
        }
      }
      cur = cur.parentElement;
    }
    return document.body?.dataset?.jpThemeLight === 'false' ? '#202124' : '#ffffff';
  }

  function renderCmCommentOverlay(ed, span, fullComment, state) {
    if (!ed || !span || !ed.isConnected || !span.isConnected) return;
    const scroller = ed.querySelector('.cm-scroller');
    if (!scroller) return;

    if (getComputedStyle(scroller).position === 'static') {
      scroller.style.position = 'relative';
    }

    let layer = scroller.querySelector(':scope > [data-kct-ui="cm-layer"]');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'kct-cm-layer';
      layer.setAttribute('data-kct-ui', 'cm-layer');
      layer.setAttribute('translate', 'no');
      scroller.appendChild(layer);
    }

    const scRect = scroller.getBoundingClientRect();
    const spRect = span.getBoundingClientRect();
    if (spRect.width === 0 || spRect.height === 0) return;

    let badge = state.cmOverlayBySpan.get(span);
    if (!badge || !badge.isConnected || badge.parentElement !== layer) {
      badge = document.createElement('div');
      badge.className = 'kct-cm-comment';
      badge.setAttribute('data-kct-ui', 'cm-comment');
      badge.setAttribute('translate', 'no');
      layer.appendChild(badge);
      state.cmOverlayBySpan.set(span, badge);
    }
    state.cmSpanByOverlay.set(badge, span);

    const spanStyle = getComputedStyle(span);
    const top = Math.round(spRect.top - scRect.top + scroller.scrollTop);
    const left = Math.floor(spRect.left - scRect.left + scroller.scrollLeft);
    const height = Math.ceil(spRect.height);
    const minWidth = Math.ceil(spRect.width + 6);
    const availWidth = Math.max(minWidth, Math.floor(scroller.clientWidth - left - 10));

    badge.textContent = fullComment;
    badge.style.top = `${top}px`;
    badge.style.left = `${left}px`;
    badge.style.height = `${height}px`;
    badge.style.minWidth = `${minWidth}px`;
    badge.style.maxWidth = `${availWidth}px`;
    badge.style.fontSize = spanStyle.fontSize || '14px';
    badge.style.lineHeight = `${height}px`;
    badge.style.fontStyle = spanStyle.fontStyle || 'italic';
    badge.style.color = spanStyle.color;
    badge.style.backgroundColor = resolveOpaqueBackground(ed);
  }

  function syncCmOverlays(state, settingsOverride) {
    if (!state) return;
    ensureAdapterState(state);
    const settings = settingsOverride || state.settings;
    if (!settings || settings.translateCodeComments === false || settings.displayMode === 'original') return;

    const targetLangId = settings.targetLang || 'zh-TW';
    const activeSpans = new Set();
    const editors = document.querySelectorAll('.cm-editor');
    for (const ed of editors) {
      if (ed.closest('.jp-MarkdownCell') || !isElementVisible(ed)) continue;
      const lines = ed.querySelectorAll('.cm-line');
      for (const line of lines) {
        const lineText = line.textContent || '';
        if (!lineText.includes('#')) continue;
        const leafSpans = Array.from(line.querySelectorAll('span')).filter((s) => s.children.length === 0);
        const targets = leafSpans.length > 0 ? leafSpans : [line];
        for (const t of targets) {
          const info = parseTranslatableComment(t.textContent, targetLangId, false);
          if (!info) continue;
          const spanOffset = t === line ? info.leadWs.length : getTextOffsetInParent(line, t) + info.leadWs.length;
          if (!isCommentOffsetInPythonLine(lineText, spanOffset)) continue;
          const cached = state.commentCacheByBody.get(info.body);
          if (cached) {
            activeSpans.add(t);
            renderCmCommentOverlay(ed, t, `${info.leadWs}${info.hashes}${info.midWs}${cached}`, state);
          }
        }
      }
    }

    const layers = document.querySelectorAll('.kct-cm-layer');
    for (const layer of layers) {
      for (const badge of Array.from(layer.children)) {
        const linkedSpan = state.cmSpanByOverlay.get(badge);
        if (!linkedSpan || !linkedSpan.isConnected || !activeSpans.has(linkedSpan)) {
          badge.remove();
        }
      }
    }
  }

  function collectCodeComments(force, settings, state) {
    if (!settings || (!settings.enabled && !force) || settings.translateCodeComments === false) return [];
    ensureAdapterState(state);

    const targetLangId = settings.targetLang || 'zh-TW';
    const items = [];
    const seen = new Set();

    // 1. Static <pre> code blocks (Pygments, Prism, Highlight.js, GitHub PrettyLights)
    const pres = document.querySelectorAll('pre');
    for (const pre of pres) {
      if (pre.closest('.cm-editor, .CodeMirror, .monaco-editor, [data-kct-ui]')) continue;
      if (!isElementVisible(pre)) continue;
      const commentSpans = pre.querySelectorAll(STATIC_COMMENT_SELECTOR);
      for (const span of commentSpans) {
        if (seen.has(span) || state.commentState.has(span)) continue;
        if (span.hasAttribute('data-kct-comment-trans')) continue;
        if (span.children.length > 0) continue;
        seen.add(span);

        const info = parseTranslatableComment(span.textContent, targetLangId, true);
        if (!info) continue;

        ensureCodeFontSizeVar(pre, span);
        const cachedTrans = state.commentCacheByBody.get(info.body);
        if (cachedTrans) {
          span.setAttribute('data-kct-comment-trans', `${info.leadWs}${info.hashes}${info.midWs}${cachedTrans}`);
          state.commentState.set(span, 'done');
          continue;
        }

        state.commentState.set(span, 'queued');
        items.push({
          kind: 'comment',
          el: span,
          key: hashText(`COMMENT::${info.body}`),
          text: `# ${info.body}`,
          commentInfo: info
        });
      }
    }

    // 2. Interactive JupyterLab v4 CodeMirror 6 code cells (non-intrusive overlay layer)
    const cmEditors = document.querySelectorAll('.cm-editor');
    for (const ed of cmEditors) {
      if (ed.closest('.jp-MarkdownCell')) continue;
      if (!isElementVisible(ed)) continue;
      const lines = ed.querySelectorAll('.cm-line');
      for (const line of lines) {
        const lineText = line.textContent || '';
        if (!lineText.includes('#')) continue;

        const leafSpans = Array.from(line.querySelectorAll('span')).filter((s) => s.children.length === 0);
        if (leafSpans.length > 0) {
          for (const span of leafSpans) {
            if (seen.has(span)) continue;
            const info = parseTranslatableComment(span.textContent, targetLangId, false);
            if (!info) continue;

            const spanOffset = getTextOffsetInParent(line, span);
            const hashOffset = spanOffset + info.leadWs.length;
            if (!isCommentOffsetInPythonLine(lineText, hashOffset)) continue;

            seen.add(span);
            const cachedTrans = state.commentCacheByBody.get(info.body);
            if (cachedTrans) {
              renderCmCommentOverlay(ed, span, `${info.leadWs}${info.hashes}${info.midWs}${cachedTrans}`, state);
              state.commentState.set(span, 'done');
              continue;
            }
            if (state.commentState.has(span)) continue;

            state.commentState.set(span, 'queued');
            items.push({
              kind: 'comment',
              cmEditor: ed,
              el: span,
              key: hashText(`COMMENT::${info.body}`),
              text: `# ${info.body}`,
              commentInfo: info
            });
          }
        } else if (!seen.has(line)) {
          const info = parseTranslatableComment(lineText, targetLangId, false);
          if (info) {
            seen.add(line);
            const cachedTrans = state.commentCacheByBody.get(info.body);
            if (cachedTrans) {
              renderCmCommentOverlay(ed, line, `${info.leadWs}${info.hashes}${info.midWs}${cachedTrans}`, state);
              state.commentState.set(line, 'done');
              continue;
            }
            if (state.commentState.has(line)) continue;

            state.commentState.set(line, 'queued');
            items.push({
              kind: 'comment',
              cmEditor: ed,
              el: line,
              key: hashText(`COMMENT::${info.body}`),
              text: `# ${info.body}`,
              commentInfo: info
            });
          }
        }
      }
    }

    return items;
  }

  function renderCommentTranslation(job, settings, state) {
    ensureAdapterState(state);
    const { el, zh, commentInfo, cmEditor } = job;
    const cleaned = String(zh || '').replace(/^\s*(?:#+|\/\/+)\s*/, '').trim();
    if (cleaned && commentInfo?.body) {
      state.commentCacheByBody.set(commentInfo.body, cleaned);
    }
    if (!el || !el.isConnected) {
      return 'disconnected';
    }
    if (!cleaned) {
      state.commentState.delete(el);
      return 'empty';
    }

    const fullComment = `${commentInfo.leadWs}${commentInfo.hashes}${commentInfo.midWs}${cleaned}`;
    if (cmEditor && cmEditor.isConnected) {
      renderCmCommentOverlay(cmEditor, el, fullComment, state);
    } else {
      el.setAttribute('data-kct-comment-trans', fullComment);
    }
    state.commentState.set(el, 'done');
    return 'rendered';
  }

  function injectOutputTranslateButtons(settings, pageContext) {
    if (!settings || settings.showOutputTranslateBtn === false) return;
    if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return;
    const targetLangId = settings.targetLang || 'zh-TW';
    const outputAreas = document.querySelectorAll(
      '.jp-OutputArea-output .jp-RenderedText, .output_subarea.output_text, .output_subarea.output_stream, .output_subarea.output_error'
    );
    for (const area of outputAreas) {
      if (area.dataset.kctOutputBound === '1') continue;
      if (area.closest('.dataframe, table.dataframe')) continue;
      const rawText = (area.innerText || area.textContent || '').trim();
      if (rawText.length < 6 || !shouldTranslateText(rawText, targetLangId)) continue;

      area.dataset.kctOutputBound = '1';
      area.classList.add('kct-output-host');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kct-output-btn';
      btn.setAttribute('data-kct-ui', 'output-btn');
      btn.setAttribute('translate', 'no');
      btn.textContent = '譯';
      btn.title = '翻譯此執行輸出（如 Hint 提示 / Check 驗證 / 錯誤訊息）';

      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const existing = area.querySelector('.kct-output-trans');
        if (existing) {
          existing.remove();
          btn.textContent = '譯';
          return;
        }
        const clone = area.cloneNode(true);
        for (const uiNode of clone.querySelectorAll('[data-kct-ui]')) {
          uiNode.remove();
        }
        const latestText = (clone.innerText || clone.textContent || '').trim();
        btn.textContent = '翻譯中...';
        btn.disabled = true;
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'TRANSLATE_SINGLE',
            mode: 'output',
            text: latestText.slice(0, 3500),
            pageContext: pageContext || undefined
          });
          const box = document.createElement('div');
          box.className = 'kct-output-trans';
          box.setAttribute('data-kct-ui', 'output-trans');
          box.setAttribute('translate', 'no');
          box.textContent = res?.ok ? res.zh : (res?.error || '翻譯失敗');
          area.appendChild(box);
          btn.textContent = '收起譯文';
        } catch (_) {
          btn.textContent = '重試';
        } finally {
          btn.disabled = false;
        }
      });

      area.appendChild(btn);
    }
  }

  function clearNotebookOverlays(state) {
    ensureAdapterState(state);
    const commentedEls = document.querySelectorAll('[data-kct-comment-trans]');
    for (const cel of commentedEls) {
      cel.removeAttribute('data-kct-comment-trans');
    }
    const cmLayers = document.querySelectorAll('[data-kct-ui="cm-layer"]');
    for (const layer of cmLayers) {
      layer.remove();
    }
    const outputUIs = document.querySelectorAll('[data-kct-ui="output-btn"], [data-kct-ui="output-trans"]');
    for (const ui of outputUIs) {
      ui.remove();
    }
    const outputHosts = document.querySelectorAll('.kct-output-host');
    for (const host of outputHosts) {
      host.classList.remove('kct-output-host');
      delete host.dataset.kctOutputBound;
    }
    // Reset WeakMaps completely so CodeMirror 6 comments & queued spans can be re-translated
    state.commentState = new WeakMap();
    state.cmOverlayBySpan = new WeakMap();
    state.cmSpanByOverlay = new WeakMap();
    state.commentCacheByBody.clear();
  }

  const codeOverlayApi = {
    STATIC_COMMENT_SELECTOR,
    parseTranslatableComment,
    collectCodeComments,
    renderCommentTranslation,
    syncCmOverlays,
    injectOutputTranslateButtons,
    clearNotebookOverlays,
    clearCodeOverlays: clearNotebookOverlays
  };

  globalThis.KCTCodeOverlay = codeOverlayApi;
  globalThis.KCTNotebookAdapter = codeOverlayApi;
})();
