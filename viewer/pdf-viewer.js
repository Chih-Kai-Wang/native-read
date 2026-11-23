import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
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
} from '../shared/pdf-layout.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

const {
  TARGET_LANGUAGES,
  SETTINGS_KEY,
  getSettings,
  saveSettings,
  hashText,
  resolveTargetLanguage
} = globalThis.KCTConfig;

const ZOOM_STEPS = [0.75, 0.85, 1.0, 1.15, 1.25, 1.5, 1.75];

// ============================================================
// DOM References
// ============================================================
const dom = {
  viewerMain: document.getElementById('viewerMain'),
  docTitle: document.getElementById('docTitle'),
  pageIndicator: document.getElementById('pageIndicator'),
  modeSegmented: document.getElementById('modeSegmented'),
  langSelect: document.getElementById('langSelect'),
  zoomOutBtn: document.getElementById('zoomOutBtn'),
  zoomResetBtn: document.getElementById('zoomResetBtn'),
  zoomInBtn: document.getElementById('zoomInBtn'),
  statusBadge: document.getElementById('statusBadge'),
  statusText: document.getElementById('statusText'),
  statusActionBtn: document.getElementById('statusActionBtn'),
  openFileBtn: document.getElementById('openFileBtn'),
  fileInput: document.getElementById('fileInput'),
  settingsBtn: document.getElementById('settingsBtn'),

  emptyState: document.getElementById('emptyState'),
  emptyOpenBtn: document.getElementById('emptyOpenBtn'),
  urlForm: document.getElementById('urlForm'),
  urlInput: document.getElementById('urlInput'),

  loadingState: document.getElementById('loadingState'),
  loadingTitle: document.getElementById('loadingTitle'),
  loadingSub: document.getElementById('loadingSub'),

  errorState: document.getElementById('errorState'),
  errorTitle: document.getElementById('errorTitle'),
  errorDetail: document.getElementById('errorDetail'),
  retryUrlBtn: document.getElementById('retryUrlBtn'),
  errorOpenFileBtn: document.getElementById('errorOpenFileBtn'),

  pagesContainer: document.getElementById('pagesContainer'),
  dragOverlay: document.getElementById('dragOverlay'),

  comparePopover: document.getElementById('comparePopover'),
  compareOrigText: document.getElementById('compareOrigText'),
  compareTransText: document.getElementById('compareTransText'),
  copyOrigBtn: document.getElementById('copyOrigBtn'),
  copyTransBtn: document.getElementById('copyTransBtn'),
  compareCloseBtn: document.getElementById('compareCloseBtn')
};

// ============================================================
// Application State
// ============================================================
const state = {
  settings: null,
  mode: 'overlay', // 'overlay' | 'split' | 'original'
  zoom: 1.0,
  baseFitScale: 1.35,
  docLoadToken: 0,
  translationEpoch: 0,

  pdfDoc: null,
  numPages: 0,
  currentPage: 1,
  docTitle: '',
  docHost: 'local-pdf',
  sourceUrl: '',
  defaultPageWidth: 612,
  defaultPageHeight: 792,
  activeFetchController: null,

  pages: new Map(), // pageNum -> PageRecord
  translations: new Map(), // hashKey -> translated string
  mathPlaceholdersByKey: new Map(), // hashKey -> Map<token, rawMath>
  skippedEchoKeys: new Set(), // hashKey -> exhausted echo items (keep original canvas)

  // Metrics for toolbar status
  totalParagraphs: 0,
  translatedParagraphs: 0,
  cachedKeys: new Set(),
  lastError: '',
  lastErrorCode: '',

  // Observers & Scroll Tracking
  renderObserver: null,
  pageTrackRaf: 0,

  // Streaming Port ('kct-stream')
  streamPort: null,
  streamReqSeq: 0,
  activeStreamRequests: new Map(), // requestId -> req

  // Active compare popover state
  activeCompareAnchor: null,
  activeComparePara: null,
  dragDepth: 0
};

// ============================================================
// UI Helpers & Status
// ============================================================
function showStage(stage) {
  dom.emptyState.hidden = stage !== 'empty';
  dom.loadingState.hidden = stage !== 'loading';
  dom.errorState.hidden = stage !== 'error';
  dom.pagesContainer.hidden = stage !== 'pages';
}

function recomputeProgressMetrics() {
  let total = 0;
  let translated = 0;
  let cached = 0;
  let active = 0;
  for (const pageRec of state.pages.values()) {
    if (pageRec.translationInFlight) active += 1;
    for (const para of pageRec.translatableParagraphs || []) {
      total += 1;
      if (state.translations.has(para.key)) {
        translated += 1;
        if (state.cachedKeys.has(para.key)) cached += 1;
      } else if (state.skippedEchoKeys.has(para.key)) {
        translated += 1;
      }
    }
  }
  state.totalParagraphs = total;
  state.translatedParagraphs = translated;
  return { total, translated, cached, active };
}

function updateStatusBadge() {
  if (state.lastError) {
    dom.statusBadge.dataset.state = 'error';
    dom.statusText.textContent = state.lastError;
    dom.statusText.title = state.lastError;
    if (state.lastErrorCode === 'NO_API_KEY') {
      dom.statusActionBtn.textContent = '前往設定';
      dom.statusActionBtn.hidden = false;
    } else {
      dom.statusActionBtn.hidden = true;
    }
    return;
  }

  dom.statusActionBtn.hidden = true;

  if (!state.pdfDoc) {
    dom.statusBadge.dataset.state = 'idle';
    dom.statusText.textContent = '就緒';
    dom.statusText.title = '';
    return;
  }

  const { total, translated, cached, active } = recomputeProgressMetrics();

  if (active > 0) {
    dom.statusBadge.dataset.state = 'streaming';
    const progress = total > 0
      ? `串流翻譯中 ${translated}/${total}`
      : '串流翻譯中...';
    dom.statusText.textContent = progress;
    dom.statusText.title = progress;
    return;
  }

  if (translated > 0) {
    dom.statusBadge.dataset.state = 'done';
    const label = `已譯 ${translated} 段`;
    dom.statusText.textContent = label;
    dom.statusText.title = label;
    return;
  }

  dom.statusBadge.dataset.state = 'idle';
  dom.statusText.textContent = `已載入 ${state.numPages} 頁`;
  dom.statusText.title = '';
}

function updatePageIndicator(pageNum) {
  if (!state.numPages) {
    dom.pageIndicator.hidden = true;
    return;
  }
  state.currentPage = Math.max(1, Math.min(state.numPages, pageNum));
  dom.pageIndicator.hidden = false;
  dom.pageIndicator.textContent = `第 ${state.currentPage} / ${state.numPages} 頁`;
}

function updateZoomUI() {
  const pct = Math.round(state.zoom * 100);
  dom.zoomResetBtn.textContent = `${pct}%`;
  dom.zoomOutBtn.disabled = state.zoom <= ZOOM_STEPS[0] + 0.001;
  dom.zoomInBtn.disabled = state.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001;
}

function computeTargetDisplayWidth(mode = state.mode) {
  const vw = window.innerWidth || 1024;
  if (mode === 'split' && vw > 900) {
    const containerW = Math.min(1560, vw - 40);
    return Math.max(280, Math.floor((containerW - 22) * 0.5));
  }
  if (vw <= 768) {
    return Math.max(260, vw - 20);
  }
  const avail = vw - (mode === 'split' ? 40 : 48);
  return Math.min(860, Math.max(280, avail));
}

function computePageBaseFitScale(pageUnscaledWidth, mode = state.mode) {
  const targetDisplayWidth = computeTargetDisplayWidth(mode);
  return Math.max(0.25, Math.min(1.65, targetDisplayWidth / Math.max(120, pageUnscaledWidth)));
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

function syncCurrentPageFromViewport() {
  if (!state.numPages || state.pages.size === 0) return;
  const vh = window.innerHeight || 800;
  const toolbarBottom = document.getElementById('toolbar')?.getBoundingClientRect().bottom || 52;
  const anchorY = toolbarBottom + Math.max(40, (vh - toolbarBottom) * 0.35);

  let anchorMatch = null;
  let bestOverlapPage = null;
  let bestOverlap = 0;

  for (const pageRec of state.pages.values()) {
    const rect = pageRec.rowEl.getBoundingClientRect();
    if (rect.top > vh) break;
    if (rect.bottom < toolbarBottom) continue;

    if (rect.top <= anchorY && rect.bottom >= anchorY) {
      anchorMatch = pageRec.pageNum;
      break;
    }

    const visTop = Math.max(toolbarBottom, rect.top);
    const visBot = Math.min(vh, rect.bottom);
    const overlap = Math.max(0, visBot - visTop);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestOverlapPage = pageRec.pageNum;
    }
  }

  const nextPage = anchorMatch ?? bestOverlapPage;
  if (nextPage !== null && nextPage !== state.currentPage) {
    updatePageIndicator(nextPage);
  }
}

function scheduleSyncCurrentPage() {
  if (state.pageTrackRaf) return;
  state.pageTrackRaf = requestAnimationFrame(() => {
    state.pageTrackRaf = 0;
    syncCurrentPageFromViewport();
  });
}

function setMode(nextMode) {
  if (!['overlay', 'split', 'original'].includes(nextMode)) return;
  state.mode = nextMode;
  dom.viewerMain.dataset.mode = nextMode;
  closeComparePopover();

  const buttons = dom.modeSegmented.querySelectorAll('.nr-seg-btn');
  for (const btn of buttons) {
    const active = btn.dataset.mode === nextMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  if (state.pdfDoc) {
    const nextBaseFitScale = computePageBaseFitScale(state.defaultPageWidth || 612, nextMode);
    let anyScaleChanged = Math.abs(nextBaseFitScale - state.baseFitScale) > 0.01;
    if (!anyScaleChanged) {
      for (const pageRec of state.pages.values()) {
        const expected = computePageBaseFitScale(pageRec.baseWidth || state.defaultPageWidth || 612, nextMode);
        if (Math.abs(expected - (pageRec.baseFitScale || state.baseFitScale)) > 0.01) {
          anyScaleChanged = true;
          break;
        }
      }
    }
    if (anyScaleChanged) {
      state.baseFitScale = nextBaseFitScale;
      refreshPageShellsForCurrentScale();
    }
  }

  // Re-fit any overlays that were rendered while overlay layer was display:none (in split/original mode)
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
      syncCurrentPageFromViewport();
    });
  } else {
    requestAnimationFrame(() => {
      syncCurrentPageFromViewport();
    });
  }
}

function populateLanguageSelect(currentLang) {
  dom.langSelect.replaceChildren();
  for (const [id, info] of Object.entries(TARGET_LANGUAGES)) {
    if (id === 'custom' && !String(state.settings?.customTargetLang || '').trim()) {
      continue;
    }
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id === 'custom'
      ? String(state.settings?.customTargetLang || info.label)
      : info.label;
    dom.langSelect.appendChild(opt);
  }
  if (Array.from(dom.langSelect.options).some((o) => o.value === currentLang)) {
    dom.langSelect.value = currentLang;
  } else {
    dom.langSelect.value = 'zh-TW';
  }
}

function getPageContext() {
  return {
    pageType: 'universal',
    title: state.docTitle || 'PDF Document',
    host: state.docHost || 'local-pdf',
    useTechGlossary: true
  };
}

// ============================================================
// Overlay & Split View Rendering
// ============================================================
function fitOverlayTypography(el, para, maxHeight, boxWidth) {
  const startScale = para.isHeading ? 0.96 : 0.94;
  const minFs = Math.max(8.5, para.fontSize * 0.60);
  let fs = Math.max(minFs, para.fontSize * startScale);
  const minLh = para.lineCount === 1 ? 1.10 : 1.14;
  let lh = para.lineCount === 1 ? 1.15 : Math.max(1.20, Math.min(1.46, para.avgLineHeightRatio));

  el.style.fontSize = `${fs.toFixed(2)}px`;
  el.style.lineHeight = lh.toFixed(2);
  el.style.maxHeight = '';
  el.classList.remove('is-clipped');

  const fits = () => el.scrollHeight <= maxHeight + 1 && el.scrollWidth <= boxWidth + 2;

  let guard = 0;
  while (!fits() && fs > minFs + 0.15 && guard < 18) {
    fs = Math.max(minFs, fs * 0.92);
    if (lh > minLh) {
      lh = Math.max(minLh, lh - 0.03);
    }
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

  // Final defense: never cover crisp original PDF canvas with an untranslated echo or identical no-op box
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

  if (state.mode !== 'overlay') {
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
    empty.textContent = '此頁無可翻譯正文段落（可能為圖表、純掃描影像或目標語言內容）。';
    body.appendChild(empty);
    pageRec.splitStatusEl.textContent = '無需翻譯';
    return;
  }

  for (const para of pageRec.translatableParagraphs) {
    const pEl = document.createElement(para.isHeading ? 'h3' : 'p');
    pEl.className = 'nr-split-para is-pending';
    if (para.isHeading) pEl.classList.add('is-heading');
    else if (para.isBold) pEl.classList.add('is-bold');
    pEl.style.fontFamily = para.isSerif ? langInfo.serifFontStack : langInfo.sansFontStack;
    pEl.textContent = para.text;
    pEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const translated = state.translations.get(para.key);
      if (translated) {
        toggleComparePopover(pEl, para, translated);
      }
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
  if (!para.isHeading) {
    pEl.classList.toggle('is-bold', Boolean(para.isBold));
  }
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
  if (!matched || matched.length === 0) return;

  for (const para of matched) {
    renderParagraphOverlay(pageRec, para, zh);
    updateSplitParagraph(pageRec, para, zh);
  }
}

// ============================================================
// Inline Original-English Compare Popover
// ============================================================
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

  const cleanedZh = cleanLatexMathInText(translatedText);

  if (state.activeCompareAnchor) {
    state.activeCompareAnchor.classList.remove('is-active-compare');
  }
  state.activeCompareAnchor = anchorEl;
  state.activeComparePara = { orig: para.text, trans: cleanedZh };
  anchorEl.classList.add('is-active-compare');

  const langInfo = resolveTargetLanguage(state.settings);
  dom.compareOrigText.textContent = para.text;
  dom.compareTransText.textContent = cleanedZh;
  dom.compareTransText.style.fontFamily = para.isSerif ? langInfo.serifFontStack : langInfo.sansFontStack;

  dom.comparePopover.hidden = false;

  // Position safely within viewport bounds near the clicked paragraph
  const anchorRect = anchorEl.getBoundingClientRect();
  const popRect = dom.comparePopover.getBoundingClientRect();
  const margin = 12;
  const toolbarBottom = Math.ceil((document.getElementById('toolbar')?.getBoundingClientRect().bottom || 52) + 8);

  let left = anchorRect.left;
  if (left + popRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popRect.width - margin;
  }
  left = Math.max(margin, left);

  let top = anchorRect.bottom + 8;
  if (top + popRect.height > window.innerHeight - margin) {
    const aboveTop = anchorRect.top - popRect.height - 8;
    if (aboveTop >= toolbarBottom) {
      top = aboveTop;
    } else {
      top = Math.max(toolbarBottom, window.innerHeight - popRect.height - margin);
    }
  }

  dom.comparePopover.style.left = `${Math.round(left)}px`;
  dom.comparePopover.style.top = `${Math.round(top)}px`;
}

// ============================================================
// SSE Streaming Port ('kct-stream') + TRANSLATE_BATCH Fallback
// ============================================================
function cancelAllActiveStreams() {
  for (const [requestId, req] of state.activeStreamRequests.entries()) {
    if (req.timer) clearTimeout(req.timer);
    if (state.streamPort) {
      try {
        state.streamPort.postMessage({ type: 'CANCEL_STREAM', requestId });
      } catch (_) {}
    }
    req.resolve({ cancelled: true });
  }
  state.activeStreamRequests.clear();
}

function handleStreamMessage(msg) {
  if (!msg || typeof msg !== 'object' || !msg.requestId) return;
  const req = state.activeStreamRequests.get(msg.requestId);
  if (!req) return;

  if (req.timer) {
    clearTimeout(req.timer);
    req.timer = setTimeout(() => {
      state.activeStreamRequests.delete(msg.requestId);
      if (state.streamPort) {
        try {
          state.streamPort.postMessage({ type: 'CANCEL_STREAM', requestId: msg.requestId });
        } catch (_) {}
      }
      req.reject({ portFallback: true, error: '串流回應逾時' });
    }, 60000);
  }

  if (msg.type === 'ITEM') {
    if (req.epoch !== state.translationEpoch) return;
    if (msg.key && typeof msg.zh === 'string' && msg.zh.trim()) {
      req.receivedKeys.add(msg.key);
      req.onItem(msg.key, msg.zh.trim(), Boolean(msg.cached));
    }
    return;
  }

  if (msg.type === 'DONE') {
    if (req.timer) clearTimeout(req.timer);
    state.activeStreamRequests.delete(msg.requestId);
    req.resolve({ ok: true, translatedCount: msg.translatedCount || 0 });
    return;
  }

  if (msg.type === 'ERROR') {
    if (req.timer) clearTimeout(req.timer);
    state.activeStreamRequests.delete(msg.requestId);
    req.reject({
      error: msg.error || '串流翻譯失敗',
      errorCode: msg.errorCode || ''
    });
  }
}

function ensureStreamPort() {
  if (state.streamPort) return state.streamPort;
  const port = chrome.runtime.connect({ name: 'kct-stream' });
  port.onMessage.addListener(handleStreamMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (state.streamPort === port) {
      state.streamPort = null;
    }
    for (const [reqId, req] of state.activeStreamRequests.entries()) {
      if (req.timer) clearTimeout(req.timer);
      state.activeStreamRequests.delete(reqId);
      req.reject({ portFallback: true, error: '串流連線中斷' });
    }
  });
  state.streamPort = port;
  return port;
}

function sendBatchViaStreamPort(uniqueItems, pageContext, epoch, receivedKeys, onItem) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = ensureStreamPort();
    } catch (err) {
      reject({ portFallback: true, error: err?.message || '無法建立串流連線' });
      return;
    }

    const requestId = `pdf_${Date.now()}_${++state.streamReqSeq}`;
    const req = {
      epoch,
      receivedKeys,
      onItem,
      resolve,
      reject,
      timer: setTimeout(() => {
        state.activeStreamRequests.delete(requestId);
        if (state.streamPort) {
          try {
            state.streamPort.postMessage({ type: 'CANCEL_STREAM', requestId });
          } catch (_) {}
        }
        reject({ portFallback: true, error: '串流連線逾時' });
      }, 60000)
    };
    state.activeStreamRequests.set(requestId, req);

    try {
      port.postMessage({
        type: 'TRANSLATE_STREAM',
        requestId,
        items: uniqueItems,
        pageContext
      });
    } catch (err) {
      if (req.timer) clearTimeout(req.timer);
      state.activeStreamRequests.delete(requestId);
      state.streamPort = null;
      reject({ portFallback: true, error: err?.message || '傳送串流訊息失敗' });
    }
  });
}

async function sendBatchViaFallback(uniqueItems, pageContext, epoch, onItem) {
  const response = await chrome.runtime.sendMessage({
    type: 'TRANSLATE_BATCH',
    items: uniqueItems,
    pageContext
  });
  if (epoch !== state.translationEpoch) return;
  if (!response?.ok) {
    const err = new Error(response?.error || '批次翻譯失敗');
    err.errorCode = response?.errorCode || '';
    throw err;
  }
  const results = response.results || {};
  for (const item of uniqueItems) {
    const hit = results[item.key];
    if (hit && typeof hit.zh === 'string' && hit.zh.trim()) {
      onItem(item.key, hit.zh.trim(), Boolean(hit.cached));
    }
  }
}

function buildPageBatches(items) {
  const maxCount = Math.max(1, Number(state.settings?.batchSize || 20));
  const maxChars = Math.max(800, Number(state.settings?.maxBatchChars || 5500));
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
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

async function translatePageParagraphs(pageRec, epoch) {
  if (epoch !== state.translationEpoch) return;
  if (pageRec.translationInFlight || pageRec.translatedEpoch === epoch) return;

  const targetLangId = state.settings?.targetLang || 'zh-TW';
  const viewportWidth = pageRec.viewport?.width || 800;

  // Filter paragraphs for current target language
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
    updateStatusBadge();
    return;
  }

  updateStatusBadge();

  // Immediately paint any paragraphs already in memory from another page or zoom
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
      uncachedByKey.set(para.key, {
        key: reqKey,
        text: protectedRes.text,
        kind: 'block'
      });
    }
  }

  const toRequest = Array.from(uncachedByKey.values());
  if (toRequest.length === 0) {
    pageRec.translatedEpoch = epoch;
    updateStatusBadge();
    return;
  }

  const runSeq = (pageRec.translationRunSeq || 0) + 1;
  pageRec.translationRunSeq = runSeq;
  pageRec.translationInFlight = true;
  state.lastError = '';
  state.lastErrorCode = '';
  updateStatusBadge();

  const batches = buildPageBatches(toRequest);
  const pageContext = getPageContext();
  const useStream = state.settings?.streamTranslation !== false;

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
      for (const otherPage of state.pages.values()) {
        const hit = otherPage.paragraphsByKey.get(key)?.[0];
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
      updateStatusBadge();
      return;
    }
    state.translations.set(key, cleanZh);
    if (cached) state.cachedKeys.add(key);
    applyTranslationToPage(pageRec, key, cleanZh);
    // Also propagate to any other already-rendered page sharing the exact same header/paragraph key
    for (const otherPage of state.pages.values()) {
      if (otherPage !== pageRec && otherPage.paragraphsByKey.has(key)) {
        applyTranslationToPage(otherPage, key, cleanZh);
      }
    }
    updateStatusBadge();
  };

  let allSucceeded = true;

  try {
    for (const batch of batches) {
      if (epoch !== state.translationEpoch) return;
      const receivedKeys = new Set();

      if (useStream) {
        let needFallback = false;
        try {
          const res = await sendBatchViaStreamPort(batch, pageContext, epoch, receivedKeys, onItemArrived);
          if (res?.cancelled || epoch !== state.translationEpoch) return;
        } catch (err) {
          if (epoch !== state.translationEpoch) return;
          if (err?.portFallback) {
            needFallback = true;
          } else {
            state.lastError = err?.error || err?.message || '串流翻譯失敗';
            state.lastErrorCode = err?.errorCode || '';
            allSucceeded = false;
            if (state.lastErrorCode === 'NO_API_KEY') break;
          }
        }

        if (needFallback && epoch === state.translationEpoch) {
          const remaining = batch.filter((it) => !receivedKeys.has(it.key));
          if (remaining.length > 0) {
            try {
              await sendBatchViaFallback(remaining, pageContext, epoch, onItemArrived);
            } catch (fbErr) {
              state.lastError = fbErr?.message || '翻譯請求失敗';
              state.lastErrorCode = fbErr?.errorCode || '';
              allSucceeded = false;
              if (state.lastErrorCode === 'NO_API_KEY') break;
            }
          }
        }
      } else {
        try {
          await sendBatchViaFallback(batch, pageContext, epoch, onItemArrived);
        } catch (err) {
          state.lastError = err?.message || '翻譯請求失敗';
          state.lastErrorCode = err?.errorCode || '';
          allSucceeded = false;
          if (state.lastErrorCode === 'NO_API_KEY') break;
        }
      }
    }

    if (allSucceeded && epoch === state.translationEpoch) {
      pageRec.translatedEpoch = epoch;
    }
  } finally {
    if (pageRec.translationRunSeq === runSeq) {
      pageRec.translationInFlight = false;
    }
    updateStatusBadge();
  }
}

// ============================================================
// Per-Page Lazy Canvas Rendering & Geometry Extraction
// ============================================================
function cancelPageRender(pageRec) {
  if (!pageRec) return;
  pageRec.renderSeq = (pageRec.renderSeq || 0) + 1;
  if (pageRec.renderTask) {
    const task = pageRec.renderTask;
    pageRec.renderTask = null;
    try {
      task.cancel();
    } catch (_) {}
  }
}

async function renderAndTranslatePage(pageNum, { forceCanvas = false } = {}) {
  const pageRec = state.pages.get(pageNum);
  const pdfDoc = state.pdfDoc;
  if (!pageRec || !pdfDoc) return;

  const loadToken = state.docLoadToken;
  let targetScale = (pageRec.baseFitScale || state.baseFitScale) * state.zoom;

  const needsCanvas = forceCanvas || !pageRec.rendered || Math.abs(pageRec.renderedScale - targetScale) > 0.005;

  if (needsCanvas) {
    const renderSeq = (pageRec.renderSeq || 0) + 1;
    pageRec.renderSeq = renderSeq;

    if (pageRec.renderTask) {
      const prevTask = pageRec.renderTask;
      pageRec.renderTask = null;
      try {
        prevTask.cancel();
        await prevTask.promise.catch(() => {});
      } catch (_) {}
      if (renderSeq !== pageRec.renderSeq || loadToken !== state.docLoadToken) return;
    }

    let activeRenderTask = null;
    try {
      const pdfPage = await pdfDoc.getPage(pageNum);
      if (renderSeq !== pageRec.renderSeq || loadToken !== state.docLoadToken) return;

      // Guard again right before touching canvas in case another renderTask started during getPage()
      if (pageRec.renderTask) {
        const prevTask = pageRec.renderTask;
        pageRec.renderTask = null;
        try {
          prevTask.cancel();
          await prevTask.promise.catch(() => {});
        } catch (_) {}
        if (renderSeq !== pageRec.renderSeq || loadToken !== state.docLoadToken) return;
      }

      const baseVp = pdfPage.getViewport({ scale: 1.0 });
      pageRec.baseWidth = baseVp.width;
      pageRec.baseHeight = baseVp.height;
      pageRec.baseFitScale = computePageBaseFitScale(baseVp.width, state.mode);
      targetScale = pageRec.baseFitScale * state.zoom;

      const viewport = pdfPage.getViewport({ scale: targetScale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

      pageRec.sheetEl.style.width = `${viewport.width}px`;
      pageRec.sheetEl.style.height = `${viewport.height}px`;

      const canvas = pageRec.canvasEl;
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      activeRenderTask = pdfPage.render({
        canvasContext: ctx,
        viewport
      });
      pageRec.renderTask = activeRenderTask;

      await activeRenderTask.promise;
      if (renderSeq !== pageRec.renderSeq || loadToken !== state.docLoadToken) return;
      pageRec.renderTask = null;
      pageRec.rendered = true;
      pageRec.renderedScale = targetScale;
      pageRec.viewport = viewport;
      pageRec.loaderEl.hidden = true;

      // Capture page canvas pixels ONCE per page instead of 1000+ per-pixel getImageData readbacks
      let pageImageData = null;
      try {
        pageImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch (_) {}

      // Extract (or re-extract at new scale) text geometry & sample perimeter background pixels
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

      // If this page already started or finished translating for the current epoch (e.g. zoom re-render),
      // rebuild key index with new-scale paragraphs and repaint any existing translations immediately.
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
          if (zh) {
            renderParagraphOverlay(pageRec, para, zh);
          }
        }
        return;
      }
    } catch (err) {
      if (err?.name === 'RenderingCancelledException' || renderSeq !== pageRec.renderSeq || loadToken !== state.docLoadToken) {
        return;
      }
      console.warn(`[NativeRead PDF] Render page ${pageNum} error:`, err);
      return;
    } finally {
      if (activeRenderTask && pageRec.renderTask === activeRenderTask) {
        pageRec.renderTask = null;
      }
    }
  }

  // Trigger lazy streaming translation for this page
  await translatePageParagraphs(pageRec, state.translationEpoch);
}

// ============================================================
// Document Shell Creation & Observers
// ============================================================
function disconnectObservers() {
  if (state.renderObserver) {
    state.renderObserver.disconnect();
    state.renderObserver = null;
  }
  if (state.pageTrackRaf) {
    cancelAnimationFrame(state.pageTrackRaf);
    state.pageTrackRaf = 0;
  }
}

function buildPageShells(numPages, defaultWidth, defaultHeight) {
  dom.pagesContainer.replaceChildren();
  state.pages.clear();

  const cssW = Math.round(defaultWidth * state.baseFitScale * state.zoom);
  const cssH = Math.round(defaultHeight * state.baseFitScale * state.zoom);

  const frag = document.createDocumentFragment();

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const row = document.createElement('section');
    row.className = 'nr-page-row';
    row.dataset.pageNum = String(pageNum);

    // Left column: Canvas + Overlay
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

    // Right column: Split-view translated card
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
      baseWidth: defaultWidth,
      baseHeight: defaultHeight,
      baseFitScale: state.baseFitScale,
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

  dom.pagesContainer.appendChild(frag);
}

function setupObservers() {
  disconnectObservers();

  state.renderObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNum = Number(entry.target.dataset.pageNum);
        const pageRec = state.pages.get(pageNum);
        if (!pageRec) continue;
        pageRec.isVisible = entry.isIntersecting;
        if (entry.isIntersecting) {
          renderAndTranslatePage(pageNum);
        } else if (!pageRec.rendered && pageRec.renderTask) {
          cancelPageRender(pageRec);
        }
      }
    },
    { rootMargin: '500px 0px', threshold: 0.01 }
  );

  for (const pageRec of state.pages.values()) {
    state.renderObserver.observe(pageRec.rowEl);
  }
  scheduleSyncCurrentPage();
}

// ============================================================
// PDF Loading (URL + Local File)
// ============================================================
function hasPdfMagicHeader(uint8) {
  const limit = Math.min(uint8.length, 1024);
  for (let i = 0; i <= limit - 5; i++) {
    if (
      uint8[i] === 0x25 && // %
      uint8[i + 1] === 0x50 && // P
      uint8[i + 2] === 0x44 && // D
      uint8[i + 3] === 0x46 && // F
      uint8[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}

function deriveFilenameFromUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const gId = parsed.searchParams.get('id');
    if (gId && (parsed.hostname.includes('drive.google.com') || parsed.hostname.includes('docs.google.com'))) {
      return `GoogleDrive_${gId.slice(0, 8)}.pdf`;
    }
    const seg = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    return seg || parsed.hostname;
  } catch (_) {
    return 'PDF Document';
  }
}

async function openPdfFromArrayBuffer(arrayBuffer, { title, host, sourceUrl = '' }) {
  const loadToken = ++state.docLoadToken;
  state.translationEpoch += 1;
  cancelAllActiveStreams();
  disconnectObservers();
  closeComparePopover();

  for (const pageRec of state.pages.values()) {
    cancelPageRender(pageRec);
  }

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
  state.totalParagraphs = 0;
  state.translatedParagraphs = 0;
  state.lastError = '';
  state.lastErrorCode = '';
  state.docTitle = title || 'PDF Document';
  state.docHost = host || 'local-pdf';
  state.sourceUrl = sourceUrl;

  dom.docTitle.textContent = state.docTitle;
  dom.docTitle.title = state.docTitle;
  document.title = `${state.docTitle} · NativeRead PDF`;

  showStage('loading');
  dom.loadingTitle.textContent = '正在解析 PDF 文件...';
  dom.loadingSub.textContent = state.docTitle;

  try {
    const bytes = new Uint8Array(arrayBuffer);
    if (!hasPdfMagicHeader(bytes)) {
      throw new Error('所載入的內容並非有效的 PDF 檔案（可能需要登入權限）。');
    }

    const loadingTask = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
    const pdfDoc = await loadingTask.promise;
    if (loadToken !== state.docLoadToken) {
      pdfDoc.destroy().catch(() => {});
      return;
    }

    state.pdfDoc = pdfDoc;
    state.numPages = pdfDoc.numPages;

    // Extract PDF metadata title if available
    try {
      const meta = await pdfDoc.getMetadata();
      const metaTitle = String(meta?.info?.Title || '').trim();
      if (metaTitle && metaTitle.length >= 3 && metaTitle.length <= 160) {
        state.docTitle = metaTitle;
        dom.docTitle.textContent = metaTitle;
        dom.docTitle.title = metaTitle;
        document.title = `${metaTitle} · NativeRead PDF`;
      }
    } catch (_) {}

    // Measure page 1 to compute comfortable 100% fit-width scale
    const firstPage = await pdfDoc.getPage(1);
    if (loadToken !== state.docLoadToken) return;

    const baseViewport = firstPage.getViewport({ scale: 1.0 });
    state.defaultPageWidth = baseViewport.width;
    state.defaultPageHeight = baseViewport.height;
    state.baseFitScale = computePageBaseFitScale(baseViewport.width, state.mode);
    state.zoom = 1.0;
    updateZoomUI();

    buildPageShells(pdfDoc.numPages, baseViewport.width, baseViewport.height);
    showStage('pages');
    updatePageIndicator(1);
    updateStatusBadge();
    setupObservers();
    window.scrollTo({ top: 0, behavior: 'instant' });
    syncCurrentPageFromViewport();
  } catch (err) {
    if (loadToken !== state.docLoadToken) return;
    console.error('[NativeRead PDF] Failed to open PDF:', err);
    showError(
      '無法解析此 PDF 文件',
      err?.message || 'PDF 檔案可能已損毀、受密碼保護，或需要網站登入權限。',
      Boolean(sourceUrl)
    );
  }
}

function showError(title, detail, canRetryUrl) {
  showStage('error');
  dom.errorTitle.textContent = title;
  dom.errorDetail.textContent = detail;
  dom.retryUrlBtn.hidden = !canRetryUrl;
  dom.pageIndicator.hidden = true;
  updateStatusBadge();
}

function abortActiveFetch() {
  if (state.activeFetchController) {
    try {
      state.activeFetchController.abort();
    } catch (_) {}
    state.activeFetchController = null;
  }
}

async function loadPdfFromUrl(rawUrl) {
  const normalizedUrl = typeof globalThis.KCTConfig?.resolvePdfSourceUrl === 'function'
    ? (globalThis.KCTConfig.resolvePdfSourceUrl(rawUrl) || rawUrl)
    : rawUrl;
  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch (_) {
    showError('PDF 連結格式無效', `無法辨識網址：${rawUrl}`, false);
    return;
  }

  const isFileUrl = parsed.protocol === 'file:';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && !isFileUrl) {
    showError('不支援的連結協定', '僅支援 http(s):// 連結，或請改用「開啟本機 PDF 檔案」。', false);
    return;
  }

  abortActiveFetch();
  const loadToken = ++state.docLoadToken;
  const controller = new AbortController();
  state.activeFetchController = controller;
  const fetchTimer = setTimeout(() => controller.abort(), 45000);

  state.sourceUrl = parsed.toString();
  showStage('loading');
  dom.loadingTitle.textContent = isFileUrl ? '正在讀取本機 PDF...' : '正在下載 PDF 文件...';
  dom.loadingSub.textContent = parsed.toString();

  try {
    let response;
    try {
      response = await fetch(parsed.toString(), { credentials: 'include', signal: controller.signal });
    } catch (innerErr) {
      if (controller.signal.aborted) throw innerErr;
      response = await fetch(parsed.toString(), { credentials: 'omit', signal: controller.signal });
    }

    if (loadToken !== state.docLoadToken) return;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    }
    const contentLen = Number(response.headers.get('Content-Length') || 0);
    if (contentLen > 100 * 1024 * 1024) {
      throw new Error('PDF 檔案超過 100 MB 上限，請下載後拆分再載入。');
    }

    const buffer = await response.arrayBuffer();
    if (loadToken !== state.docLoadToken) return;
    await openPdfFromArrayBuffer(buffer, {
      title: deriveFilenameFromUrl(parsed.toString()),
      host: isFileUrl ? 'local-pdf' : parsed.hostname,
      sourceUrl: isFileUrl ? '' : parsed.toString()
    });
  } catch (err) {
    if (loadToken !== state.docLoadToken) return;
    if (isFileUrl) {
      const fileName = deriveFilenameFromUrl(parsed.toString());
      showError(
        '請直接選擇本機 PDF 檔案',
        `無法直接讀取本機路徑（${fileName}）。請點擊下方「開啟本機 PDF 檔案」、拖曳檔案至此視窗，或於擴充功能設定啟用「允許存取檔案網址」。`,
        false
      );
      return;
    }
    showError(
      '無法從網址載入 PDF',
      `${err?.message || '網路或存取限制'}。若為需要登入的私密文件，請先下載後點選下方「開啟本機 PDF 檔案」。`,
      true
    );
  } finally {
    clearTimeout(fetchTimer);
    if (state.activeFetchController === controller) {
      state.activeFetchController = null;
    }
  }
}

async function loadPdfFromFile(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    showError('不支援的檔案格式', `「${file.name}」不是 PDF 檔案，請選擇 .pdf 文件。`, false);
    return;
  }

  abortActiveFetch();
  const loadToken = ++state.docLoadToken;
  showStage('loading');
  dom.loadingTitle.textContent = '正在讀取本機 PDF...';
  dom.loadingSub.textContent = file.name;

  try {
    const buffer = await file.arrayBuffer();
    if (loadToken !== state.docLoadToken) return;
    await openPdfFromArrayBuffer(buffer, {
      title: file.name.replace(/\.pdf$/i, ''),
      host: 'local-pdf',
      sourceUrl: ''
    });
  } catch (err) {
    if (loadToken !== state.docLoadToken) return;
    showError('無法讀取本機檔案', err?.message || '讀取檔案時發生錯誤。', false);
  }
}

// ============================================================
// Language Change & Zoom Re-layout
// ============================================================
async function handleTargetLanguageChange(newLang, { persist = true } = {}) {
  state.settings = { ...(state.settings || {}), targetLang: newLang };
  if (persist) {
    state.settings = await saveSettings({ targetLang: newLang });
  }
  if (!state.pdfDoc) return;

  state.translationEpoch += 1;
  cancelAllActiveStreams();
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
    pageRec.splitStatusEl.textContent = '重新翻譯中...';
  }

  updateStatusBadge();

  // Immediately re-translate visible/near-viewport pages (reusing rendered canvases!)
  const vh = window.innerHeight || 800;
  for (const pageRec of state.pages.values()) {
    const rect = pageRec.rowEl.getBoundingClientRect();
    const nearViewport = pageRec.isVisible || (rect.bottom >= -500 && rect.top <= vh + 500);
    if (nearViewport) {
      renderAndTranslatePage(pageRec.pageNum, { forceCanvas: false });
    }
  }
}

function applyZoom(nextZoom) {
  const clamped = Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], nextZoom));
  if (Math.abs(clamped - state.zoom) < 0.001) return;

  state.zoom = clamped;
  updateZoomUI();
  closeComparePopover();
  refreshPageShellsForCurrentScale();
}

function refreshPageShellsForCurrentScale() {
  if (!state.pdfDoc) return;

  const vh = window.innerHeight || 800;
  for (const pageRec of state.pages.values()) {
    const baseW = pageRec.baseWidth || state.defaultPageWidth || 612;
    const baseH = pageRec.baseHeight || state.defaultPageHeight || 792;
    pageRec.baseFitScale = computePageBaseFitScale(baseW, state.mode);
    const nextScale = pageRec.baseFitScale * state.zoom;

    pageRec.sheetEl.style.width = `${Math.round(baseW * nextScale)}px`;
    pageRec.sheetEl.style.height = `${Math.round(baseH * nextScale)}px`;

    const rect = pageRec.rowEl.getBoundingClientRect();
    const nearViewport = pageRec.isVisible || (rect.bottom >= -500 && rect.top <= vh + 500);
    if (nearViewport) {
      renderAndTranslatePage(pageRec.pageNum, { forceCanvas: true });
    } else {
      cancelPageRender(pageRec);
      pageRec.rendered = false;
      pageRec.renderedScale = 0;
      pageRec.loaderEl.hidden = false;
    }
  }
  scheduleSyncCurrentPage();
}

function stepZoom(direction) {
  let idx = ZOOM_STEPS.findIndex((v) => Math.abs(v - state.zoom) < 0.02);
  if (idx === -1) {
    idx = ZOOM_STEPS.findIndex((v) => v > state.zoom);
    if (idx === -1) idx = ZOOM_STEPS.length - 1;
  }
  const nextIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + direction));
  applyZoom(ZOOM_STEPS[nextIdx]);
}

// ============================================================
// Event Listeners & Initialization
// ============================================================
function bindEvents() {
  window.addEventListener('scroll', scheduleSyncCurrentPage, { passive: true });

  let resizeTimer = null;
  let lastWindowWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (!state.pdfDoc) return;
    if (Math.abs(window.innerWidth - lastWindowWidth) < 16) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      lastWindowWidth = window.innerWidth;
      if (!state.pdfDoc) return;
      const baseWidth = Math.max(120, state.defaultPageWidth || 612);
      const nextBaseFitScale = computePageBaseFitScale(baseWidth, state.mode);
      if (Math.abs(nextBaseFitScale - state.baseFitScale) > 0.015) {
        state.baseFitScale = nextBaseFitScale;
        closeComparePopover();
        refreshPageShellsForCurrentScale();
      } else {
        scheduleSyncCurrentPage();
      }
    }, 220);
  });

  // Mode segmented buttons
  dom.modeSegmented.addEventListener('click', (e) => {
    const btn = e.target.closest('.nr-seg-btn');
    if (!btn || !btn.dataset.mode) return;
    setMode(btn.dataset.mode);
  });

  // Target language selector
  dom.langSelect.addEventListener('change', () => {
    handleTargetLanguageChange(dom.langSelect.value);
  });

  // Zoom controls
  dom.zoomOutBtn.addEventListener('click', () => stepZoom(-1));
  dom.zoomInBtn.addEventListener('click', () => stepZoom(1));
  dom.zoomResetBtn.addEventListener('click', () => applyZoom(1.0));

  // Local PDF file picker triggers
  const triggerFilePicker = () => {
    dom.fileInput.value = '';
    dom.fileInput.click();
  };
  dom.openFileBtn.addEventListener('click', triggerFilePicker);
  dom.emptyOpenBtn.addEventListener('click', triggerFilePicker);
  dom.errorOpenFileBtn.addEventListener('click', triggerFilePicker);

  dom.fileInput.addEventListener('change', () => {
    const file = dom.fileInput.files?.[0];
    if (file) {
      loadPdfFromFile(file);
    }
  });

  // URL form & retry
  dom.urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = dom.urlInput.value.trim();
    if (val) {
      loadPdfFromUrl(val);
    }
  });

  dom.retryUrlBtn.addEventListener('click', () => {
    if (state.sourceUrl) {
      loadPdfFromUrl(state.sourceUrl);
    }
  });

  // Settings & Error quick action
  const openOptions = () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {});
  };
  dom.settingsBtn.addEventListener('click', openOptions);
  dom.statusActionBtn.addEventListener('click', openOptions);

  // Compare popover controls
  dom.compareCloseBtn.addEventListener('click', closeComparePopover);
  dom.comparePopover.addEventListener('click', (e) => e.stopPropagation());

  const copyWithFeedback = async (btn, text) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = '已複製';
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    } catch (_) {}
  };

  dom.copyOrigBtn.addEventListener('click', () => {
    copyWithFeedback(dom.copyOrigBtn, state.activeComparePara?.orig || '');
  });

  dom.copyTransBtn.addEventListener('click', () => {
    copyWithFeedback(dom.copyTransBtn, state.activeComparePara?.trans || '');
  });

  document.addEventListener('click', () => {
    if (!dom.comparePopover.hidden) {
      closeComparePopover();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dom.comparePopover.hidden) {
      closeComparePopover();
      return;
    }
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === '1') setMode('overlay');
    else if (e.key === '2') setMode('split');
    else if (e.key === '3') setMode('original');
    else if (e.key === '+' || e.key === '=') {
      if (!e.metaKey && !e.ctrlKey) stepZoom(1);
    } else if (e.key === '-') {
      if (!e.metaKey && !e.ctrlKey) stepZoom(-1);
    } else if (e.key === '0') {
      if (!e.metaKey && !e.ctrlKey) applyZoom(1.0);
    }
  });

  // Global drag-and-drop for local PDF files
  const hasFiles = (dt) => Array.from(dt?.types || []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    state.dragDepth += 1;
    dom.dragOverlay.hidden = false;
  });

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) {
      dom.dragOverlay.hidden = true;
    }
  });

  window.addEventListener('drop', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    state.dragDepth = 0;
    dom.dragOverlay.hidden = true;
    const file = Array.from(e.dataTransfer.files || []).find(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    );
    if (file) {
      loadPdfFromFile(file);
    }
  });

  window.addEventListener('pagehide', () => {
    abortActiveFetch();
    cancelAllActiveStreams();
    disconnectObservers();
    for (const pageRec of state.pages.values()) {
      cancelPageRender(pageRec);
    }
    if (state.streamPort) {
      try {
        state.streamPort.disconnect();
      } catch (_) {}
      state.streamPort = null;
    }
    if (state.pdfDoc) {
      state.pdfDoc.destroy().catch(() => {});
      state.pdfDoc = null;
    }
  });

  // Sync settings updates from Options page (e.g., user enters API Key, switches model/lang/glossary)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;
    const nextSettings = changes[SETTINGS_KEY].newValue;
    if (!nextSettings) return;
    const prev = state.settings;
    const hadError = Boolean(state.lastError);
    state.settings = nextSettings;
    populateLanguageSelect(nextSettings.targetLang || 'zh-TW');

    const needsRetranslate = Boolean(
      prev && (
        nextSettings.targetLang !== prev.targetLang ||
        nextSettings.customTargetLang !== prev.customTargetLang ||
        nextSettings.model !== prev.model ||
        nextSettings.protocol !== prev.protocol ||
        nextSettings.customGlossary !== prev.customGlossary
      )
    );

    if (state.pdfDoc && needsRetranslate) {
      handleTargetLanguageChange(nextSettings.targetLang || 'zh-TW', { persist: false });
    } else if (state.pdfDoc && hadError) {
      state.lastError = '';
      state.lastErrorCode = '';
      updateStatusBadge();
      for (const pageRec of state.pages.values()) {
        if (pageRec.isVisible && pageRec.translatedEpoch !== state.translationEpoch) {
          renderAndTranslatePage(pageRec.pageNum, { forceCanvas: false });
        }
      }
    }
  });
}

async function init() {
  state.settings = await getSettings();
  populateLanguageSelect(state.settings.targetLang || 'zh-TW');
  setMode('overlay');
  updateZoomUI();
  updateStatusBadge();
  bindEvents();

  const params = new URLSearchParams(window.location.search);
  const srcParam = params.get('src');
  if (srcParam && srcParam.trim()) {
    await loadPdfFromUrl(srcParam.trim());
  } else {
    showStage('empty');
  }
}

init();
