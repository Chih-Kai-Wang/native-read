const {
  SETTINGS_KEY,
  PROVIDER_PRESETS,
  TARGET_LANGUAGES,
  DEFAULT_GLOSSARY,
  getSettings,
  saveSettings,
  resolveEndpoint,
  resolveStreamEndpoint,
  isLocalEndpoint,
  sanitizeApiKey,
  validateApiKey,
  normalizeProviderProfiles,
  isProfileSaved,
  listSavedProviders,
  switchActiveProviderSettings,
  removeProviderProfile
} = globalThis.KCTConfig;

let whitelistHosts = [];
let lastSyncUrl = '';
let draftProfiles = {};
let persistedActiveProviderId = 'gemini';
let currentProviderId = 'gemini';
let selectedFallbackProviderId = '';
let saveStatusTimer = null;
let listModelsSeq = 0;
let testConnSeq = 0;
let chipSwitchSeq = 0;
let whitelistQueue = Promise.resolve();
let isProviderFormDirty = false;
let applyingExternalStorage = false;

function normalizeHostInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  let host = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch (_) {
      return '';
    }
  } else {
    host = host.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  }
  host = host.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host) return '';
  if (host !== 'localhost' && (!host.includes('.') || !/^[a-z0-9.-]+$/i.test(host))) {
    return '';
  }
  return host;
}

function renderWhitelist() {
  const container = document.getElementById('whitelist-list');
  if (!container) return;
  container.textContent = '';

  if (!whitelistHosts.length) {
    const empty = document.createElement('span');
    empty.className = 'host-empty';
    empty.textContent = '目前尚未加入任何自動翻譯網站';
    container.appendChild(empty);
    return;
  }

  for (const host of whitelistHosts) {
    const chip = document.createElement('span');
    chip.className = 'host-chip';

    const text = document.createElement('span');
    text.textContent = host;
    chip.appendChild(text);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'host-chip-remove';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', `移除 ${host}`);
    removeBtn.title = `移除 ${host}`;
    removeBtn.addEventListener('click', () => {
      whitelistQueue = whitelistQueue.then(async () => {
        try {
          const latest = await getSettings();
          const current = Array.isArray(latest.autoTranslateHosts) ? latest.autoTranslateHosts : whitelistHosts;
          whitelistHosts = current
            .map((h) => normalizeHostInput(h))
            .filter((h) => h && h !== host);
          renderWhitelist();
          await saveSettings({ autoTranslateHosts: [...whitelistHosts] });
          const fb = document.getElementById('whitelist-feedback');
          if (fb) fb.textContent = `已移除 ${host}`;
        } catch (err) {
          const fb = document.getElementById('whitelist-feedback');
          if (fb) fb.textContent = `移除失敗：${err?.message || '儲存失敗'}`;
        }
      });
    });

    chip.appendChild(removeBtn);
    container.appendChild(chip);
  }
}

async function handleAddHost() {
  const input = document.getElementById('whitelist-host-input');
  const fb = document.getElementById('whitelist-feedback');
  if (!input || !fb) return;
  const normalized = normalizeHostInput(input.value);

  if (!normalized) {
    fb.textContent = '請輸入有效網域名稱，例如 www.kaggle.com';
    return;
  }

  input.value = '';
  whitelistQueue = whitelistQueue.then(async () => {
    try {
      const latest = await getSettings();
      const existing = Array.isArray(latest.autoTranslateHosts)
        ? [...new Set(latest.autoTranslateHosts.map((h) => normalizeHostInput(h)).filter(Boolean))]
        : [...whitelistHosts];
      if (existing.includes(normalized)) {
        whitelistHosts = existing;
        renderWhitelist();
        fb.textContent = `${normalized} 已在白名單中`;
        return;
      }
      whitelistHosts = [...existing, normalized];
      renderWhitelist();
      await saveSettings({ autoTranslateHosts: [...whitelistHosts] });
      fb.textContent = `已加入白名單：${normalized}`;
    } catch (err) {
      fb.textContent = `加入失敗：${err?.message || '儲存失敗'}`;
    }
  });
  await whitelistQueue;
}

function normalizeApiKeyValue(raw) {
  if (typeof sanitizeApiKey === 'function') {
    return sanitizeApiKey(raw);
  }
  return String(raw || '').trim().replace(/^Bearer\s+/i, '').trim();
}

function checkLocalEndpoint(baseUrl) {
  if (typeof isLocalEndpoint === 'function') {
    return isLocalEndpoint(baseUrl);
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(String(baseUrl || '').trim());
}

function showSaveStatus(message, isError = false, durationMs = 2800) {
  const statusEl = document.getElementById('save-status');
  if (!statusEl) return;
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer);
    saveStatusTimer = null;
  }
  statusEl.className = isError ? 'inline-status err' : 'inline-status ok';
  statusEl.textContent = message;
  if (durationMs > 0) {
    saveStatusTimer = setTimeout(() => {
      if (statusEl.textContent === message) {
        statusEl.textContent = '';
        statusEl.className = 'inline-status';
      }
    }, durationMs);
  }
}

function buildDraftProviderProfiles(activeProviderId, activeProfile) {
  const merged = normalizeProviderProfiles(draftProfiles);
  if (isProfileSaved(activeProviderId, activeProfile)) {
    merged[activeProviderId] = {
      protocol: activeProfile.protocol,
      baseUrl: activeProfile.baseUrl,
      apiKey: activeProfile.apiKey,
      model: activeProfile.model,
      thinkingEffort: activeProfile.thinkingEffort || 'fastest'
    };
  } else {
    delete merged[activeProviderId];
  }
  return merged;
}

function stashCurrentProviderToDraft() {
  const pid = currentProviderId || document.getElementById('provider-select')?.value || 'gemini';
  const activeProfile = {
    protocol: document.getElementById('protocol-select')?.value || 'openai',
    baseUrl: document.getElementById('baseurl-input')?.value.trim() || '',
    apiKey: normalizeApiKeyValue(document.getElementById('apikey-input')?.value || ''),
    model: document.getElementById('model-input')?.value.trim() || '',
    thinkingEffort: document.getElementById('thinking-effort')?.value || 'fastest'
  };
  draftProfiles = buildDraftProviderProfiles(pid, activeProfile);
}

function readFormValues({ clampUi = false } = {}) {
  const batchEl = document.getElementById('batch-size');
  const rawBatchStr = String(batchEl?.value ?? '').trim();
  const parsedBatch = rawBatchStr === '' ? 20 : Number(rawBatchStr);
  const batchSize = Number.isFinite(parsedBatch) ? Math.min(40, Math.max(1, Math.round(parsedBatch))) : 20;
  if (clampUi && batchEl) batchEl.value = String(batchSize);

  const maxCharsEl = document.getElementById('max-batch-chars');
  const rawCharsStr = String(maxCharsEl?.value ?? '').trim();
  const parsedChars = rawCharsStr === '' ? 5500 : Number(rawCharsStr);
  const maxBatchChars = Number.isFinite(parsedChars) ? Math.min(20000, Math.max(800, Math.round(parsedChars))) : 5500;
  if (clampUi && maxCharsEl) maxCharsEl.value = String(maxBatchChars);

  const tempEl = document.getElementById('temperature-input');
  const rawTemp = String(tempEl?.value ?? '').trim();
  const parsedTemp = rawTemp === '' ? NaN : Number(rawTemp);
  const temperature = Number.isFinite(parsedTemp) ? Math.min(1, Math.max(0, parsedTemp)) : 0.2;
  if (clampUi && tempEl) tempEl.value = String(temperature);

  const providerId = document.getElementById('provider-select').value;
  const protocol = document.getElementById('protocol-select').value;
  const baseUrl = document.getElementById('baseurl-input').value.trim();
  const apiKey = normalizeApiKeyValue(document.getElementById('apikey-input').value);
  const model = document.getElementById('model-input').value.trim();
  const thinkingEffort = document.getElementById('thinking-effort').value;
  const rawFallbackId = selectedFallbackProviderId || document.getElementById('fallback-provider-select')?.value || '';
  const fallbackProviderId = rawFallbackId && rawFallbackId !== providerId ? rawFallbackId : '';
  const providerProfiles = buildDraftProviderProfiles(providerId, {
    protocol,
    baseUrl,
    apiKey,
    model,
    thinkingEffort
  });

  return {
    targetLang: document.getElementById('lang-select').value,
    customTargetLang: document.getElementById('custom-lang-input').value.trim(),
    displayMode: document.getElementById('mode-select').value,
    translateCodeComments: document.getElementById('translate-code-comments').checked,
    showOutputTranslateBtn: document.getElementById('show-output-btn').checked,
    checkForUpdates: document.getElementById('check-for-updates').checked,
    typographyMatch: document.getElementById('typography-match').value,
    thinkingEffort,
    lazyViewport: document.getElementById('lazy-viewport').checked,
    streamTranslation: document.getElementById('stream-translation').checked,
    autoTranslate: document.getElementById('global-auto-translate').checked,
    autoTranslateHosts: [...whitelistHosts],
    providerId,
    protocol,
    baseUrl,
    apiKey,
    model,
    providerProfiles,
    fallbackProviderId,
    batchSize,
    ...(maxCharsEl ? { maxBatchChars } : {}),
    temperature,
    customGlossary: document.getElementById('glossary-input').value
  };
}

function getPersistedViewState(form) {
  const activeId = persistedActiveProviderId || form.providerId;
  if (activeId === form.providerId) {
    return {
      providerId: activeId,
      protocol: form.protocol,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      model: form.model,
      providerProfiles: form.providerProfiles,
      fallbackProviderId: selectedFallbackProviderId !== activeId ? selectedFallbackProviderId : ''
    };
  }
  const activeProf = form.providerProfiles?.[activeId] || {};
  return {
    providerId: activeId,
    protocol: activeProf.protocol || PROVIDER_PRESETS?.[activeId]?.protocol || 'openai',
    baseUrl: activeProf.baseUrl || PROVIDER_PRESETS?.[activeId]?.baseUrl || '',
    apiKey: activeProf.apiKey || '',
    model: activeProf.model || PROVIDER_PRESETS?.[activeId]?.defaultModel || '',
    providerProfiles: form.providerProfiles,
    fallbackProviderId: selectedFallbackProviderId !== activeId ? selectedFallbackProviderId : ''
  };
}

function renderSavedProviders() {
  const container = document.getElementById('saved-providers-list');
  if (!container) return;
  container.textContent = '';

  const form = readFormValues();
  const list = listSavedProviders(getPersistedViewState(form));

  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'host-empty';
    empty.textContent = '尚未儲存任何供應商設定（請選擇上方預設並填寫 API Key 後儲存）';
    container.appendChild(empty);
    return;
  }

  for (const item of list) {
    const isPersistedActive = item.providerId === persistedActiveProviderId;
    const chip = document.createElement('span');
    chip.className = 'provider-chip' + (isPersistedActive ? ' active' : '');
    chip.dataset.providerId = item.providerId;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'provider-chip-btn';
    btn.title = isPersistedActive ? `${item.label}（目前使用中）` : `切換為 ${item.label}`;

    const nameEl = document.createElement('span');
    nameEl.textContent = item.label;
    btn.appendChild(nameEl);

    if (item.model) {
      const meta = document.createElement('span');
      meta.className = 'provider-chip-meta';
      meta.textContent = item.model;
      btn.appendChild(meta);
    }

    if (isPersistedActive) {
      const badge = document.createElement('span');
      badge.className = 'provider-chip-badge';
      badge.textContent = '使用中';
      btn.appendChild(badge);
    } else if (item.isFallback) {
      const badge = document.createElement('span');
      badge.className = 'provider-chip-badge fallback';
      badge.textContent = '備援';
      btn.appendChild(badge);
    }

    btn.addEventListener('click', async () => {
      if (item.providerId === persistedActiveProviderId) {
        if (currentProviderId !== item.providerId) {
          const providerSelect = document.getElementById('provider-select');
          if (providerSelect) providerSelect.value = item.providerId;
          applyPreset(item.providerId);
        }
        return;
      }
      const seq = ++chipSwitchSeq;
      stashCurrentProviderToDraft();
      try {
        const fresh = await getSettings();
        if (seq !== chipSwitchSeq) return;
        const mergedProfiles = normalizeProviderProfiles({
          ...(fresh.providerProfiles || {}),
          ...draftProfiles
        }, fresh);
        const switched = typeof switchActiveProviderSettings === 'function'
          ? switchActiveProviderSettings({ ...fresh, providerProfiles: mergedProfiles }, item.providerId)
          : fresh;
        await ensureHostPermissions([switched.baseUrl]);
        const saved = await saveSettings({
          providerId: switched.providerId,
          protocol: switched.protocol,
          baseUrl: switched.baseUrl,
          apiKey: switched.apiKey,
          model: switched.model,
          thinkingEffort: switched.thinkingEffort,
          providerProfiles: switched.providerProfiles,
          fallbackProviderId: switched.fallbackProviderId
        });
        if (seq !== chipSwitchSeq) return;
        persistedActiveProviderId = saved.providerId || item.providerId;
        selectedFallbackProviderId = saved.fallbackProviderId || '';
        draftProfiles = normalizeProviderProfiles(saved.providerProfiles, saved);
        currentProviderId = persistedActiveProviderId;
        isProviderFormDirty = false;
        const providerSelect = document.getElementById('provider-select');
        if (providerSelect) providerSelect.value = currentProviderId;
        applyPreset(currentProviderId);
        renderFallbackSelect(selectedFallbackProviderId);
        renderSavedProviders();
        showSaveStatus(`✓ 已切換為 ${item.label}`);
      } catch (err) {
        showSaveStatus(`切換失敗：${err?.message || '儲存失敗'}`, true, 4000);
      }
    });

    chip.appendChild(btn);

    if (!isPersistedActive) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'provider-chip-remove';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('aria-label', `移除 ${item.label}`);
      removeBtn.title = `移除 ${item.label} 設定`;
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const fresh = await getSettings();
          const updated = typeof removeProviderProfile === 'function'
            ? removeProviderProfile(fresh, item.providerId)
            : fresh;
          const saved = await saveSettings({
            providerProfiles: updated.providerProfiles,
            fallbackProviderId: updated.fallbackProviderId
          });
          delete draftProfiles[item.providerId];
          draftProfiles = normalizeProviderProfiles({ ...saved.providerProfiles, ...draftProfiles });
          if (selectedFallbackProviderId === item.providerId) {
            selectedFallbackProviderId = '';
          }
          if (currentProviderId === item.providerId) {
            const preset = PROVIDER_PRESETS[currentProviderId];
            if (preset) {
              document.getElementById('protocol-select').value = preset.protocol;
              document.getElementById('baseurl-input').value = preset.baseUrl;
              document.getElementById('model-input').value = preset.defaultModel || '';
              document.getElementById('apikey-input').value = '';
            }
          }
          renderFallbackSelect(selectedFallbackProviderId);
          renderSavedProviders();
        } catch (err) {
          showSaveStatus(`移除失敗：${err?.message || '儲存失敗'}`, true, 4000);
        }
      });
      chip.appendChild(removeBtn);
    }

    container.appendChild(chip);
  }
}

function renderFallbackSelect(preferredValue) {
  const select = document.getElementById('fallback-provider-select');
  if (!select) return;
  if (preferredValue !== undefined) {
    selectedFallbackProviderId = String(preferredValue || '');
  }
  const form = readFormValues();
  const activeId = persistedActiveProviderId || form.providerId;
  const targetVal = selectedFallbackProviderId;
  select.textContent = '';

  const disabledOpt = document.createElement('option');
  disabledOpt.value = '';
  disabledOpt.textContent = '停用（僅手動切換）';
  select.appendChild(disabledOpt);

  const candidates = listSavedProviders({
    ...getPersistedViewState(form),
    fallbackProviderId: targetVal
  }).filter((p) => p.providerId !== activeId && p.isReady);

  for (const cand of candidates) {
    const opt = document.createElement('option');
    opt.value = cand.providerId;
    opt.textContent = `${cand.label}${cand.model ? ` (${cand.model})` : ''}`;
    select.appendChild(opt);
  }

  const hasMatch = candidates.some((c) => c.providerId === targetVal);
  select.value = hasMatch ? targetVal : '';
}

function updateEndpointPreview() {
  const previewEl = document.getElementById('endpoint-preview');
  if (!previewEl) return;
  const form = readFormValues();
  const resolved = (form.streamTranslation && typeof resolveStreamEndpoint === 'function')
    ? resolveStreamEndpoint(form)
    : resolveEndpoint(form);
  previewEl.textContent = resolved || '（未填寫）';
}

function updateCustomLangVisibility() {
  const isCustom = document.getElementById('lang-select')?.value === 'custom';
  const wrap = document.getElementById('custom-lang-wrap');
  if (!wrap) return;
  wrap.hidden = !isCustom;
  wrap.classList.toggle('hidden', !isCustom);
}

function updateModelSuggestions(preset) {
  const datalist = document.getElementById('model-suggestions');
  if (!datalist) return;
  datalist.textContent = '';
  const models = Array.isArray(preset?.suggestedModels) && preset.suggestedModels.length
    ? preset.suggestedModels
    : (preset?.defaultModel ? [preset.defaultModel] : []);
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    datalist.appendChild(opt);
  }
}

function applyPreset(presetId) {
  const preset = PROVIDER_PRESETS[presetId];
  if (!preset) return;
  if (currentProviderId && currentProviderId !== presetId) {
    stashCurrentProviderToDraft();
  }
  currentProviderId = presetId;
  const savedProfile = draftProfiles[presetId];
  document.getElementById('protocol-select').value = savedProfile?.protocol || preset.protocol;
  document.getElementById('baseurl-input').value = savedProfile?.baseUrl || preset.baseUrl;
  const modelInput = document.getElementById('model-input');
  modelInput.value = savedProfile?.model || preset.defaultModel || '';
  modelInput.placeholder = preset.defaultModel
    ? `例如 ${preset.defaultModel}`
    : '請按「取得模型清單」選擇，或直接輸入模型名稱';
  document.getElementById('apikey-input').value = savedProfile?.apiKey || '';
  document.getElementById('apikey-input').placeholder = preset.placeholderKey;
  if (savedProfile?.thinkingEffort) {
    const teEl = document.getElementById('thinking-effort');
    if (teEl) teEl.value = savedProfile.thinkingEffort;
  }
  const testBox = document.getElementById('test-result');
  if (testBox) {
    testBox.hidden = true;
    testBox.textContent = '';
    testBox.className = 'test-box';
  }
  const modelListStatus = document.getElementById('model-list-status');
  if (modelListStatus) {
    modelListStatus.hidden = true;
    modelListStatus.textContent = '';
  }
  document.getElementById('provider-hint').textContent = preset.hint;
  updateModelSuggestions(preset);
  updateEndpointPreview();
  renderFallbackSelect(selectedFallbackProviderId);
  renderSavedProviders();
}

function toHostPermissionPattern(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    const host = u.hostname.includes(':') && !u.hostname.startsWith('[')
      ? `[${u.hostname}]`
      : u.hostname;
    return host ? `${u.protocol}//${host}/*` : '';
  } catch (_) {
    return '';
  }
}

async function ensureHostPermissions(urls) {
  const patterns = Array.from(
    new Set((Array.isArray(urls) ? urls : [urls]).map(toHostPermissionPattern).filter(Boolean))
  );
  if (!patterns.length) return true;
  try {
    const missing = [];
    for (const pat of patterns) {
      const already = await chrome.permissions.contains({ origins: [pat] });
      if (!already) missing.push(pat);
    }
    if (!missing.length) return true;
    return await chrome.permissions.request({ origins: missing });
  } catch (err) {
    console.warn('Permission request skipped/denied:', err?.message || err);
    return false;
  }
}

async function ensureHostPermissionIfNeeded(baseUrl) {
  return ensureHostPermissions([baseUrl]);
}

function formatCacheSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(n / 1024).toFixed(1)} KB`;
}

function encodeBase64UrlUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildMobileSyncUrl(form) {
  const preset = PROVIDER_PRESETS[form.providerId] || null;
  const payload = {
    p: form.providerId || 'gemini',
    r: form.protocol || 'openai',
    k: form.apiKey || '',
    m: form.model || '',
    l: form.targetLang || 'zh-TW',
    e: form.thinkingEffort || 'fastest',
    t: form.typographyMatch || 'native'
  };
  if (form.baseUrl && (!preset || form.baseUrl !== preset.baseUrl)) {
    payload.u = form.baseUrl;
  }
  if (form.targetLang === 'custom' && form.customTargetLang) {
    payload.c = form.customTargetLang;
  }
  const encoded = encodeBase64UrlUtf8(JSON.stringify(payload));
  return `https://chih-kai-wang.github.io/native-read/#nr_sync=${encoded}`;
}

// ============================================================
// Self-Contained Pure-JS ISO/IEC 18004 QR Code Generator (V1-V14, Level L, Byte Mode)
// ============================================================
const QR_LEVEL_L_VERSIONS = [
  null,
  { v: 1, totalData: 19, ecPerBlock: 7, groups: [[1, 19]], align: [] },
  { v: 2, totalData: 34, ecPerBlock: 10, groups: [[1, 34]], align: [6, 18] },
  { v: 3, totalData: 55, ecPerBlock: 15, groups: [[1, 55]], align: [6, 22] },
  { v: 4, totalData: 80, ecPerBlock: 20, groups: [[1, 80]], align: [6, 26] },
  { v: 5, totalData: 108, ecPerBlock: 26, groups: [[1, 108]], align: [6, 30] },
  { v: 6, totalData: 136, ecPerBlock: 18, groups: [[2, 68]], align: [6, 34] },
  { v: 7, totalData: 156, ecPerBlock: 20, groups: [[2, 78]], align: [6, 22, 38] },
  { v: 8, totalData: 194, ecPerBlock: 24, groups: [[2, 97]], align: [6, 24, 42] },
  { v: 9, totalData: 232, ecPerBlock: 30, groups: [[2, 116]], align: [6, 26, 46] },
  { v: 10, totalData: 274, ecPerBlock: 18, groups: [[2, 68], [2, 69]], align: [6, 28, 50] },
  { v: 11, totalData: 324, ecPerBlock: 20, groups: [[4, 81]], align: [6, 30, 54] },
  { v: 12, totalData: 370, ecPerBlock: 24, groups: [[2, 92], [2, 93]], align: [6, 32, 58] },
  { v: 13, totalData: 428, ecPerBlock: 26, groups: [[4, 107]], align: [6, 34, 62] },
  { v: 14, totalData: 461, ecPerBlock: 30, groups: [[3, 115], [1, 116]], align: [6, 26, 46, 66] }
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  return (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcBytes(dataBytes, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < dataBytes.length; i++) {
    const factor = dataBytes[i] ^ rem[0];
    for (let j = 0; j < ecLen - 1; j++) {
      rem[j] = rem[j + 1] ^ gfMul(gen[j + 1], factor);
    }
    rem[ecLen - 1] = gfMul(gen[ecLen], factor);
  }
  return rem;
}

function pickQrVersion(byteLen) {
  for (let v = 1; v <= 14; v++) {
    const info = QR_LEVEL_L_VERSIONS[v];
    const countBits = v <= 9 ? 8 : 16;
    const maxBytes = Math.floor((info.totalData * 8 - 4 - countBits) / 8);
    if (byteLen <= maxBytes) return info;
  }
  throw new Error('同步連結長度超過 QR V14 容量上限');
}

function encodeQrCodewords(utf8Bytes, verInfo) {
  const bitBuf = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bitBuf.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4);
  pushBits(utf8Bytes.length, verInfo.v <= 9 ? 8 : 16);
  for (let i = 0; i < utf8Bytes.length; i++) {
    pushBits(utf8Bytes[i], 8);
  }

  const maxBits = verInfo.totalData * 8;
  const termLen = Math.min(4, Math.max(0, maxBits - bitBuf.length));
  pushBits(0, termLen);
  while (bitBuf.length % 8 !== 0) {
    bitBuf.push(0);
  }

  const dataCodewords = new Uint8Array(verInfo.totalData);
  const byteCount = bitBuf.length / 8;
  for (let i = 0; i < byteCount; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bitBuf[i * 8 + j];
    }
    dataCodewords[i] = b;
  }
  const pads = [0xec, 0x11];
  for (let i = byteCount; i < verInfo.totalData; i++) {
    dataCodewords[i] = pads[(i - byteCount) % 2];
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  let maxBlockLen = 0;
  for (const [numBlocks, dataLen] of verInfo.groups) {
    for (let b = 0; b < numBlocks; b++) {
      const slice = dataCodewords.subarray(offset, offset + dataLen);
      offset += dataLen;
      dataBlocks.push(slice);
      ecBlocks.push(rsComputeEcBytes(slice, verInfo.ecPerBlock));
      if (dataLen > maxBlockLen) maxBlockLen = dataLen;
    }
  }

  const finalBytes = [];
  for (let i = 0; i < maxBlockLen; i++) {
    for (let b = 0; b < dataBlocks.length; b++) {
      if (i < dataBlocks[b].length) finalBytes.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < verInfo.ecPerBlock; i++) {
    for (let b = 0; b < ecBlocks.length; b++) {
      finalBytes.push(ecBlocks[b][i]);
    }
  }
  return finalBytes;
}

function computeFormatBits(mask) {
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) {
      rem ^= 0x1f25 << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function buildBaseQrMatrix(verInfo) {
  const size = 17 + verInfo.v * 4;
  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    grid[r][c] = dark ? 1 : 0;
    reserved[r][c] = 1;
  };

  const drawFinder = (topR, leftC) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(topR + dr, leftC + dc, inOuter && (onBorder || inInner));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  const centers = verInfo.align;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0)) {
        continue;
      }
      const cr = centers[i];
      const cc = centers[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(cr + dr, cc + dc, dark);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) setFunctionModule(6, i, i % 2 === 0);
    if (!reserved[i][6]) setFunctionModule(i, 6, i % 2 === 0);
  }

  setFunctionModule(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) reserved[8][size - 1 - i] = 1;
    if (!reserved[size - 1 - i][8]) reserved[size - 1 - i][8] = 1;
  }

  if (verInfo.v >= 7) {
    const vBits = computeVersionBits(verInfo.v);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      setFunctionModule(b, a, bit);
      setFunctionModule(a, b, bit);
    }
  }

  return { size, grid, reserved };
}

function placeFormatBits(grid, size, mask) {
  const bits = computeFormatBits(mask);
  for (let i = 0; i <= 5; i++) grid[i][8] = (bits >>> i) & 1;
  grid[7][8] = (bits >>> 6) & 1;
  grid[8][8] = (bits >>> 7) & 1;
  grid[8][7] = (bits >>> 8) & 1;
  for (let i = 9; i < 15; i++) grid[8][14 - i] = (bits >>> i) & 1;

  for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = (bits >>> i) & 1;
  for (let i = 8; i < 15; i++) grid[size - 15 + i][8] = (bits >>> i) & 1;
  grid[size - 8][8] = 1;
}

function maskCondition(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function scoreQrPenalty(grid, size) {
  let penalty = 0;
  for (let r = 0; r < size; r++) {
    let runColor = grid[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (grid[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = grid[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = grid[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (grid[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = grid[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }
  return penalty;
}

function generateQrMatrix(text) {
  const utf8Bytes = new TextEncoder().encode(text);
  const verInfo = pickQrVersion(utf8Bytes.length);
  const codewords = encodeQrCodewords(utf8Bytes, verInfo);
  const { size, grid: baseGrid, reserved } = buildBaseQrMatrix(verInfo);

  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? (size - 1 - step) : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = rightCol - dx;
        if (reserved[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        baseGrid[r][c] = bit;
      }
    }
    upward = !upward;
  }

  let bestGrid = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = baseGrid.map((row) => Uint8Array.from(row));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && maskCondition(mask, r, c)) {
          candidate[r][c] ^= 1;
        }
      }
    }
    placeFormatBits(candidate, size, mask);
    const p = scoreQrPenalty(candidate, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestGrid = candidate;
    }
  }
  return { size, grid: bestGrid };
}

function renderQrToCanvas(canvas, text) {
  if (!canvas) return;
  const { size, grid } = generateQrMatrix(text);
  const quietZone = 4;
  const totalModules = size + quietZone * 2;
  const scale = Math.max(3, Math.floor(220 / totalModules));
  const pixelSize = totalModules * scale;

  canvas.width = pixelSize;
  canvas.height = pixelSize;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pixelSize, pixelSize);

  ctx.fillStyle = '#0f172a';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) {
        ctx.fillRect((c + quietZone) * scale, (r + quietZone) * scale, scale, scale);
      }
    }
  }
}

async function refreshCacheStats() {
  const statsEl = document.getElementById('cache-stats');
  if (!statsEl) return;
  try {
    let res = null;
    if (globalThis.KCTCacheDB && typeof globalThis.KCTCacheDB.stats === 'function') {
      const localStats = await globalThis.KCTCacheDB.stats();
      if (localStats && Number.isFinite(localStats.entries)) {
        res = { ok: true, entries: localStats.entries, bytes: localStats.bytes || 0 };
      }
    }
    if (!res) {
      res = await chrome.runtime.sendMessage({ type: 'GET_CACHE_STATS' });
    }
    if (res?.ok) {
      const sizeStr = formatCacheSize(res.bytes);
      statsEl.textContent = `已快取 ${res.entries} 筆譯文（約 ${sizeStr}）`;
    } else {
      statsEl.textContent = '無法讀取快取狀態';
    }
  } catch (_) {
    statsEl.textContent = '無法讀取快取狀態';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const langSelect = document.getElementById('lang-select');
  for (const lang of Object.values(TARGET_LANGUAGES)) {
    const opt = document.createElement('option');
    opt.value = lang.id;
    opt.textContent = lang.label;
    langSelect.appendChild(opt);
  }

  const providerSelect = document.getElementById('provider-select');
  const providerGroups = new Map();
  for (const preset of Object.values(PROVIDER_PRESETS)) {
    const groupLabel = preset.group || '其他';
    if (!providerGroups.has(groupLabel)) {
      const og = document.createElement('optgroup');
      og.label = groupLabel;
      providerGroups.set(groupLabel, og);
      providerSelect.appendChild(og);
    }
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    providerGroups.get(groupLabel).appendChild(opt);
  }

  const applyLoadedSettingsToForm = (loaded) => {
    langSelect.value = loaded.targetLang || 'zh-TW';
    document.getElementById('custom-lang-input').value = loaded.customTargetLang || '';
    document.getElementById('mode-select').value = loaded.displayMode || 'replace';
    document.getElementById('translate-code-comments').checked = loaded.translateCodeComments !== false;
    document.getElementById('show-output-btn').checked = loaded.showOutputTranslateBtn !== false;
    document.getElementById('check-for-updates').checked = loaded.checkForUpdates !== false;
    document.getElementById('typography-match').value = loaded.typographyMatch || 'native';
    document.getElementById('thinking-effort').value = loaded.thinkingEffort || 'fastest';
    document.getElementById('lazy-viewport').checked = loaded.lazyViewport !== false;
    document.getElementById('stream-translation').checked = loaded.streamTranslation !== false;
    document.getElementById('global-auto-translate').checked = Boolean(loaded.autoTranslate);
    whitelistHosts = Array.isArray(loaded.autoTranslateHosts)
      ? [...new Set(loaded.autoTranslateHosts.map((h) => normalizeHostInput(h)).filter(Boolean))]
      : [];
    renderWhitelist();
    updateCustomLangVisibility();

    persistedActiveProviderId = loaded.providerId || 'gemini';
    currentProviderId = persistedActiveProviderId;
    selectedFallbackProviderId = loaded.fallbackProviderId || '';
    draftProfiles = normalizeProviderProfiles(loaded.providerProfiles, loaded);
    isProviderFormDirty = false;
    providerSelect.value = currentProviderId;
    document.getElementById('protocol-select').value = loaded.protocol || 'openai';
    document.getElementById('baseurl-input').value = loaded.baseUrl || '';
    document.getElementById('apikey-input').value = loaded.apiKey || '';
    document.getElementById('model-input').value = loaded.model || '';
    document.getElementById('batch-size').value = loaded.batchSize ?? 20;
    const maxCharsEl = document.getElementById('max-batch-chars');
    if (maxCharsEl) {
      maxCharsEl.value = loaded.maxBatchChars ?? 5500;
    }
    document.getElementById('temperature-input').value = loaded.temperature ?? 0.2;
    document.getElementById('glossary-input').value = loaded.customGlossary ?? DEFAULT_GLOSSARY;

    const activePreset = PROVIDER_PRESETS[providerSelect.value];
    if (activePreset) {
      document.getElementById('provider-hint').textContent = activePreset.hint;
      document.getElementById('apikey-input').placeholder = activePreset.placeholderKey;
      updateModelSuggestions(activePreset);
    }
    renderFallbackSelect(selectedFallbackProviderId);
    renderSavedProviders();
    updateEndpointPreview();
  };

  const settings = await getSettings();
  applyLoadedSettingsToForm(settings);

  const btnGenSync = document.getElementById('btn-generate-mobile-sync');
  const btnCopySync = document.getElementById('btn-copy-mobile-sync');
  const syncStatus = document.getElementById('mobile-sync-status');
  const syncBox = document.getElementById('mobile-sync-box');
  const syncUrlInput = document.getElementById('mobile-sync-url');
  const syncQrCanvas = document.getElementById('mobile-sync-qr');

  const invalidateMobileSync = () => {
    lastSyncUrl = '';
    if (syncUrlInput) syncUrlInput.value = '';
    if (btnCopySync) btnCopySync.disabled = true;
    if (syncBox) {
      syncBox.hidden = true;
      syncBox.classList.add('hidden');
    }
    if (syncStatus) {
      syncStatus.textContent = '';
      syncStatus.className = 'inline-status';
    }
  };

  langSelect.addEventListener('change', () => {
    updateCustomLangVisibility();
    invalidateMobileSync();
  });
  document.getElementById('custom-lang-input')?.addEventListener('input', invalidateMobileSync);
  document.getElementById('typography-match')?.addEventListener('change', invalidateMobileSync);
  document.getElementById('thinking-effort')?.addEventListener('change', invalidateMobileSync);

  const syncProviderDraftUI = () => {
    isProviderFormDirty = true;
    stashCurrentProviderToDraft();
    updateEndpointPreview();
    renderFallbackSelect(selectedFallbackProviderId);
    renderSavedProviders();
    invalidateMobileSync();
  };

  providerSelect.addEventListener('change', (e) => {
    isProviderFormDirty = true;
    applyPreset(e.target.value);
    invalidateMobileSync();
  });

  document.getElementById('protocol-select')?.addEventListener('change', syncProviderDraftUI);
  document.getElementById('baseurl-input')?.addEventListener('input', syncProviderDraftUI);
  document.getElementById('model-input')?.addEventListener('input', syncProviderDraftUI);
  document.getElementById('apikey-input')?.addEventListener('input', () => {
    isProviderFormDirty = true;
    stashCurrentProviderToDraft();
    renderFallbackSelect(selectedFallbackProviderId);
    renderSavedProviders();
    invalidateMobileSync();
  });
  document.getElementById('fallback-provider-select')?.addEventListener('change', (e) => {
    selectedFallbackProviderId = String(e.target.value || '');
    renderSavedProviders();
  });
  document.getElementById('thinking-effort')?.addEventListener('change', () => {
    stashCurrentProviderToDraft();
  });

  const settingsKey = SETTINGS_KEY || 'kct_settings_v1';
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || applyingExternalStorage) return;
    const next = changes[settingsKey]?.newValue;
    if (!next || typeof next !== 'object') return;
    applyingExternalStorage = true;
    try {
      whitelistHosts = Array.isArray(next.autoTranslateHosts)
        ? [...new Set(next.autoTranslateHosts.map((h) => normalizeHostInput(h)).filter(Boolean))]
        : [];
      renderWhitelist();
      persistedActiveProviderId = next.providerId || 'gemini';
      if (!isProviderFormDirty) {
        selectedFallbackProviderId = next.fallbackProviderId || '';
        draftProfiles = normalizeProviderProfiles(next.providerProfiles, next);
        currentProviderId = persistedActiveProviderId;
        providerSelect.value = currentProviderId;
        const nextPreset = PROVIDER_PRESETS[currentProviderId];
        if (nextPreset) {
          document.getElementById('provider-hint').textContent = nextPreset.hint;
          document.getElementById('apikey-input').placeholder = nextPreset.placeholderKey;
          updateModelSuggestions(nextPreset);
        }
        document.getElementById('protocol-select').value = next.protocol || nextPreset?.protocol || 'openai';
        document.getElementById('baseurl-input').value = next.baseUrl || nextPreset?.baseUrl || '';
        document.getElementById('apikey-input').value = next.apiKey || '';
        document.getElementById('model-input').value = next.model || nextPreset?.defaultModel || '';
        document.getElementById('thinking-effort').value = next.thinkingEffort || 'fastest';
        updateEndpointPreview();
        renderFallbackSelect(selectedFallbackProviderId);
        renderSavedProviders();
      } else {
        const currentEdited = draftProfiles[currentProviderId];
        draftProfiles = normalizeProviderProfiles({
          ...(next.providerProfiles || {}),
          ...draftProfiles
        }, next);
        if (currentEdited) draftProfiles[currentProviderId] = currentEdited;
        renderFallbackSelect(selectedFallbackProviderId);
        renderSavedProviders();
      }
    } finally {
      applyingExternalStorage = false;
    }
  });
  document.getElementById('stream-translation')?.addEventListener('change', updateEndpointPreview);

  document.getElementById('btn-toggle-key')?.addEventListener('click', (e) => {
    const input = document.getElementById('apikey-input');
    if (!input) return;
    const isPwd = input.type === 'password';
    input.type = isPwd ? 'text' : 'password';
    e.target.textContent = isPwd ? '隱藏' : '顯示';
  });

  document.getElementById('btn-add-host')?.addEventListener('click', handleAddHost);
  document.getElementById('whitelist-host-input')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await handleAddHost();
    }
  });

  document.getElementById('btn-reset-glossary')?.addEventListener('click', () => {
    const el = document.getElementById('glossary-input');
    if (el) el.value = DEFAULT_GLOSSARY;
  });

  function validateProviderForm(form, { requireCredentials = false, requireModel = false } = {}) {
    if (!form.baseUrl) {
      return '請輸入有效的 http:// 或 https:// API Base URL';
    }
    try {
      const parsed = new URL(form.baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'API Base URL 必須以 http:// 或 https:// 開頭';
      }
    } catch (_) {
      return '請輸入有效的 http:// 或 https:// API Base URL';
    }
    if (/YOUR-RESOURCE/i.test(form.baseUrl)) {
      return '請先將 Azure Base URL 中的 YOUR-RESOURCE 替換為實際資源名稱';
    }
    if (typeof validateApiKey === 'function') {
      const keyCheck = validateApiKey(form.apiKey);
      if (!keyCheck.ok) {
        return keyCheck.error;
      }
    }
    if (requireCredentials && !form.apiKey && !checkLocalEndpoint(form.baseUrl)) {
      return '請先填寫 API Key';
    }
    if (requireModel && !form.model) {
      return '請先選擇或輸入模型名稱';
    }
    return '';
  }

  async function handleSave(statusElId) {
    const form = readFormValues({ clampUi: true });
    const statusEl = document.getElementById(statusElId);
    if (!statusEl) return;

    const validationErr = validateProviderForm(form);
    if (validationErr) {
      showSaveStatus(validationErr, true, 4500);
      return;
    }

    if (saveStatusTimer) {
      clearTimeout(saveStatusTimer);
      saveStatusTimer = null;
    }
    statusEl.className = 'inline-status';
    statusEl.textContent = '儲存中...';

    try {
      const fbProfile = form.fallbackProviderId ? form.providerProfiles?.[form.fallbackProviderId] : null;
      await ensureHostPermissions([form.baseUrl, fbProfile?.baseUrl]);
      const saved = await saveSettings(form);
      persistedActiveProviderId = saved.providerId || form.providerId;
      currentProviderId = persistedActiveProviderId;
      selectedFallbackProviderId = saved.fallbackProviderId || '';
      draftProfiles = normalizeProviderProfiles(saved.providerProfiles, saved);
      isProviderFormDirty = false;
      renderFallbackSelect(selectedFallbackProviderId);
      renderSavedProviders();

      if (!saved.model) {
        showSaveStatus('✓ 設定已儲存（提醒：尚未填寫模型名稱）', false, 3500);
      } else {
        showSaveStatus('✓ 設定已儲存', false, 2500);
      }
    } catch (err) {
      showSaveStatus(`儲存失敗：${err?.message || '寫入設定時發生錯誤'}`, true, 4500);
    }
  }

  document.getElementById('btn-save')?.addEventListener('click', async () => {
    await handleSave('save-status');
  });

  document.getElementById('btn-list-models')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-list-models');
    const statusEl = document.getElementById('model-list-status');
    const datalist = document.getElementById('model-suggestions');
    const modelInput = document.getElementById('model-input');
    if (!btn || !statusEl || !datalist) return;

    const form = readFormValues();
    const validationErr = validateProviderForm(form);
    if (validationErr) {
      statusEl.hidden = false;
      statusEl.textContent = validationErr;
      return;
    }

    const seq = ++listModelsSeq;
    btn.disabled = true;
    statusEl.hidden = false;
    statusEl.textContent = '正在取得模型清單...';

    try {
      await ensureHostPermissions([form.baseUrl]);
      const res = await chrome.runtime.sendMessage({
        type: 'LIST_MODELS',
        settings: form
      });
      if (seq !== listModelsSeq) return;

      if (res?.ok && Array.isArray(res.models)) {
        datalist.replaceChildren();
        for (const id of res.models) {
          const opt = document.createElement('option');
          opt.value = id;
          datalist.appendChild(opt);
        }

        let msg = `已取得 ${res.models.length} 個可用模型，點模型欄位即可選擇`;
        const currentModel = String(modelInput?.value || '').trim();
        if (currentModel && !res.models.includes(currentModel)) {
          msg += ` · 目前填寫的「${currentModel}」不在清單中，可能已停用`;
        }
        statusEl.textContent = msg;
      } else {
        statusEl.textContent = res?.error || '取得模型清單失敗';
      }
    } catch (err) {
      if (seq === listModelsSeq) {
        statusEl.textContent = `取得模型清單失敗：${err?.message || '無法連線至背景服務'}`;
      }
    } finally {
      if (seq === listModelsSeq) {
        btn.disabled = false;
      }
    }
  });

  document.getElementById('btn-test')?.addEventListener('click', async () => {
    const btnTest = document.getElementById('btn-test');
    const form = readFormValues();
    const box = document.getElementById('test-result');
    if (!box) return;

    const validationErr = validateProviderForm(form, { requireCredentials: true, requireModel: true });
    if (validationErr) {
      box.hidden = false;
      box.className = 'test-box err';
      box.textContent = `連線失敗：${validationErr}`;
      return;
    }

    const seq = ++testConnSeq;
    if (btnTest) btnTest.disabled = true;
    box.hidden = false;
    box.className = 'test-box';
    box.textContent = '正在測試連線...';

    try {
      await ensureHostPermissions([form.baseUrl]);
      const res = await chrome.runtime.sendMessage({
        type: 'TEST_CONNECTION',
        settings: form
      });
      if (seq !== testConnSeq) return;

      if (res?.ok) {
        box.className = 'test-box ok';
        box.textContent = `連線成功 (${res.latencyMs} ms) · 範例譯文：${res.reply}`;
      } else {
        box.className = 'test-box err';
        box.textContent = `連線失敗：${res?.error || '未知錯誤'}`;
      }
    } catch (err) {
      if (seq === testConnSeq) {
        box.className = 'test-box err';
        box.textContent = `連線失敗：${err?.message || '無法連線至背景服務'}`;
      }
    } finally {
      if (seq === testConnSeq && btnTest) {
        btnTest.disabled = false;
      }
    }
  });

  document.getElementById('btn-clear-cache')?.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    } catch (_) {}
    await refreshCacheStats();
  });

  if (btnGenSync) {
    btnGenSync.addEventListener('click', async () => {
      const form = readFormValues({ clampUi: true });
      if (checkLocalEndpoint(form.baseUrl)) {
        invalidateMobileSync();
        if (syncStatus) {
          syncStatus.className = 'inline-status err';
          syncStatus.textContent = '本機端點 (localhost / 127.0.0.1) 無法從手機掃描存取，請改用雲端端點';
        }
        return;
      }
      const validationErr = validateProviderForm(form, { requireCredentials: true, requireModel: true });
      if (validationErr) {
        invalidateMobileSync();
        if (syncStatus) {
          syncStatus.className = 'inline-status err';
          syncStatus.textContent = validationErr;
        }
        return;
      }

      try {
        const url = buildMobileSyncUrl(form);
        lastSyncUrl = url;
        if (syncUrlInput) syncUrlInput.value = url;
        renderQrToCanvas(syncQrCanvas, url);

        await ensureHostPermissions([form.baseUrl]);
        const saved = await saveSettings(form);
        persistedActiveProviderId = saved.providerId || form.providerId;
        currentProviderId = persistedActiveProviderId;
        selectedFallbackProviderId = saved.fallbackProviderId || '';
        draftProfiles = normalizeProviderProfiles(saved.providerProfiles, saved);
        isProviderFormDirty = false;
        renderFallbackSelect(selectedFallbackProviderId);
        renderSavedProviders();

        if (syncBox) {
          syncBox.hidden = false;
          syncBox.classList.remove('hidden');
        }
        if (btnCopySync) btnCopySync.disabled = false;
        if (syncStatus) {
          syncStatus.className = 'inline-status ok';
          syncStatus.textContent = '✓ 已產生同步 QR Code';
        }
      } catch (err) {
        lastSyncUrl = '';
        if (syncUrlInput) syncUrlInput.value = '';
        if (btnCopySync) btnCopySync.disabled = true;
        if (syncBox) {
          syncBox.hidden = true;
          syncBox.classList.add('hidden');
        }
        if (syncStatus) {
          syncStatus.className = 'inline-status err';
          syncStatus.textContent = err?.message || '產生 QR Code 失敗';
        }
      }
    });
  }

  if (btnCopySync) {
    btnCopySync.addEventListener('click', async () => {
      const url = lastSyncUrl || syncUrlInput?.value || '';
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        if (syncStatus) {
          syncStatus.className = 'inline-status ok';
          syncStatus.textContent = '✓ 已複製同步連結';
          setTimeout(() => {
            if (syncStatus.textContent === '✓ 已複製同步連結') {
              syncStatus.textContent = '';
            }
          }, 2500);
        }
      } catch (_) {
        syncUrlInput?.select();
      }
    });
  }

  const importSyncInput = document.getElementById('import-sync-input');
  const btnImportSync = document.getElementById('btn-import-mobile-sync');
  const importSyncStatus = document.getElementById('import-sync-status');
  if (btnImportSync && importSyncInput) {
    btnImportSync.addEventListener('click', async () => {
      const raw = String(importSyncInput.value || '').trim();
      if (!raw) {
        if (importSyncStatus) {
          importSyncStatus.className = 'inline-status err';
          importSyncStatus.textContent = '請先貼上包含 #nr_sync= 的電腦端同步連結';
        }
        return;
      }
      btnImportSync.disabled = true;
      if (importSyncStatus) {
        importSyncStatus.className = 'inline-status';
        importSyncStatus.textContent = '正在驗證並匯入設定...';
      }
      try {
        const res = await chrome.runtime.sendMessage({ type: 'IMPORT_SYNC_PAYLOAD', raw });
        if (!res?.ok || !res.settings) {
          if (importSyncStatus) {
            importSyncStatus.className = 'inline-status err';
            importSyncStatus.textContent = res?.error || '同步連結格式無效或金鑰不合法';
          }
          return;
        }
        applyLoadedSettingsToForm(res.settings);
        invalidateMobileSync();
        importSyncInput.value = '';
        await ensureHostPermissions([res.settings.baseUrl]);
        if (importSyncStatus) {
          importSyncStatus.className = 'inline-status ok';
          importSyncStatus.textContent = '✓ 已從同步連結匯入設定！';
        }
      } catch (err) {
        if (importSyncStatus) {
          importSyncStatus.className = 'inline-status err';
          importSyncStatus.textContent = err?.message || '匯入設定失敗';
        }
      } finally {
        btnImportSync.disabled = false;
      }
    });
  }

  void refreshCacheStats();
});
