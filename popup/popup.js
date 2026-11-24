const {
  SETTINGS_KEY,
  PROVIDER_PRESETS,
  TARGET_LANGUAGES,
  getSettings,
  saveSettings,
  isHostWhitelisted,
  toggleHostWhitelist,
  isInjectableUrl,
  isPdfUrl,
  resolveAssociatedPdfUrl,
  isLocalEndpoint,
  validateApiKey,
  resolveFallbackSettings,
  listSavedProviders,
  switchActiveProviderSettings,
  formatApiError
} = globalThis.KCTConfig;

// Shortcut label shown in the UI: the shortcut actually configured in the browser
// (on macOS Chrome reports Alt as ⌥ Option, e.g. "⌥T"); empty when the user removed it.
const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
let shortcutLabel = IS_MAC ? '⌥T' : 'Alt+T';

async function loadShortcutLabel() {
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === 'toggle-translate-page');
    if (cmd) shortcutLabel = String(cmd.shortcut || '').trim();
  } catch (_) {
    // keep the platform default
  }
}

function idleStatusText() {
  return shortcutLabel ? `待命 · ${shortcutLabel} 翻譯` : '待命 · 可於 chrome://extensions/shortcuts 設定快捷鍵';
}
const PDF_READY_STATUS_TEXT = '偵測到 PDF 文件';
const PDF_OPENED_STATUS_TEXT = '已開啟 PDF 閱讀器';
const UNSUPPORTED_STATUS_TEXT = '此頁面不支援翻譯';

let currentSettings = null;
let activeTab = null;
let activeHost = '';
let activeTabInjectable = false;
let activeTabIsPdf = false;
let lastKnownTranslated = 0;

let saveQueue = Promise.resolve();
let customTimer = null;
let customLangDirty = false;
let pendingCustomFlushCount = 0;

function enqueueSave(taskFn) {
  const run = saveQueue.then(() => taskFn());
  saveQueue = run.catch(() => {});
  return run;
}

function hasPendingCustomLangEdit(customInput) {
  return Boolean(
    customInput && (
      document.activeElement === customInput ||
      customLangDirty ||
      customTimer !== null ||
      pendingCustomFlushCount > 0
    )
  );
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function extractHostname(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname || '';
  } catch (_) {
    return '';
  }
}

function setStatusText(text, title = '') {
  const statusEl = document.getElementById('status-text');
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.title = title || text;
}

function shortProviderLabel(providerId) {
  const raw = PROVIDER_PRESETS?.[providerId]?.label || providerId || '';
  return String(raw).split(/[（(]/)[0].trim() || providerId;
}

function clearErrorBanner() {
  const banner = document.getElementById('error-banner');
  if (!banner) return;
  banner.replaceChildren();
  banner.classList.add('hidden');
}

let activePollToken = 0;
let activePollTimer = null;

function cancelActivePoll() {
  activePollToken += 1;
  if (activePollTimer) {
    clearTimeout(activePollTimer);
    activePollTimer = null;
  }
}

window.addEventListener('pagehide', cancelActivePoll);

function renderErrorBanner(rawErrorMsg, settings, errorCode = '') {
  const banner = document.getElementById('error-banner');
  const fmt = typeof formatApiError === 'function'
    ? formatApiError(rawErrorMsg)
    : { shortMsg: '翻譯失敗', detailMsg: String(rawErrorMsg || '翻譯失敗'), rawMsg: String(rawErrorMsg || ''), retryable: true, suggestSwitch: true };

  if (!banner) return fmt;
  banner.replaceChildren();

  const msgEl = document.createElement('div');
  msgEl.className = 'error-banner-msg';
  msgEl.textContent = fmt.detailMsg;
  if (fmt.rawMsg) msgEl.title = fmt.rawMsg;
  banner.appendChild(msgEl);

  const actionsEl = document.createElement('div');
  actionsEl.className = 'error-banner-actions';
  const isNonProviderError = errorCode === 'UNSUPPORTED_URL' || errorCode === 'PAGE_ERROR';

  if (fmt.retryable && activeTabInjectable && !activeTabIsPdf && errorCode !== 'UNSUPPORTED_URL') {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'mini-action-btn primary-mini';
    retryBtn.textContent = '重試未譯段落';
    retryBtn.addEventListener('click', () => {
      clearErrorBanner();
      void sendCommandToActiveTab('TRANSLATE_NOW');
    });
    actionsEl.appendChild(retryBtn);
  }

  if (!isNonProviderError) {
    const saved = typeof listSavedProviders === 'function' ? listSavedProviders(settings || currentSettings) : [];
    const readyCount = saved.filter((p) => p.isReady).length;
    const alt = saved.find((p) => !p.isActive && p.isReady);
    if (alt && fmt.suggestSwitch) {
      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'mini-action-btn';
      switchBtn.textContent = `改用 ${shortProviderLabel(alt.providerId)}`;
      switchBtn.addEventListener('click', () => {
        void switchProviderFromPopup(alt.providerId);
      });
      actionsEl.appendChild(switchBtn);
    }

    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'mini-action-btn';
    manageBtn.textContent = readyCount > 2 ? '其他供應商' : '設定供應商';
    manageBtn.addEventListener('click', () => {
      if (readyCount > 2) {
        const sel = document.getElementById('provider-quick-select');
        if (sel) {
          try {
            if (typeof sel.showPicker === 'function') {
              sel.showPicker();
            } else {
              sel.focus();
            }
          } catch (_) {
            sel.focus();
          }
          return;
        }
      }
      void chrome.runtime.openOptionsPage();
    });
    actionsEl.appendChild(manageBtn);
  }

  if (actionsEl.childElementCount > 0) {
    banner.appendChild(actionsEl);
  }
  banner.classList.remove('hidden');
  return fmt;
}

function renderProviderQuickSelect(settings) {
  const sel = document.getElementById('provider-quick-select');
  if (!sel || typeof listSavedProviders !== 'function') return;
  const items = listSavedProviders(settings);
  sel.replaceChildren();
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.providerId;
    const baseName = shortProviderLabel(item.providerId);
    const modelPart = item.model || '未選模型';
    const tag = item.isFallback ? ' [備援]' : (!item.isReady ? ' [待設定]' : '');
    opt.textContent = `${baseName} · ${modelPart}${tag}`;
    sel.appendChild(opt);
  }
  const manageOpt = document.createElement('option');
  manageOpt.value = '__manage__';
  manageOpt.textContent = '＋ 新增或管理供應商...';
  sel.appendChild(manageOpt);
  sel.value = settings?.providerId || (items[0]?.providerId || 'gemini');
}

async function switchProviderFromPopup(targetProviderId) {
  if (!targetProviderId || typeof switchActiveProviderSettings !== 'function') return;
  const hadErrorBanner = !document.getElementById('error-banner')?.classList.contains('hidden');
  let didSwitch = false;
  const next = await enqueueSave(async () => {
    const fresh = typeof getSettings === 'function' ? await getSettings() : currentSettings;
    if (!fresh || targetProviderId === fresh.providerId) {
      if (fresh) {
        currentSettings = fresh;
        renderUI(fresh);
      }
      return fresh;
    }
    const switched = switchActiveProviderSettings(fresh, targetProviderId);
    const saved = await saveSettings({
      providerId: switched.providerId,
      protocol: switched.protocol,
      baseUrl: switched.baseUrl,
      apiKey: switched.apiKey,
      model: switched.model,
      thinkingEffort: switched.thinkingEffort,
      providerProfiles: switched.providerProfiles,
      fallbackProviderId: switched.fallbackProviderId,
    });
    currentSettings = saved;
    renderUI(saved);
    didSwitch = true;
    return saved;
  });
  if (!didSwitch || !next) return;
  clearErrorBanner();
  setStatusText(`已切換至 ${shortProviderLabel(next.providerId)} (${next.model || '預設'})`);
  const hasReadyCreds = Boolean(next.apiKey) || Boolean(window.KCTConfig?.isLocalEndpoint?.(next.baseUrl));
  if (hadErrorBanner && activeTabInjectable && !activeTabIsPdf && hasReadyCreds) {
    setTimeout(() => {
      void queryActiveTabStatus();
    }, 650);
  }
}

function setActionButtonsDisabled(disabled) {
  for (const id of ['btn-translate-now', 'btn-retranslate', 'btn-clear-page']) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  }
}

function updateActionButtonsForTab() {
  const primaryBtn = document.getElementById('btn-translate-now');
  const retranslateBtn = document.getElementById('btn-retranslate');
  const clearBtn = document.getElementById('btn-clear-page');

  if (activeTabIsPdf) {
    if (primaryBtn) {
      primaryBtn.disabled = false;
      primaryBtn.textContent = '開啟 PDF 原版翻譯';
    }
    if (retranslateBtn) retranslateBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    return;
  }

  if (primaryBtn) {
    primaryBtn.textContent = shortcutLabel ? `立即翻譯此頁面 (${shortcutLabel})` : '立即翻譯此頁面';
  }
  setActionButtonsDisabled(!activeTabInjectable);
}

function renderSiteBar(settings) {
  const siteBar = document.getElementById('site-bar');
  const hostEl = document.getElementById('site-host');
  const dotEl = document.getElementById('site-dot');
  const autoCheck = document.getElementById('toggle-site-auto');
  const autoLabel = document.getElementById('site-auto-label');
  if (!siteBar || !hostEl || !dotEl || !autoCheck || !autoLabel) return;

  if (activeTabIsPdf) {
    siteBar.classList.add('disabled');
    hostEl.textContent = activeHost ? `${activeHost} · PDF` : '本機 PDF 文件';
    hostEl.title = activeTab?.url || '';
    dotEl.classList.add('active');
    autoCheck.checked = false;
    autoCheck.disabled = true;
    autoLabel.classList.remove('is-checked');
    return;
  }

  if (!activeTabInjectable || !activeHost) {
    siteBar.classList.add('disabled');
    hostEl.textContent = '系統內部頁面';
    hostEl.title = activeTab?.url || '';
    dotEl.classList.remove('active');
    autoCheck.checked = false;
    autoCheck.disabled = true;
    autoLabel.classList.remove('is-checked');
    return;
  }

  siteBar.classList.remove('disabled');
  hostEl.textContent = activeHost;
  hostEl.title = activeHost;
  autoCheck.disabled = false;

  const whitelisted = isHostWhitelisted(activeHost, settings);
  autoCheck.checked = Boolean(whitelisted);
  dotEl.classList.toggle('active', Boolean(whitelisted));
  autoLabel.classList.toggle('is-checked', Boolean(whitelisted));
}

function renderUI(settings) {
  const codeCommentsEl = document.getElementById('toggle-code-comments');
  if (codeCommentsEl) codeCommentsEl.checked = settings.translateCodeComments !== false;
  const selectionEl = document.getElementById('toggle-selection');
  if (selectionEl) selectionEl.checked = settings.selectionTranslate !== false;
  const ballEl = document.getElementById('toggle-ball');
  if (ballEl) ballEl.checked = settings.showFloatingBall !== false;

  const langSel = document.getElementById('lang-select');
  if (langSel) langSel.value = settings.targetLang || 'zh-TW';
  const customInput = document.getElementById('custom-lang-input');
  if (customInput) {
    if (!hasPendingCustomLangEdit(customInput)) {
      customInput.value = settings.customTargetLang || '';
    }
    customInput.classList.toggle('hidden', langSel?.value !== 'custom');
  }

  const isLocal = typeof isLocalEndpoint === 'function'
    ? isLocalEndpoint(settings.baseUrl)
    : false;
  const hasKey = Boolean(settings.apiKey?.trim()) || isLocal;
  document.getElementById('api-alert')?.classList.toggle('hidden', hasKey);
  const modelBadge = document.getElementById('model-badge');
  if (modelBadge) {
    const modelName = settings.model || '未選擇模型';
    const fbSettings = typeof resolveFallbackSettings === 'function'
      ? resolveFallbackSettings(settings)
      : null;
    modelBadge.textContent = fbSettings
      ? `${modelName} · 備援: ${shortProviderLabel(fbSettings.providerId)}`
      : modelName;
    modelBadge.title = modelBadge.textContent;
  }

  renderProviderQuickSelect(settings);

  for (const btn of document.querySelectorAll('#mode-group button')) {
    const active = btn.dataset.mode === settings.displayMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  for (const btn of document.querySelectorAll('#scope-group button')) {
    const active = btn.dataset.scope === settings.scope;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  renderSiteBar(settings);
}

async function queryActiveTabStatus() {
  if (!activeTab || !activeTabInjectable) {
    setStatusText(UNSUPPORTED_STATUS_TEXT);
    return null;
  }
  try {
    const res = await chrome.tabs.sendMessage(
      activeTab.id,
      { type: 'KCT_GET_STATUS' },
      { frameId: 0 }
    );
    if (!res?.ok) {
      lastKnownTranslated = 0;
      setStatusText(idleStatusText());
      return null;
    }
    lastKnownTranslated = Number(res.totalTranslated) || 0;
    if (res.lastErrorMsg) {
      const fmt = renderErrorBanner(res.lastErrorMsg, currentSettings);
      setStatusText(fmt.shortMsg, fmt.rawMsg || fmt.detailMsg);
    } else if (res.isBusy) {
      clearErrorBanner();
      setStatusText(`翻譯中 ${res.totalTranslated}/${res.totalDetected}`);
    } else if (!currentSettings?.enabled) {
      clearErrorBanner();
      setStatusText('已暫停，點擊上方按鈕即可翻譯');
    } else if (res.totalTranslated > 0) {
      clearErrorBanner();
      setStatusText(`已譯 ${res.totalTranslated} 項`);
    } else {
      clearErrorBanner();
      setStatusText(idleStatusText());
    }
    return res;
  } catch (_) {
    // Uninjected tab is normal in on-demand mode
    lastKnownTranslated = 0;
    setStatusText(idleStatusText());
    return null;
  }
}

async function openPdfViewerFromPopup(pdfUrl = '', { detectFromTab = false } = {}) {
  try {
    const payload = { type: 'OPEN_PDF_VIEWER' };
    if (pdfUrl) payload.url = pdfUrl;
    if (detectFromTab) payload.detectFromTab = true;
    if (typeof activeTab?.id === 'number') payload.tabId = activeTab.id;
    const res = await chrome.runtime.sendMessage(payload);
    if (res?.ok) {
      setStatusText(PDF_OPENED_STATUS_TEXT);
      window.close();
    } else {
      setStatusText(res?.error || '無法開啟 PDF 閱讀器');
    }
  } catch (err) {
    setStatusText(err?.message || '無法開啟 PDF 閱讀器');
  }
}

async function sendCommandToActiveTab(action) {
  const tab = await getActiveTab();
  activeTab = tab;
  activeTabIsPdf = Boolean(tab && isPdfUrl(tab.url));
  activeTabInjectable = Boolean(tab && isInjectableUrl(tab.url));
  activeHost = activeTabInjectable ? extractHostname(tab.url) : '';
  updateActionButtonsForTab();

  if (activeTabIsPdf) {
    if (action !== 'CLEAR_PAGE') {
      await openPdfViewerFromPopup(tab.url);
    }
    return;
  }

  if (!tab || !activeTabInjectable) {
    setActionButtonsDisabled(true);
    setStatusText(UNSUPPORTED_STATUS_TEXT);
    return;
  }

  if ((action === 'TRANSLATE_NOW' || action === 'RETRANSLATE') && currentSettings && !currentSettings.enabled) {
    await enqueueSave(async () => {
      if (currentSettings && !currentSettings.enabled) {
        const next = await saveSettings({ enabled: true });
        currentSettings = next;
        renderUI(next);
      }
    });
  }

  cancelActivePoll();
  if (action === 'CLEAR_PAGE') {
    setStatusText('正在還原原文...');
  } else {
    setStatusText('正在啟動翻譯...');
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ENSURE_AND_COMMAND',
      tabId: tab.id,
      action
    });

    if (!res?.ok) {
      const errMsg = res?.error || '無法執行翻譯指令';
      const fmt = renderErrorBanner(errMsg, currentSettings, res?.errorCode || 'PAGE_ERROR');
      setStatusText(fmt.shortMsg, errMsg);
      return;
    }

    clearErrorBanner();

    if (res.openedPdfViewer) {
      setStatusText(PDF_OPENED_STATUS_TEXT);
      window.close();
      return;
    }

    if (action === 'CLEAR_PAGE') {
      lastKnownTranslated = 0;
      setStatusText('已還原原文');
      return;
    }

    setStatusText('已啟動翻譯，掃描中...');

    const pollToken = ++activePollToken;
    const pollStatus = async (attempt = 0) => {
      if (pollToken !== activePollToken) return;
      try {
        const st = await chrome.tabs.sendMessage(
          tab.id,
          { type: 'KCT_GET_STATUS' },
          { frameId: 0 }
        );
        if (pollToken !== activePollToken || !st?.ok) return;
        lastKnownTranslated = Number(st.totalTranslated) || 0;
        if (st.lastErrorMsg) {
          const fmt = renderErrorBanner(st.lastErrorMsg, currentSettings);
          setStatusText(fmt.shortMsg, fmt.rawMsg || fmt.detailMsg);
        } else if (st.isBusy) {
          setStatusText(`翻譯中 ${st.totalTranslated}/${st.totalDetected}`);
          if (attempt < 40) {
            activePollTimer = setTimeout(() => { void pollStatus(attempt + 1); }, 850);
          }
        } else if (st.totalTranslated > 0) {
          setStatusText(`已譯 ${st.totalTranslated} 項`);
        } else if (st.totalDetected === 0 && currentSettings?.scope === 'course') {
          setStatusText('無主文，可試「整頁文字」');
        } else {
          setStatusText('目前頁面無新增可譯段落');
        }
      } catch (_) {}
    };

    activePollTimer = setTimeout(() => { void pollStatus(0); }, 320);
  } catch (err) {
    setStatusText(err?.message || '無法連線背景服務，請重試');
  }
}

// popup/popup.js — helper functions + checkForExtensionUpdate
const UPDATE_CACHE_KEY = 'nr_update_check_v1';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_FETCH_TIMEOUT_MS = 5000;
const UPDATE_VERSION_URL = 'https://chih-kai-wang.github.io/native-read/version.json';
const UPDATE_README_URL = 'https://github.com/Chih-Kai-Wang/native-read#readme';
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function compareSemver(a, b) {
  if (!SEMVER_RE.test(a) || !SEMVER_RE.test(b)) return 0;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function renderUpdateBanner(latest, current) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;

  banner.replaceChildren();

  const text = document.createElement('span');
  text.textContent = `有新版本 v${latest}（目前 v${current}）`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link-btn';
  btn.textContent = '查看更新';
  btn.addEventListener('click', () => {
    chrome.tabs.create({ url: UPDATE_README_URL });
  });

  banner.appendChild(text);
  banner.appendChild(btn);
  banner.classList.remove('hidden');
}

async function checkForExtensionUpdate(settings) {
  if (settings && settings.checkForUpdates === false) return;

  const current = chrome.runtime.getManifest().version;
  if (!SEMVER_RE.test(current)) return;

  const stored = await chrome.storage.local.get(UPDATE_CACHE_KEY);
  const entry = stored && stored[UPDATE_CACHE_KEY];
  const prevLatest = entry && typeof entry.latest === 'string' && SEMVER_RE.test(entry.latest)
    ? entry.latest
    : '';
  const checkedAt = entry && typeof entry.checkedAt === 'number' ? entry.checkedAt : 0;
  const now = Date.now();
  const isFresh = checkedAt > 0 && now >= checkedAt && (now - checkedAt) < UPDATE_CHECK_INTERVAL_MS;

  let latest = prevLatest;

  if (!isFresh) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(UPDATE_VERSION_URL, {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data || typeof data.version !== 'string' || !SEMVER_RE.test(data.version)) {
        throw new Error('Invalid version');
      }
      latest = data.version;
      await chrome.storage.local.set({
        [UPDATE_CACHE_KEY]: { checkedAt: Date.now(), latest }
      });
    } catch {
      await chrome.storage.local.set({
        [UPDATE_CACHE_KEY]: {
          checkedAt: Date.now() - UPDATE_CHECK_INTERVAL_MS + 60 * 60 * 1000,
          latest: prevLatest
        }
      }).catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }

  if (latest && compareSemver(latest, current) > 0) {
    renderUpdateBanner(latest, current);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadShortcutLabel();
  const langSel = document.getElementById('lang-select');
  for (const lang of Object.values(TARGET_LANGUAGES)) {
    const opt = document.createElement('option');
    opt.value = lang.id;
    opt.textContent = lang.label;
    langSel.appendChild(opt);
  }

  activeTab = await getActiveTab();
  activeTabIsPdf = Boolean(activeTab && isPdfUrl(activeTab.url));
  activeTabInjectable = Boolean(activeTab && isInjectableUrl(activeTab.url));
  activeHost = activeTabInjectable ? extractHostname(activeTab.url) : '';

  let settings = await enqueueSave(async () => {
    const initial = await getSettings();
    if (initial.enabled === false) {
      return saveSettings({ enabled: true });
    }
    return initial;
  });
  currentSettings = settings;
  renderUI(settings);
  updateActionButtonsForTab();

  const updateSavedSettings = (next) => {
    settings = next;
    currentSettings = next;
    renderUI(next);
  };
  const settingsKey = SETTINGS_KEY || 'kct_settings_v1';
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[settingsKey]?.newValue) return;
    updateSavedSettings(changes[settingsKey].newValue);
  });

  if (activeTabIsPdf) {
    setStatusText(PDF_READY_STATUS_TEXT);
  } else if (!activeTabInjectable) {
    setStatusText(UNSUPPORTED_STATUS_TEXT);
  } else {
    const assocPdfUrl = typeof resolveAssociatedPdfUrl === 'function'
      ? resolveAssociatedPdfUrl(activeTab?.url || '')
      : '';
    const pdfBtn = document.getElementById('btn-open-pdf');
    if (assocPdfUrl && pdfBtn) {
      pdfBtn.textContent = '開啟此篇 PDF ↗';
      pdfBtn.title = '直接開啟並翻譯此頁論文 PDF，無需下載';
    }
    await queryActiveTabStatus();
  }

  const customLangEl = document.getElementById('custom-lang-input');
  const flushCustomLang = async () => {
    if (customTimer) {
      clearTimeout(customTimer);
      customTimer = null;
    }
    if (!customLangEl) return;
    pendingCustomFlushCount += 1;
    try {
      await enqueueSave(async () => {
        const trimmed = customLangEl.value.trim();
        if (trimmed !== (currentSettings?.customTargetLang || '')) {
          const next = await saveSettings({ customTargetLang: trimmed });
          settings = next;
          currentSettings = next;
        }
        if (customLangEl.value.trim() === (currentSettings?.customTargetLang || '')) {
          customLangDirty = false;
        }
      });
    } finally {
      pendingCustomFlushCount = Math.max(0, pendingCustomFlushCount - 1);
    }
  };

  document.getElementById('toggle-site-auto')?.addEventListener('change', async () => {
    if (!activeTabInjectable || !activeHost) return;
    await flushCustomLang();
    const next = await enqueueSave(async () => {
      const res = await toggleHostWhitelist(activeHost);
      const saved = res?.settings || await getSettings();
      updateSavedSettings(saved);
      return saved;
    });

    const nowWhitelisted = isHostWhitelisted(activeHost, next);
    if (nowWhitelisted) {
      setStatusText(`已自動翻譯：${activeHost}`);
      if (lastKnownTranslated === 0) {
        await flushCustomLang();
        await sendCommandToActiveTab('TRANSLATE_NOW');
      }
    } else {
      setStatusText('已移出白名單');
    }
  });

  document.getElementById('provider-quick-select')?.addEventListener('change', async (e) => {
    const val = e.target.value;
    if (val === '__manage__') {
      e.target.value = currentSettings?.providerId || 'gemini';
      await chrome.runtime.openOptionsPage();
      return;
    }
    await switchProviderFromPopup(val);
  });

  langSel?.addEventListener('change', async (e) => {
    const targetLang = e.target.value;
    await enqueueSave(async () => {
      updateSavedSettings(await saveSettings({ targetLang }));
    });
  });

  customLangEl?.addEventListener('input', () => {
    customLangDirty = true;
    if (customTimer) clearTimeout(customTimer);
    customTimer = setTimeout(() => {
      customTimer = null;
      void flushCustomLang();
    }, 350);
  });
  customLangEl?.addEventListener('change', flushCustomLang);
  customLangEl?.addEventListener('blur', flushCustomLang);

  document.getElementById('toggle-code-comments')?.addEventListener('change', async (e) => {
    const translateCodeComments = e.target.checked;
    await enqueueSave(async () => {
      updateSavedSettings(await saveSettings({ translateCodeComments }));
    });
  });

  document.getElementById('toggle-selection')?.addEventListener('change', async (e) => {
    const selectionTranslate = e.target.checked;
    await enqueueSave(async () => {
      updateSavedSettings(await saveSettings({ selectionTranslate }));
    });
  });

  document.getElementById('toggle-ball')?.addEventListener('change', async (e) => {
    const showFloatingBall = e.target.checked;
    await enqueueSave(async () => {
      updateSavedSettings(await saveSettings({ showFloatingBall }));
    });
  });

  for (const btn of document.querySelectorAll('#mode-group button')) {
    btn.addEventListener('click', async () => {
      const displayMode = btn.dataset.mode;
      await enqueueSave(async () => {
        updateSavedSettings(await saveSettings({ displayMode }));
      });
    });
  }

  for (const btn of document.querySelectorAll('#scope-group button')) {
    btn.addEventListener('click', async () => {
      const scope = btn.dataset.scope;
      await enqueueSave(async () => {
        updateSavedSettings(await saveSettings({ scope }));
      });
    });
  }

  document.getElementById('btn-translate-now')?.addEventListener('click', async () => {
    await flushCustomLang();
    if (activeTabIsPdf && activeTab?.url) {
      await openPdfViewerFromPopup(activeTab.url);
      return;
    }
    await sendCommandToActiveTab('TRANSLATE_NOW');
  });

  document.getElementById('btn-retranslate')?.addEventListener('click', async () => {
    await flushCustomLang();
    await sendCommandToActiveTab('RETRANSLATE');
  });

  document.getElementById('btn-clear-page')?.addEventListener('click', async () => {
    await sendCommandToActiveTab('CLEAR_PAGE');
  });

  document.getElementById('btn-open-pdf')?.addEventListener('click', async () => {
    const resolvedPdfUrl =
      (typeof resolveAssociatedPdfUrl === 'function' ? resolveAssociatedPdfUrl(activeTab?.url || '') : '') ||
      (typeof globalThis.KCTConfig?.resolvePdfSourceUrl === 'function'
        ? globalThis.KCTConfig.resolvePdfSourceUrl(activeTab?.url || '')
        : '');
    await openPdfViewerFromPopup(resolvedPdfUrl, { detectFromTab: !resolvedPdfUrl && activeTabInjectable });
  });

  const openOptions = async () => {
    await chrome.runtime.openOptionsPage();
  };
  document.getElementById('btn-open-options')?.addEventListener('click', openOptions);
  document.getElementById('btn-go-config')?.addEventListener('click', openOptions);

  // Fire-and-forget: at most one GitHub Pages check per day, only while the popup is open
  checkForExtensionUpdate(settings).catch(() => {});
});
