importScripts('../shared/config.js', '../shared/cache-db.js');

const {
  PROVIDER_PRESETS,
  TARGET_LANGUAGES,
  DEFAULT_GLOSSARY,
  getSettings,
  saveSettings,
  resolveEndpoint,
  resolveStreamEndpoint,
  resolveThinkingConfig,
  resolveTargetLanguage,
  sanitizeApiKey,
  hashText,
  isHostWhitelisted,
  isInjectableUrl,
  isFilePdfUrl,
  isPdfUrl,
  resolveAssociatedPdfUrl,
  buildProviderAuthHeaders,
  buildListModelsUrl,
  parseListModelsResponse,
  isAzureOpenAIEndpoint,
  buildAnthropicMessagesBody,
  extractAnthropicText,
  extractAnthropicStreamDelta,
  isLocalEndpoint,
  resolveFallbackSettings,
  formatApiError
} = globalThis.KCTConfig;

const CacheDB = globalThis.KCTCacheDB;

const CONTENT_CSS_FILES = ['content/content.css'];
const CONTENT_JS_FILES = [
  'shared/config.js',
  'content/site-analyzer.js',
  'content/code-overlay.js',
  'content/renderer.js',
  'content/content.js'
];

let nextBatchSeq = 1;
const activeBatchDebug = new Map();
const recentBatchDebug = [];

function recordBatchEvent(id, patch) {
  const cur = activeBatchDebug.get(id);
  if (cur) {
    Object.assign(cur, patch);
  }
}

function finishBatchEvent(id, patch) {
  const cur = activeBatchDebug.get(id);
  if (!cur) return;
  Object.assign(cur, patch, { endedAt: Date.now(), elapsedMs: Date.now() - cur.startedAt });
  activeBatchDebug.delete(id);
  recentBatchDebug.push(cur);
  if (recentBatchDebug.length > 20) recentBatchDebug.shift();
}

function redactApiKey(text, apiKey) {
  const out = String(text || '');
  const cleanKey = sanitizeApiKey(apiKey);
  if (!out || cleanKey.length < 6) return out;
  return out.split(cleanKey).join('[REDACTED]');
}

function redactAllKeys(text, settings, extraSettings = null) {
  let out = String(text || '');
  if (!out) return out;
  if (settings?.apiKey) out = redactApiKey(out, settings.apiKey);
  if (extraSettings?.apiKey) out = redactApiKey(out, extraSettings.apiKey);
  const profiles = settings?.providerProfiles;
  if (profiles && typeof profiles === 'object') {
    for (const prof of Object.values(profiles)) {
      if (prof?.apiKey) out = redactApiKey(out, prof.apiKey);
    }
  }
  return out;
}

// A model must be chosen explicitly (presets no longer ship guessed defaults).
function assertModelConfigured(settings) {
  if (String(settings?.model || '').trim()) return;
  const err = new Error('尚未選擇模型：請到設定頁按「取得模型清單」後選擇模型，或直接輸入模型名稱');
  err.errorCode = 'NO_MODEL';
  err.noRetry = true;
  err.noSplit = true;
  throw err;
}

// Point users with a retired model (e.g. an old saved default) to the live model list.
function withModelHint(message, status) {
  const text = String(message || '');
  const looksLikeModelError =
    /model[^\n]{0,40}(not[ _]?found|does not exist|not exist|deprecated|decommissioned|retired|not supported|invalid|unavailable|下线|下線|不存在|已停用)/i.test(text) ||
    /(no such model|unknown model|model_not_found|invalid model)/i.test(text);
  if (!looksLikeModelError || (status && ![400, 404, 410, 422].includes(status))) return text;
  return `此模型可能已停用或名稱有誤，請到設定頁按「取得模型清單」重新選擇。${text}`;
}

function isContextLengthError(errText) {
  return /context.{0,20}length|maximum context|too many tokens|payload too large|request entity too large|token limit/i.test(
    String(errText || '')
  );
}

function shouldUseGlossary(settings, pageContext) {
  const glossary = String(settings.customGlossary || '').trim();
  if (!glossary) return false;
  const isUserModified = glossary !== String(DEFAULT_GLOSSARY || '').trim();
  if (isUserModified) return true;
  const lang = resolveTargetLanguage(settings);
  if (lang.id !== 'zh-TW' && lang.id !== 'zh-CN') return false;
  if (!pageContext) return true;
  return Boolean(pageContext.useTechGlossary);
}

function buildCacheSignature(settings, pageContext) {
  const lang = resolveTargetLanguage(settings);
  const useGlossary = shouldUseGlossary(settings, pageContext);
  const glossaryHash = useGlossary
    ? hashText(String(settings.customGlossary || '').trim())
    : 'gen';
  const customLang = lang.id === 'custom' ? String(settings.customTargetLang || '').trim() : '';
  const effort = settings.thinkingEffort || 'fastest';
  return `${settings.protocol}:${settings.model}:${effort}:${lang.id}:${customLang}:${glossaryHash}`;
}

function buildLanguageGuidance(lang) {
  if (lang.id === 'zh-TW') {
    return [
      '目標語言：繁體中文（台灣慣用語與台灣繁體字形）。',
      '用語規範：請使用自然道地的台灣用語（例如：資料、欄位、函式、參數、迴圈、模型、特徵、驗證集、過度擬合、管線、程式碼、執行、錯誤訊息），切勿混用簡體字或中國大陸慣用語（如「数据、函数、过拟合、循环、代码、报错」）。'
    ].join('\n');
  }
  if (lang.id === 'zh-CN') {
    return '目标语言：简体中文（自然流利的中国大陆表达与技术术语）。';
  }
  return `Target language: ${lang.promptName}. Translate accurately using natural, idiomatic phrasing in that language.`;
}

function buildGlossarySection(settings, pageContext) {
  if (!shouldUseGlossary(settings, pageContext)) return '';
  const lang = resolveTargetLanguage(settings);
  const glossary = String(settings.customGlossary || '').trim();
  if (!glossary) return '';
  let glossaryNote;
  if (lang.id === 'zh-CN') {
    glossaryNote = '參考術語表（若術語表為繁體寫法，輸出時請自動轉為對應簡體字形與中國大陸技術用語）：';
  } else if (lang.id === 'zh-TW') {
    glossaryNote = '參考術語表（若語意符合請優先採用一致譯法）：';
  } else {
    glossaryNote = 'Custom Terminology Glossary (apply consistently where contextually appropriate):';
  }
  return `\n${glossaryNote}\n${glossary}\n`;
}

function buildRoleAndTopicLines(pageContext) {
  const isTech = !pageContext || Boolean(pageContext.useTechGlossary);
  const roleLine = isTech
    ? 'Expert technical translator for software engineering, ML, Data Science, Python, Kaggle & documentation.'
    : 'Expert web translator. Translate accurately with natural, idiomatic phrasing preserving the original tone and structure.';
  const cleanTitle = String(pageContext?.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const topicLine = cleanTitle ? `Page topic: ${cleanTitle}` : '';
  return { roleLine, topicLine };
}

const PLACEHOLDER_PRESERVE_RULE =
  '1. Keep atomic placeholders [[C0]] (code), [[M0]] (math/citations), [[L0]] (untranslatable link) verbatim; paired tags [[A0]]…[[/A0]] (link) and [[S0]]…[[/S0]] (bold/italic/emphasis) must each appear exactly once, wrapping the TRANSLATED words that correspond to the original wrapped words, properly nested, never translated, renamed, re-numbered, or removed; do not add tags that were not in the input.';

function isUntranslatedEcho(sourceText, translatedText, targetLangId = 'zh-TW') {
  const stripTokens = (s) =>
    String(s || '')
      .replace(/\[\[\s*\/?[CMLAS]\d*\s*\]\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const cleanSrc = stripTokens(sourceText);
  const cleanTrans = stripTokens(translatedText);
  if (!cleanSrc || !cleanTrans) return false;

  const srcLatinWords = cleanSrc.match(/[A-Za-z]{3,}/g) || [];
  if (srcLatinWords.length < 6) return false;

  const srcLowerProseWords = cleanSrc.match(/\b[a-z]{3,}\b/g) || [];
  if (srcLowerProseWords.length < 3) return false;

  const target = String(targetLangId || 'zh-TW');
  if (target === 'zh-TW' || target === 'zh-CN') {
    const hanCount = (cleanTrans.match(/\p{Script=Han}/gu) || []).length;
    if (hanCount === 0) return true;
    if (srcLatinWords.length >= 12 && hanCount < 3) return true;
    return false;
  }
  if (target === 'ja') {
    const jpCount = (cleanTrans.match(/[\p{Script=Han}\u3040-\u309f\u30a0-\u30ff]/gu) || []).length;
    if (srcLatinWords.length >= 8 && jpCount < 2) return true;
    return false;
  }
  if (target === 'ko') {
    const koCount = (cleanTrans.match(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/gu) || []).length;
    if (srcLatinWords.length >= 8 && koCount < 2) return true;
    return false;
  }

  if (srcLatinWords.length >= 10 && cleanTrans.toLowerCase() === cleanSrc.toLowerCase()) {
    return true;
  }
  return false;
}

function buildSystemPrompt(settings, pageContext) {
  const lang = resolveTargetLanguage(settings);
  const { roleLine, topicLine } = buildRoleAndTopicLines(pageContext);
  const glossarySection = buildGlossarySection(settings, pageContext);

  return [
    roleLine,
    topicLine,
    buildLanguageGuidance(lang),
    'Rules:',
    PLACEHOLDER_PRESERVE_RULE,
    '2. Keep code identifiers, package/class/function names, URLs, and standard abbreviations (MAE, RMSE, AUC, CV, SQL, API) intact.',
    '3. For `"kind":"comment"`, keep the leading `# ` prefix and return only the concise translated comment text.',
    '4. Output ONLY valid JSON: {"translations":[{"id":0,"zh":"..."},...]} matching all input ids.',
    '5. NEVER leave natural-language prose untranslated or echo the source text even if it starts with formulas or [[M0]] placeholders; ALWAYS translate all prose sentences into the target language.',
    glossarySection
  ].filter(Boolean).join('\n');
}

function buildStreamSystemPrompt(settings, pageContext) {
  const lang = resolveTargetLanguage(settings);
  const { roleLine, topicLine } = buildRoleAndTopicLines(pageContext);
  const glossarySection = buildGlossarySection(settings, pageContext);

  return [
    roleLine,
    topicLine,
    buildLanguageGuidance(lang),
    'Rules:',
    PLACEHOLDER_PRESERVE_RULE,
    '2. Keep code identifiers, package/class/function names, URLs, and standard abbreviations intact.',
    '3. For `"kind":"comment"`, keep the leading `# ` prefix and return only the concise translated comment text.',
    '4. Output STRICT NDJSON: exactly ONE JSON object per line in the format {"i":0,"t":"..."} matching every input index `i`, in order.',
    '5. NO markdown code fences (no ```), NO surrounding array [...], NO wrapper object, NO extra text.',
    '6. NEVER leave natural-language prose untranslated or echo the source text even if it starts with formulas or [[M0]] placeholders; ALWAYS translate all prose sentences into the target language.',
    glossarySection
  ].filter(Boolean).join('\n');
}

function parseJsonLenient(rawSlice) {
  const str = String(rawSlice || '');
  try {
    return JSON.parse(str);
  } catch (firstErr) {
    let out = '';
    let inStr = false;
    let escaped = false;
    let changed = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (escaped) {
          out += ch;
          escaped = false;
        } else if (ch === '\\') {
          out += ch;
          escaped = true;
        } else if (ch === '"') {
          out += ch;
          inStr = false;
        } else {
          const code = ch.charCodeAt(0);
          if (code < 0x20) {
            if (ch === '\n') out += '\\n';
            else if (ch === '\r') out += '\\r';
            else if (ch === '\t') out += '\\t';
            else out += `\\u${code.toString(16).padStart(4, '0')}`;
            changed = true;
          } else {
            out += ch;
          }
        }
      } else {
        if (ch === '"') inStr = true;
        out += ch;
      }
    }
    if (!changed) throw firstErr;
    return JSON.parse(out);
  }
}

function scanBalancedBracketArray(candidate) {
  for (let start = 0; start < candidate.length; start++) {
    if (candidate[start] !== '[') continue;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '[' || ch === '{') depth += 1;
        else if (ch === ']' || ch === '}') {
          depth -= 1;
          if (depth === 0) {
            if (ch === ']') {
              try {
                return { ok: true, value: parseJsonLenient(candidate.slice(start, i + 1)) };
              } catch (_) {}
            }
            break;
          }
        }
      }
    }
  }
  return { ok: false, value: null };
}

function scanTopLevelObjects(candidate) {
  const objects = [];
  let i = 0;
  while (i < candidate.length) {
    if (candidate[i] !== '{') {
      i += 1;
      continue;
    }
    const objStart = i;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let matched = false;
    for (let j = objStart; j < candidate.length; j++) {
      const ch = candidate[j];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              const parsed = parseJsonLenient(candidate.slice(objStart, j + 1));
              objects.push(parsed);
              i = j + 1;
              matched = true;
            } catch (_) {}
            break;
          }
        }
      }
    }
    if (!matched) {
      i = objStart + 1;
    }
  }
  return objects;
}

function extractJsonObject(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) throw new Error('模型返回內容為空');

  try {
    return parseJsonLenient(trimmed);
  } catch (_) {}

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    try {
      return parseJsonLenient(fencedMatch[1].trim());
    } catch (_) {}
  }

  const candidate = trimmed
    .replace(/^\s*```(?:json)?\s*$/gim, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  if (candidate) {
    try {
      return parseJsonLenient(candidate);
    } catch (_) {}

    const firstObjIdx = candidate.indexOf('{');
    const firstArrIdx = candidate.indexOf('[');
    if (firstArrIdx !== -1 && (firstObjIdx === -1 || firstArrIdx < firstObjIdx)) {
      const arrResult = scanBalancedBracketArray(candidate);
      if (
        arrResult.ok &&
        Array.isArray(arrResult.value) &&
        (firstObjIdx === -1 || arrResult.value.some((el) => el && typeof el === 'object' && !Array.isArray(el)))
      ) {
        return arrResult.value;
      }
    }

    const objects = scanTopLevelObjects(candidate);
    if (objects.length === 1) return objects[0];
    if (objects.length > 1) return objects;

    if (firstArrIdx !== -1) {
      const arrResult = scanBalancedBracketArray(candidate);
      if (arrResult.ok) return arrResult.value;
    }
  }

  throw new Error('模型返回格式不是有效 JSON');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeAbortError(message = '請求已取消') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.isExternalAbort = true;
  err.noSplit = true;
  err.noRetry = true;
  return err;
}

// Per-provider scheduler + adaptive cooldown after HTTP 429/503 (isolates providers from each other)
const NORMAL_MAX_CONCURRENT = 3;
const providerPacingMap = new Map();

function getProviderPacingKey(settings) {
  const pid = String(settings?.providerId || '').trim();
  let host = '';
  try {
    const raw = String(settings?.baseUrl || '').trim();
    if (raw) host = new URL(raw).host.toLowerCase();
  } catch (_) {}
  if (pid && host) return `${pid}::${host}`;
  return pid || host || String(settings?.protocol || 'default');
}

function getPacingState(pacingKey = 'default') {
  const key = String(pacingKey || 'default');
  let st = providerPacingMap.get(key);
  if (!st) {
    st = {
      inFlightRequests: 0,
      slotWaiters: [],
      globalCooldownUntil: 0,
      adaptivePacingUntil: 0,
      adaptiveGapMs: 4300,
      lastRequestStartAt: 0,
      pacingTail: Promise.resolve()
    };
    providerPacingMap.set(key, st);
  }
  return st;
}

function getEffectiveMaxConcurrent(pacingKey = 'default') {
  const st = getPacingState(pacingKey);
  return Date.now() < st.adaptivePacingUntil ? 1 : NORMAL_MAX_CONCURRENT;
}

function abortableSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(makeAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function acquireRequestSlot(externalSignal, pacingKey = 'default') {
  if (externalSignal?.aborted) {
    throw makeAbortError();
  }
  const st = getPacingState(pacingKey);
  while (st.inFlightRequests >= getEffectiveMaxConcurrent(pacingKey)) {
    await new Promise((resolve, reject) => {
      const waiter = () => {
        if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const idx = st.slotWaiters.indexOf(waiter);
        if (idx !== -1) st.slotWaiters.splice(idx, 1);
        reject(makeAbortError());
      };
      if (externalSignal) {
        if (externalSignal.aborted) {
          reject(makeAbortError());
          return;
        }
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }
      st.slotWaiters.push(waiter);
    });
  }
  st.inFlightRequests += 1;

  const gate = st.pacingTail.then(async () => {
    if (externalSignal?.aborted) return;
    const cooldownWait = st.globalCooldownUntil - Date.now();
    if (cooldownWait > 0) {
      await abortableSleep(cooldownWait, externalSignal);
    }
    if (externalSignal?.aborted) return;
    if (Date.now() < st.adaptivePacingUntil) {
      const gapWait = st.lastRequestStartAt + st.adaptiveGapMs - Date.now();
      if (gapWait > 0) {
        await abortableSleep(gapWait, externalSignal);
      }
    }
    if (!externalSignal?.aborted) {
      st.lastRequestStartAt = Date.now();
    }
  });
  st.pacingTail = gate.catch(() => {});
  try {
    await gate;
  } catch (err) {
    releaseRequestSlot(pacingKey);
    throw err;
  }

  if (externalSignal?.aborted) {
    releaseRequestSlot(pacingKey);
    throw makeAbortError();
  }
}

function releaseRequestSlot(pacingKey = 'default') {
  const st = getPacingState(pacingKey);
  st.inFlightRequests = Math.max(0, st.inFlightRequests - 1);
  if (st.slotWaiters.length > 0 && st.inFlightRequests < getEffectiveMaxConcurrent(pacingKey)) {
    const wake = st.slotWaiters.shift();
    wake();
  }
}

function parseRetryDelayMs(errBody, response) {
  const retryAfter = response?.headers?.get?.('Retry-After');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.ceil(secs * 1000);
    }
  }
  const text = String(errBody || '');
  const jsonMatch = text.match(/"retryDelay"\s*:\s*"([0-9.]+)s"/i);
  if (jsonMatch) {
    const secs = Number(jsonMatch[1]);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  }
  const proseMatch = text.match(/retry in\s+([0-9.]+)s/i);
  if (proseMatch) {
    const secs = Number(proseMatch[1]);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  }
  return 0;
}

function handleRateLimitResponse(errBody, response, attempt, maxAttempts, apiKey = '', pacingKey = 'default') {
  const safeBody = redactApiKey(errBody, apiKey);
  const isDailyOrZeroQuota = /PerDay|RequestsPerDay|GenerateRequestsPerDay|"quotaValue"\s*:\s*"0"|limit:\s*0/i.test(safeBody);
  const retryDelayMs = parseRetryDelayMs(safeBody, response);
  if (!isDailyOrZeroQuota && attempt < maxAttempts && retryDelayMs <= 28000) {
    const waitMs = Math.min(26000, retryDelayMs > 0 ? retryDelayMs + 400 : 4500 * attempt);
    const now = Date.now();
    const st = getPacingState(pacingKey);
    st.adaptiveGapMs = 4300;
    st.adaptivePacingUntil = Math.max(st.adaptivePacingUntil, now + 90000);
    st.globalCooldownUntil = Math.max(st.globalCooldownUntil, now + waitMs);
    return { shouldRetry: true, waitMs };
  }
  const waitSec = retryDelayMs > 0 ? Math.ceil(retryDelayMs / 1000) : null;
  const rateHint = isDailyOrZeroQuota
    ? 'HTTP 429：已達每日免費額度上限（或模型配額為 0），建議切換 Tier 1 Key、更換模型或切換備援供應商'
    : waitSec
      ? `HTTP 429：請求頻率達上限，需等待約 ${waitSec}s（免費版限 5–15 RPM）`
      : `HTTP 429：請求頻率達上限 (${safeBody.slice(0, 160) || response.statusText})`;
  const httpErr = new Error(rateHint);
  httpErr.httpStatus = 429;
  httpErr.errorCode = isDailyOrZeroQuota ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED';
  httpErr.noSplit = true;
  httpErr.noRetry = true;
  return { shouldRetry: false, error: httpErr };
}

function computeOverloadBackoffMs(status, attempt, safeBody, response, pacingKey = 'default') {
  const retryDelayMs = parseRetryDelayMs(safeBody, response);
  const jitter = Math.floor(Math.random() * 450);
  const st = getPacingState(pacingKey);
  if (retryDelayMs > 0 && retryDelayMs <= 12000) {
    const now = Date.now();
    st.adaptiveGapMs = 2200;
    st.adaptivePacingUntil = Math.max(st.adaptivePacingUntil, now + 30000);
    st.globalCooldownUntil = Math.max(st.globalCooldownUntil, now + retryDelayMs + jitter);
    return retryDelayMs + jitter;
  }
  if (status === 503 || status === 529) {
    const waitMs = ([1500, 3500, 7000][attempt - 1] || 7000) + jitter;
    const now = Date.now();
    st.adaptiveGapMs = 2200;
    st.adaptivePacingUntil = Math.max(st.adaptivePacingUntil, now + 30000);
    st.globalCooldownUntil = Math.max(st.globalCooldownUntil, now + waitMs);
    return waitMs;
  }
  return 900 * attempt + Math.floor(Math.random() * 300);
}

function buildHttpFailureError(status, safeErrBody, apiKey = '') {
  const cleanBody = redactApiKey(safeErrBody, apiKey);
  const isOverload =
    status === 503 ||
    status === 529 ||
    ((!status || status >= 500) && /high demand|overloaded|UNAVAILABLE|capacity|temporarily unavailable/i.test(cleanBody));
  const errorCode = isOverload ? 'OVERLOADED' : `HTTP_${status}`;
  const fmt = formatApiError(cleanBody, status, errorCode);
  const msg = withModelHint(fmt.detailMsg || `HTTP ${status}: ${cleanBody.slice(0, 200)}`, status);
  const httpErr = new Error(msg);
  httpErr.httpStatus = status;
  httpErr.errorCode = errorCode;
  httpErr.rawError = cleanBody.slice(0, 240);
  httpErr.noRetry = true;
  httpErr.noSplit =
    status >= 500 ||
    status === 529 ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 422 ||
    status === 429 ||
    (status === 400 && !isContextLengthError(cleanBody));
  return httpErr;
}

function isFallbackEligibleError(err) {
  if (!err || err.isExternalAbort) return false;
  const status = Number(err?.httpStatus || 0);
  if ([400, 401, 402, 403, 404, 422].includes(status)) return false;
  const code = String(err?.errorCode || '').trim();
  if ([
    'NO_API_KEY',
    'NO_MODEL',
    'INVALID_API_KEY_CHARS',
    'VISION_UNSUPPORTED',
    'HTTP_400',
    'HTTP_401',
    'HTTP_402',
    'HTTP_403',
    'HTTP_404',
    'HTTP_422'
  ].includes(code)) {
    return false;
  }
  if ([429, 500, 502, 503, 504, 529].includes(status)) return true;
  return [
    'OVERLOADED',
    'QUOTA_EXCEEDED',
    'RATE_LIMITED',
    'HTTP_500',
    'HTTP_502',
    'HTTP_503',
    'HTTP_504',
    'HTTP_529',
    'TIMEOUT',
    'NETWORK_ERROR'
  ].includes(code);
}

function normalizeGeminiModelId(model) {
  return String(model || '').replace(/^models\//i, '').trim().toLowerCase();
}

function buildGeminiRequestBody(settings, messages, expectJson) {
  const systemMsg = messages.find((m) => m.role === 'system');
  const userMsgs = messages.filter((m) => m.role !== 'system');
  const normModel = normalizeGeminiModelId(settings.model);
  const isGemini3Or4 = /^gemini-(?:3|4)(?:[.\-]|$)/.test(normModel);

  const generationConfig = {};
  if (!isGemini3Or4) {
    generationConfig.temperature = Number(settings.temperature ?? 0.2);
  }
  const thinkingConfig = resolveThinkingConfig(settings.model, settings.thinkingEffort || 'fastest');
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }
  if (expectJson) {
    generationConfig.responseMimeType = 'application/json';
  }

  const body = {
    contents: userMsgs.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    generationConfig
  };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }
  return body;
}

function buildOpenAIRequestBody(settings, endpoint, messages, { expectJson = false, stream = false } = {}) {
  const model = String(settings.model || '').trim();
  const effort = settings.thinkingEffort || 'fastest';
  const isOpenAIReasoning = /^o[134](?:-|$)/i.test(model);
  const isDeepSeekReasoner = /deepseek-reasoner|^r1\b/i.test(model);

  const body = {
    model,
    messages
  };

  if (!isOpenAIReasoning && !isDeepSeekReasoner) {
    body.temperature = Number(settings.temperature ?? 0.2);
  }

  if (stream) {
    body.stream = true;
  }
  if (expectJson && !stream) {
    body.response_format = { type: 'json_object' };
  }

  // Avoid requesting reasoning tokens in fastest mode on known reasoning endpoints
  if (effort === 'fastest') {
    if (isOpenAIReasoning && /api\.openai\.com/i.test(endpoint)) {
      body.reasoning_effort = 'low';
    } else if (/^qwen3/i.test(model) && /dashscope\.aliyuncs\.com/i.test(endpoint)) {
      body.enable_thinking = false;
    }
  }

  return body;
}

async function callLLMChat(settings, messages, expectJson = true, externalSignal = null) {
  assertModelConfigured(settings);
  const endpoint = resolveEndpoint(settings);
  if (!endpoint) {
    throw new Error('API 地址無效，請檢查設定中的 Base URL');
  }

  const pacingKey = getProviderPacingKey(settings);
  const maxAttempts = 4;
  const maxNetworkOr5xxAttempts = 4;
  const maxTimeoutAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (externalSignal?.aborted) {
      throw makeAbortError();
    }
    let sleepAfterAttemptMs = 0;
    await acquireRequestSlot(externalSignal, pacingKey);
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 25000);

    try {
      let response;
      if (settings.protocol === 'gemini') {
        const body = buildGeminiRequestBody(settings, messages, expectJson);
        const headers = { 'Content-Type': 'application/json' };
        const cleanKey = sanitizeApiKey(settings.apiKey);
        if (cleanKey) {
          headers['x-goog-api-key'] = cleanKey;
        }
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } else if (settings.protocol === 'anthropic') {
        // Claude Messages API: JSON output is requested in the prompt (no prefill, no response_format)
        const headers = buildProviderAuthHeaders(settings, sanitizeApiKey(settings.apiKey));
        const body = buildAnthropicMessagesBody(settings, messages, { stream: false, maxTokens: 16000 });
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } else {
        // OpenAI-compatible (Azure OpenAI endpoints get the `api-key` header)
        const headers = buildProviderAuthHeaders(settings, sanitizeApiKey(settings.apiKey));
        const body = buildOpenAIRequestBody(settings, endpoint, messages, { expectJson, stream: false });
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });

        // Some OpenAI-compatible relays reject response_format or optional reasoning fields
        if (!response.ok && response.status === 400) {
          const errText = await response.text();
          if (/response_format|json_object|reasoning_effort|enable_thinking|temperature/i.test(errText)) {
            delete body.response_format;
            delete body.reasoning_effort;
            delete body.enable_thinking;
            if (/temperature/i.test(errText)) delete body.temperature;
            response = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: controller.signal
            });
          } else {
            const safeErrText = redactApiKey(errText, settings.apiKey);
            const badReq = new Error(withModelHint(`HTTP 400: ${safeErrText.slice(0, 260)}`, 400));
            badReq.httpStatus = 400;
            badReq.errorCode = 'HTTP_400';
            badReq.noSplit = !isContextLengthError(safeErrText);
            badReq.noRetry = true;
            throw badReq;
          }
        }
      }

      if (!response.ok) {
        const errBody = await response.text();
        const safeErrBody = redactApiKey(errBody, settings.apiKey);
        const status = response.status;
        if (status === 429) {
          const rl = handleRateLimitResponse(safeErrBody, response, attempt, maxAttempts, settings.apiKey, pacingKey);
          if (rl.shouldRetry) continue;
          throw rl.error;
        }
        if ((status >= 500 || status === 529) && attempt < maxNetworkOr5xxAttempts) {
          sleepAfterAttemptMs = computeOverloadBackoffMs(status, attempt, safeErrBody, response, pacingKey);
          continue;
        }
        throw buildHttpFailureError(status, safeErrBody || response.statusText, settings.apiKey);
      }

      const data = await response.json();
      if (settings.protocol === 'gemini') {
        const candidate = data?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const answerParts = parts.filter((p) => !p.thought && p.text);
        const text = (answerParts.length ? answerParts : parts).map((p) => p.text || '').join('');
        if (!text) {
          const reason = candidate?.finishReason ? ` (${candidate.finishReason})` : '';
          const msg = data?.error?.message
            ? redactApiKey(data.error.message, settings.apiKey)
            : `Gemini 未返回文本內容${reason}`;
          throw new Error(msg);
        }
        return text;
      } else if (settings.protocol === 'anthropic') {
        const text = extractAnthropicText(data);
        if (!text) {
          throw new Error('Claude 未返回文本內容');
        }
        return text;
      } else {
        const text = data?.choices?.[0]?.message?.content || '';
        if (!text) {
          const msg = data?.error?.message
            ? redactApiKey(data.error.message, settings.apiKey)
            : '模型未返回有效文本';
          throw new Error(msg);
        }
        return text;
      }
    } catch (err) {
      if (externalSignal?.aborted || err?.isExternalAbort) {
        throw makeAbortError();
      }
      lastError = err;
      if (err.name === 'AbortError' || timedOut) {
        lastError = new Error('請求逾時 (25s)，請檢查網路或 API 服務狀態');
        lastError.errorCode = 'TIMEOUT';
        lastError.noSplit = true;
        if (attempt < maxTimeoutAttempts) {
          sleepAfterAttemptMs = 700 * attempt;
          continue;
        }
        break;
      }
      if (lastError.noRetry) {
        break;
      }
      const isNetworkErr =
        err?.name === 'TypeError' ||
        /network|failed to fetch|load failed|networkerror|fetch/i.test(String(lastError.message));
      if (isNetworkErr) {
        lastError.errorCode = lastError.errorCode || 'NETWORK_ERROR';
        lastError.noSplit = true;
        if (attempt < maxNetworkOr5xxAttempts) {
          sleepAfterAttemptMs = 700 * attempt;
          continue;
        }
      }
      break;
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      releaseRequestSlot(pacingKey);
      if (sleepAfterAttemptMs > 0 && !externalSignal?.aborted) {
        await abortableSleep(sleepAfterAttemptMs, externalSignal);
      }
    }
  }

  throw lastError || new Error('翻譯請求失敗');
}

function extractNdjsonEntriesFromObject(obj) {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;

  const pushEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const rawIdx = entry.i ?? entry.id ?? entry.index;
    const rawText = typeof entry.t === 'string'
      ? entry.t
      : typeof entry.zh === 'string'
        ? entry.zh
        : typeof entry.translation === 'string'
          ? entry.translation
          : null;
    if (rawIdx !== undefined && rawText !== null) {
      const idx = Number(rawIdx);
      if (Number.isInteger(idx) && idx >= 0 && rawText.trim()) {
        results.push({ idx, text: rawText.trim() });
      }
    }
  };

  if (Array.isArray(obj)) {
    for (const item of obj) pushEntry(item);
  } else if (Array.isArray(obj.translations)) {
    for (const item of obj.translations) pushEntry(item);
  } else if (Array.isArray(obj.data)) {
    for (const item of obj.data) pushEntry(item);
  } else {
    pushEntry(obj);
  }
  return results;
}

function createIncrementalJsonScanner(onValue) {
  let buf = '';
  let pos = 0;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  let objStart = -1;

  const scanAvailable = () => {
    while (pos < buf.length) {
      const ch = buf[pos];
      if (depth === 0) {
        if (ch === '{') {
          depth = 1;
          objStart = pos;
          inStr = false;
          escaped = false;
        }
        pos += 1;
        continue;
      }

      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inStr = false;
        }
      } else {
        if (ch === '"') {
          inStr = true;
        } else if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0 && objStart !== -1) {
            const slice = buf.slice(objStart, pos + 1);
            let parsed = null;
            let ok = false;
            try {
              parsed = parseJsonLenient(slice);
              ok = true;
            } catch (_) {}

            if (ok) {
              try {
                onValue(parsed);
              } catch (_) {}
              buf = buf.slice(pos + 1);
              pos = 0;
              objStart = -1;
              inStr = false;
              escaped = false;
              continue;
            }
            pos = objStart + 1;
            depth = 0;
            objStart = -1;
            inStr = false;
            escaped = false;
            continue;
          }
        }
      }
      pos += 1;
    }

    if (depth === 0 && pos > 0) {
      buf = buf.slice(pos);
      pos = 0;
    }
  };

  return {
    feed(chunk) {
      if (!chunk) return;
      buf += String(chunk);
      scanAvailable();
    },
    flush() {
      let rewinds = 0;
      while (depth > 0 && objStart !== -1 && rewinds < 128) {
        rewinds += 1;
        buf = buf.slice(objStart + 1);
        pos = 0;
        depth = 0;
        objStart = -1;
        inStr = false;
        escaped = false;
        scanAvailable();
      }
      buf = '';
      pos = 0;
      depth = 0;
      objStart = -1;
      inStr = false;
      escaped = false;
    }
  };
}

function parseNdjsonLine(rawLine) {
  let clean = String(rawLine || '').trim();
  if (!clean || clean.startsWith('```') || clean === '[' || clean === ']' || clean === '],') {
    return [];
  }
  // Strip leading array bracket or trailing comma if model emitted JSON-array style lines
  if (clean.startsWith('[') && clean.includes('{')) {
    clean = clean.slice(1).trim();
  }
  if (clean.endsWith(',')) {
    clean = clean.slice(0, -1).trim();
  }
  if (clean.endsWith(']') && !clean.startsWith('[')) {
    clean = clean.slice(0, -1).trim();
  }
  if (!clean) return [];

  try {
    return extractNdjsonEntriesFromObject(JSON.parse(clean));
  } catch (_) {
    // Try extracting a single {...} slice or multiple concatenated {...}{...} objects on the same line
    const results = [];
    let start = clean.indexOf('{');
    while (start !== -1) {
      let depth = 0;
      let inStr = false;
      let escaped = false;
      let end = -1;
      for (let i = start; i < clean.length; i++) {
        const ch = clean[i];
        if (inStr) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inStr = false;
          }
        } else {
          if (ch === '"') inStr = true;
          else if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
      }
      if (end === -1) break;
      try {
        const parsed = JSON.parse(clean.slice(start, end + 1));
        results.push(...extractNdjsonEntriesFromObject(parsed));
      } catch (_) {}
      start = clean.indexOf('{', end + 1);
    }
    return results;
  }
}

function extractStreamTextDelta(protocol, chunkObj) {
  if (!chunkObj || typeof chunkObj !== 'object') return '';
  if (protocol === 'gemini') {
    const parts = chunkObj?.candidates?.[0]?.content?.parts || [];
    let out = '';
    for (const part of parts) {
      if (part && !part.thought && typeof part.text === 'string') {
        out += part.text;
      }
    }
    return out;
  }
  if (protocol === 'anthropic') {
    // Non-SSE fallback returns a whole message; SSE returns one event per line
    if (chunkObj.type === 'message' && Array.isArray(chunkObj.content)) {
      return chunkObj.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    }
    return extractAnthropicStreamDelta(chunkObj).text;
  }
  const choice = chunkObj?.choices?.[0];
  if (!choice) return '';
  if (typeof choice?.delta?.content === 'string') {
    return choice.delta.content;
  }
  if (typeof choice?.message?.content === 'string') {
    return choice.message.content;
  }
  return '';
}

async function streamTranslateItems(settings, items, pageContext, onItem, externalSignal = null, onProgress = null) {
  assertModelConfigured(settings);
  if (!items || items.length === 0) return 0;

  const endpoint = resolveStreamEndpoint(settings);
  if (!endpoint) {
    throw new Error('API 地址無效，請檢查設定中的 Base URL');
  }

  const pacingKey = getProviderPacingKey(settings);
  const payload = items.map((item, idx) =>
    item.kind === 'comment'
      ? { i: idx, kind: 'comment', text: item.text }
      : { i: idx, text: item.text }
  );
  const messages = [
    { role: 'system', content: buildStreamSystemPrompt(settings, pageContext) },
    { role: 'user', content: JSON.stringify(payload) }
  ];

  const maxAttempts = 4;
  const maxNetworkOr5xxAttempts = 4;
  const maxTimeoutAttempts = 2;
  let lastError = null;
  let emittedCount = 0;
  const emittedIndices = new Set();
  const emitEntry = (entry) => {
    if (!entry || !Number.isInteger(entry.idx)) return;
    if (entry.idx < 0 || entry.idx >= items.length) return;
    if (emittedIndices.has(entry.idx)) return;
    emittedIndices.add(entry.idx);
    emittedCount += 1;
    onItem(entry.idx, entry.text);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (externalSignal?.aborted) {
      throw makeAbortError();
    }
    let sleepAfterAttemptMs = 0;
    onProgress?.('attempt', { attempt, providerId: settings?.providerId || '' });
    await acquireRequestSlot(externalSignal, pacingKey);

    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    let idleTimeoutId = null;
    const resetIdleTimeout = () => {
      if (idleTimeoutId) clearTimeout(idleTimeoutId);
      idleTimeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 28000);
    };
    resetIdleTimeout();

    try {
      let response;
      const cleanKey = sanitizeApiKey(settings.apiKey);
      if (settings.protocol === 'gemini') {
        // Note: expectJson = false because NDJSON stream is multiple JSON objects, not a single JSON doc
        const body = buildGeminiRequestBody(settings, messages, false);
        const headers = { 'Content-Type': 'application/json' };
        if (cleanKey) {
          headers['x-goog-api-key'] = cleanKey;
        }
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } else if (settings.protocol === 'anthropic') {
        const headers = buildProviderAuthHeaders(settings, cleanKey);
        const body = buildAnthropicMessagesBody(settings, messages, { stream: true, maxTokens: 32000 });
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } else {
        const headers = buildProviderAuthHeaders(settings, cleanKey);
        const body = buildOpenAIRequestBody(settings, endpoint, messages, { expectJson: false, stream: true });
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!response.ok && response.status === 400) {
          const errText = await response.text();
          if (/reasoning_effort|enable_thinking|temperature/i.test(errText)) {
            delete body.reasoning_effort;
            delete body.enable_thinking;
            if (/temperature/i.test(errText)) delete body.temperature;
            response = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: controller.signal
            });
          } else {
            const safeErrText = redactApiKey(errText, settings.apiKey);
            const badReq = new Error(withModelHint(`HTTP 400: ${safeErrText.slice(0, 260)}`, 400));
            badReq.httpStatus = 400;
            badReq.errorCode = 'HTTP_400';
            badReq.noSplit = !isContextLengthError(safeErrText);
            badReq.noRetry = true;
            throw badReq;
          }
        }
      }

      if (!response.ok) {
        const errBody = await response.text();
        const safeErrBody = redactApiKey(errBody, settings.apiKey);
        const status = response.status;
        if (status === 429) {
          const rl = handleRateLimitResponse(safeErrBody, response, attempt, maxAttempts, settings.apiKey, pacingKey);
          if (rl.shouldRetry) {
            onProgress?.('backoff', { status: 429, attempt, waitMs: rl.waitMs || 0 });
            continue;
          }
          throw rl.error;
        }
        if ((status >= 500 || status === 529) && attempt < maxNetworkOr5xxAttempts) {
          sleepAfterAttemptMs = computeOverloadBackoffMs(status, attempt, safeErrBody, response, pacingKey);
          onProgress?.('backoff', { status, attempt, waitMs: sleepAfterAttemptMs });
          continue;
        }
        throw buildHttpFailureError(status, safeErrBody || response.statusText, settings.apiKey);
      }

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!response.body || (contentType.includes('application/json') && !contentType.includes('event-stream'))) {
        // Relay returned a non-SSE JSON payload (or Gemini chunk array); extract text and parse via scanner/JSON
        const data = await response.json();
        const fullText = Array.isArray(data)
          ? data.map((chunk) => extractStreamTextDelta(settings.protocol, chunk)).join('')
          : extractStreamTextDelta(settings.protocol, data);
        const apiErrMsg = Array.isArray(data)
          ? data.find((chunk) => chunk?.error?.message)?.error?.message
          : data?.error?.message;
        if (!fullText && apiErrMsg) {
          const errObj = new Error(redactApiKey(apiErrMsg, settings.apiKey));
          errObj.noRetry = true;
          errObj.noSplit = true;
          throw errObj;
        }
        const nonSseScanner = createIncrementalJsonScanner((obj) => {
          for (const entry of extractNdjsonEntriesFromObject(obj)) {
            emitEntry(entry);
          }
        });
        nonSseScanner.feed(fullText);
        nonSseScanner.flush();
        if (emittedCount < items.length && String(fullText || '').trim()) {
          try {
            const parsed = extractJsonObject(fullText);
            for (const entry of extractNdjsonEntriesFromObject(parsed)) {
              emitEntry(entry);
            }
          } catch (_) {}
        }
        return emittedCount;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let sseBuffer = '';
      let fullAccumulatedText = '';
      let streamApiError = '';

      const jsonScanner = createIncrementalJsonScanner((obj) => {
        for (const entry of extractNdjsonEntriesFromObject(obj)) {
          emitEntry(entry);
        }
      });

      const handleSseLine = (rawLine) => {
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.startsWith(':')) return;
        const trimmedStart = line.trimStart();
        if (!trimmedStart.startsWith('data:')) return;
        const dataStr = trimmedStart.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') return;

        let parsedChunk;
        try {
          parsedChunk = JSON.parse(dataStr);
        } catch (_) {
          return;
        }
        if (parsedChunk?.error?.message && !streamApiError) {
          streamApiError = redactApiKey(parsedChunk.error.message, settings.apiKey);
        }
        const deltaText = extractStreamTextDelta(settings.protocol, parsedChunk);
        if (deltaText) {
          fullAccumulatedText += deltaText;
          jsonScanner.feed(deltaText);
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          resetIdleTimeout();
          if (externalSignal?.aborted) {
            throw makeAbortError();
          }
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';
          for (const line of lines) {
            handleSseLine(line);
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch (_) {}
      }

      // Final flush
      sseBuffer += decoder.decode();
      if (sseBuffer) {
        for (const line of sseBuffer.split('\n')) {
          handleSseLine(line);
        }
      }
      jsonScanner.flush();

      if (emittedCount === 0 && streamApiError) {
        const errObj = new Error(streamApiError);
        errObj.noRetry = true;
        errObj.noSplit = true;
        throw errObj;
      }

      // Defensive recovery for any unemitted items across fenced/array/multi-object outputs
      if (emittedCount < items.length && fullAccumulatedText.trim()) {
        try {
          const parsed = extractJsonObject(fullAccumulatedText);
          for (const entry of extractNdjsonEntriesFromObject(parsed)) {
            emitEntry(entry);
          }
        } catch (_) {}
      }

      return emittedCount;
    } catch (err) {
      if (externalSignal?.aborted || err?.isExternalAbort) {
        throw makeAbortError();
      }
      lastError = err;
      if (err.name === 'AbortError' || timedOut) {
        lastError = new Error('串流請求逾時，請檢查網路或 API 服務狀態');
        lastError.errorCode = 'TIMEOUT';
        lastError.noSplit = true;
        if (attempt < maxTimeoutAttempts && emittedCount === 0) {
          sleepAfterAttemptMs = 700 * attempt;
          onProgress?.('backoff', { status: 0, attempt, waitMs: sleepAfterAttemptMs, reason: 'timeout' });
          continue;
        }
        break;
      }
      if (lastError.noRetry || emittedCount > 0) {
        break;
      }
      const isNetworkErr =
        err?.name === 'TypeError' ||
        /network|failed to fetch|load failed|networkerror|fetch/i.test(String(lastError.message));
      if (isNetworkErr) {
        lastError.errorCode = lastError.errorCode || 'NETWORK_ERROR';
        lastError.noSplit = true;
        if (attempt < maxNetworkOr5xxAttempts) {
          sleepAfterAttemptMs = 700 * attempt;
          onProgress?.('backoff', { status: 0, attempt, waitMs: sleepAfterAttemptMs, reason: 'network' });
          continue;
        }
      }
      break;
    } finally {
      if (idleTimeoutId) clearTimeout(idleTimeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      releaseRequestSlot(pacingKey);
      if (sleepAfterAttemptMs > 0 && !externalSignal?.aborted) {
        await abortableSleep(sleepAfterAttemptMs, externalSignal);
      }
    }
  }

  throw lastError || new Error('串流翻譯失敗');
}

async function translateItemsWithFallback(settings, items, pageContext = null, externalSignal = null, state = null, depth = 0) {
  if (!items || items.length === 0) return {};
  if (externalSignal?.aborted) throw makeAbortError();

  const shared = state || {
    requestsUsed: 0,
    maxRequests: Math.min(8, Math.max(4, Math.ceil(items.length / 2) + 2)),
    maxDepth: 3
  };

  if (shared.requestsUsed >= shared.maxRequests) {
    const budgetErr = new Error('已達單批重試請求上限');
    budgetErr.noSplit = true;
    throw budgetErr;
  }
  shared.requestsUsed += 1;

  const lang = resolveTargetLanguage(settings);
  const payload = items.map((item, idx) =>
    item.kind === 'comment'
      ? { id: idx, kind: 'comment', text: item.text }
      : { id: idx, text: item.text }
  );
  const systemPrompt = buildSystemPrompt(settings, pageContext);
  const userPrompt = JSON.stringify(payload);

  try {
    const raw = await callLLMChat(
      settings,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      true,
      externalSignal
    );

    const parsed = extractJsonObject(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.translations)
        ? parsed.translations
        : Array.isArray(parsed?.data)
          ? parsed.data
          : (parsed && typeof parsed === 'object' &&
              (parsed.id ?? parsed.i ?? parsed.index) !== undefined &&
              (typeof parsed.zh === 'string' || typeof parsed.t === 'string' || typeof parsed.translation === 'string'))
            ? [parsed]
            : null;

    if (!list) {
      throw new Error('JSON 中缺少 translations 陣列');
    }

    const mapped = {};
    const missing = [];
    const byId = new Map();
    for (const entry of list) {
      const rawId = entry?.id ?? entry?.i ?? entry?.index;
      const val = typeof entry?.zh === 'string'
        ? entry.zh
        : typeof entry?.t === 'string'
          ? entry.t
          : typeof entry?.translation === 'string'
            ? entry.translation
            : null;
      if (entry && rawId !== undefined && val !== null) {
        byId.set(Number(rawId), val.trim());
      }
    }

    for (let idx = 0; idx < items.length; idx++) {
      const zh = byId.get(idx);
      if (zh && !isUntranslatedEcho(items[idx].text, zh, lang.id)) {
        mapped[items[idx].key] = zh;
      } else {
        missing.push(items[idx]);
      }
    }

    if (missing.length > 0 && missing.length < items.length) {
      if (depth < shared.maxDepth && shared.requestsUsed < shared.maxRequests) {
        try {
          const rest = await translateItemsWithFallback(
            settings,
            missing,
            pageContext,
            externalSignal,
            shared,
            depth + 1
          );
          Object.assign(mapped, rest);
        } catch (missingErr) {
          if (missingErr?.isExternalAbort || externalSignal?.aborted) {
            throw missingErr;
          }
          // Preserve partial mapped items
        }
      }
    } else if (missing.length === items.length) {
      throw new Error('回傳結果未匹配任何輸入段落');
    }

    return mapped;
  } catch (err) {
    if (err?.noSplit || err?.isExternalAbort || externalSignal?.aborted) {
      throw err;
    }
    if (items.length > 1) {
      if (depth >= shared.maxDepth || shared.requestsUsed >= shared.maxRequests) {
        throw err;
      }
      const mid = Math.ceil(items.length / 2);
      const combined = {};
      let lastSubErr = null;

      try {
        const left = await translateItemsWithFallback(
          settings,
          items.slice(0, mid),
          pageContext,
          externalSignal,
          shared,
          depth + 1
        );
        Object.assign(combined, left);
      } catch (leftErr) {
        if (leftErr?.noSplit || leftErr?.isExternalAbort || externalSignal?.aborted) {
          throw leftErr;
        }
        lastSubErr = leftErr;
      }

      if (shared.requestsUsed < shared.maxRequests) {
        try {
          const right = await translateItemsWithFallback(
            settings,
            items.slice(mid),
            pageContext,
            externalSignal,
            shared,
            depth + 1
          );
          Object.assign(combined, right);
        } catch (rightErr) {
          if (rightErr?.isExternalAbort || externalSignal?.aborted) {
            throw rightErr;
          }
          if (rightErr?.noSplit) {
            if (Object.keys(combined).length > 0) return combined;
            throw rightErr;
          }
          lastSubErr = rightErr;
        }
      }

      if (Object.keys(combined).length > 0) {
        return combined;
      }
      throw lastSubErr || err;
    }

    // Single item fallback: plain text prompt (more tolerant than strict JSON)
    if (shared.requestsUsed >= shared.maxRequests) {
      throw err;
    }
    shared.requestsUsed += 1;
    const single = items[0];
    const singleRule = single.kind === 'comment'
      ? `You are a Python & technical translator. Translate this single-line # comment into ${lang.promptName}. Preserve the leading "# " prefix and output only the translated comment line.`
      : `You are a web & technical translator. Translate the user text into ${lang.promptName}. Keep atomic placeholders [[C0]] (code), [[M0]] (math/citations), [[L0]] (untranslatable link) verbatim; paired tags [[A0]]…[[/A0]] (link) and [[S0]]…[[/S0]] (bold/italic/emphasis) must each appear exactly once wrapping the translated words corresponding to the original wrapped words, properly nested, never translated/renamed/re-numbered/removed, without adding new tags; ALWAYS translate all natural-language prose even if mixed with formulas or [[M0]] placeholders (never echo untranslated source prose); output only the translation.`;
    const plain = await callLLMChat(
      settings,
      [
        {
          role: 'system',
          content: `${singleRule}\n${buildLanguageGuidance(lang)}`
        },
        { role: 'user', content: single.text }
      ],
      false,
      externalSignal
    );
    return { [single.key]: String(plain || '').trim() };
  }
}

async function handleTranslateBatch(items, pageContext = null) {
  const bid = nextBatchSeq++;
  activeBatchDebug.set(bid, {
    id: bid,
    total: items.length,
    sample: items.slice(0, 2).map((x) => String(x.text || '').slice(0, 40)),
    startedAt: Date.now(),
    stage: 'start'
  });

  const settings = await getSettings();
  if (!sanitizeApiKey(settings.apiKey) && !isLocalEndpoint(settings.baseUrl)) {
    finishBatchEvent(bid, { stage: 'no_key' });
    return {
      ok: false,
      errorCode: 'NO_API_KEY',
      error: '尚未設定大模型 API Key，請點選擴充功能圖示或前往設定頁填寫。'
    };
  }

  const lang = resolveTargetLanguage(settings);
  const sig = buildCacheSignature(settings, pageContext);
  const cacheKeys = items.map((item) => `${sig}::${item.key}`);
  const cachedMap = await CacheDB.getMany(cacheKeys);

  const results = {};
  const uncached = [];

  for (const item of items) {
    const cacheKey = `${sig}::${item.key}`;
    const cachedZh = cachedMap.get(cacheKey);
    if (
      typeof cachedZh === 'string' &&
      cachedZh.trim() &&
      !isUntranslatedEcho(item.text, cachedZh, lang.id)
    ) {
      results[item.key] = { zh: cachedZh, cached: true };
    } else {
      uncached.push({ ...item, cacheKey });
    }
  }

  recordBatchEvent(bid, { stage: 'calling_llm', uncached: uncached.length, cached: items.length - uncached.length });
  if (uncached.length > 0) {
    let fallbackUsed = null;
    try {
      let translatedMap = null;
      let activeSig = sig;
      let activeSettings = settings;
      let itemsToTranslate = uncached;

      try {
        translatedMap = await translateItemsWithFallback(activeSettings, itemsToTranslate, pageContext);
      } catch (primaryErr) {
        const fbSettings = isFallbackEligibleError(primaryErr) ? resolveFallbackSettings(settings) : null;
        if (!fbSettings) {
          throw primaryErr;
        }
        recordBatchEvent(bid, { stage: 'fallback_provider', provider: fbSettings.providerId, model: fbSettings.model });
        activeSettings = fbSettings;
        activeSig = buildCacheSignature(fbSettings, pageContext);
        const fbKeys = itemsToTranslate.map((it) => `${activeSig}::${it.key}`);
        const fbCachedMap = await CacheDB.getMany(fbKeys);
        const fbUncached = [];
        for (const it of itemsToTranslate) {
          const fbCacheKey = `${activeSig}::${it.key}`;
          const fbHit = fbCachedMap.get(fbCacheKey);
          if (typeof fbHit === 'string' && fbHit.trim() && !isUntranslatedEcho(it.text, fbHit, lang.id)) {
            results[it.key] = { zh: fbHit, cached: true };
          } else {
            fbUncached.push({ ...it, cacheKey: fbCacheKey });
          }
        }
        translatedMap = fbUncached.length > 0
          ? await translateItemsWithFallback(fbSettings, fbUncached, pageContext)
          : {};
        itemsToTranslate = fbUncached;
        fallbackUsed = {
          providerId: fbSettings.providerId,
          label: PROVIDER_PRESETS[fbSettings.providerId]?.label || fbSettings.providerId,
          model: fbSettings.model
        };
      }

      const toPersist = [];
      for (const item of itemsToTranslate) {
        const zh = translatedMap[item.key];
        if (zh) {
          results[item.key] = { zh, cached: false };
          if (!isUntranslatedEcho(item.text, zh, lang.id)) {
            toPersist.push({ key: item.cacheKey, zh });
          }
        }
      }
      if (toPersist.length > 0) {
        await CacheDB.putMany(toPersist);
      }
      finishBatchEvent(bid, { stage: 'done', translated: toPersist.length, fallback: fallbackUsed?.providerId || '' });
    } catch (err) {
      finishBatchEvent(bid, { stage: 'error', error: redactAllKeys(err?.message || String(err), settings, activeSettings) });
      throw err;
    }
    return fallbackUsed ? { ok: true, results, fallbackUsed } : { ok: true, results };
  } else {
    finishBatchEvent(bid, { stage: 'done_cached', translated: 0 });
  }

  return { ok: true, results };
}

async function handleTranslateSingle(text, mode = 'selection', pageContext = null) {
  const settings = await getSettings();
  if (!sanitizeApiKey(settings.apiKey) && !isLocalEndpoint(settings.baseUrl)) {
    return {
      ok: false,
      errorCode: 'NO_API_KEY',
      error: '尚未設定大模型 API Key，請先開啟設定頁面填寫。'
    };
  }

  const lang = resolveTargetLanguage(settings);
  const langGuide = buildLanguageGuidance(lang);
  const cleanTitle = String(pageContext?.title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const topicHint = cleanTitle ? ` Page context: "${cleanTitle}".` : '';
  const systemContent = mode === 'output'
    ? `You are a Notebook & Python teaching assistant. The user provided code cell output (Hints, check() feedback, or a Python traceback). Translate it accurately into ${lang.promptName}, keeping code/variable names intact; if it is an error, add one concise sentence explaining the likely cause.${topicHint} ${langGuide}`
    : `You are an expert web and technical translator. Translate the selected text accurately into ${lang.promptName}, preserving technical identifiers naturally. Output only the concise translation.${topicHint} ${langGuide}`;

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: String(text || '') }
  ];

  let zh;
  let fallbackUsed = null;
  try {
    zh = await callLLMChat(settings, messages, false);
  } catch (err) {
    const fbSettings = isFallbackEligibleError(err) ? resolveFallbackSettings(settings) : null;
    if (!fbSettings) throw err;
    zh = await callLLMChat(fbSettings, messages, false);
    fallbackUsed = {
      providerId: fbSettings.providerId,
      label: PROVIDER_PRESETS[fbSettings.providerId]?.label || fbSettings.providerId,
      model: fbSettings.model
    };
  }

  return fallbackUsed
    ? { ok: true, zh: String(zh || '').trim(), fallbackUsed }
    : { ok: true, zh: String(zh || '').trim() };
}

const MODEL_LIST_CACHE_KEY = 'nr_model_list_v1';
const MODEL_LIST_MAX_CACHE_ENTRIES = 20;
const MODEL_LIST_MAX_PAGES = 5;
const MODEL_LIST_MAX_ITEMS = 500;
const MODEL_LIST_TIMEOUT_MS = 10000;

async function saveModelListCache(cacheKey, models) {
  try {
    const stored = await chrome.storage.local.get(MODEL_LIST_CACHE_KEY);
    const map =
      stored?.[MODEL_LIST_CACHE_KEY] && typeof stored[MODEL_LIST_CACHE_KEY] === 'object'
        ? { ...stored[MODEL_LIST_CACHE_KEY] }
        : {};

    map[cacheKey] = {
      models,
      fetchedAt: Date.now()
    };

    const entries = Object.entries(map).sort(
      (a, b) => (Number(a[1]?.fetchedAt) || 0) - (Number(b[1]?.fetchedAt) || 0)
    );
    while (entries.length > MODEL_LIST_MAX_CACHE_ENTRIES) {
      const [oldestKey] = entries.shift();
      delete map[oldestKey];
    }

    await chrome.storage.local.set({ [MODEL_LIST_CACHE_KEY]: map });
  } catch {
    // Ignore storage cache write failures
  }
}

async function handleListModels(settingsOverride) {
  const saved = await getSettings();
  const merged = { ...saved, ...(settingsOverride || {}) };
  const protocol = String(merged.protocol || 'openai').trim().toLowerCase();
  const cleanKey = sanitizeApiKey(merged.apiKey);

  if (isAzureOpenAIEndpoint(merged.baseUrl)) {
    return {
      ok: false,
      errorCode: 'AZURE_DEPLOYMENTS',
      error: 'Azure OpenAI 請在模型欄位填入「部署名稱」，無法從此 API 列出部署。'
    };
  }

  const allowEmptyPublicKey = Boolean(PROVIDER_PRESETS?.[merged.providerId]?.publicModelList);
  if (!cleanKey && !allowEmptyPublicKey && !isLocalEndpoint(merged.baseUrl)) {
    return {
      ok: false,
      errorCode: 'MISSING_API_KEY',
      error: '請先填寫 API Key'
    };
  }

  const firstUrl = buildListModelsUrl(merged, '');
  if (!firstUrl) {
    return {
      ok: false,
      errorCode: 'INVALID_URL',
      error: 'API Base URL 格式不正確，無法查詢模型清單'
    };
  }

  const normalizedBase = firstUrl.split('?')[0].replace(/\/models$/i, '');
  const cacheKey = `${protocol}|${normalizedBase}`;
  const headers = buildProviderAuthHeaders(merged, cleanKey);

  const collected = new Set();
  let pageToken = '';
  const maxPages = protocol === 'openai' ? 1 : MODEL_LIST_MAX_PAGES;

  try {
    for (let page = 0; page < maxPages; page++) {
      const url = page === 0 ? firstUrl : buildListModelsUrl(merged, pageToken);
      if (!url) break;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal
        });
      } catch (fetchErr) {
        if (fetchErr?.name === 'AbortError') {
          return {
            ok: false,
            errorCode: 'TIMEOUT',
            error: '取得模型清單逾時（超過 10 秒），請檢查網路或 API Base URL'
          };
        }
        return {
          ok: false,
          errorCode: 'NETWORK_ERROR',
          error: redactApiKey(
            `網路連線失敗：${fetchErr?.message || '無法連線至服務商'}`,
            cleanKey
          )
        };
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) {
          return {
            ok: false,
            errorCode: 'AUTH_ERROR',
            error: `API Key 無效或沒有權限查詢模型清單（HTTP ${status}）`
          };
        }
        if (status === 404) {
          return {
            ok: false,
            errorCode: 'NOT_SUPPORTED',
            error: '此服務商不支援列出模型（HTTP 404），請直接輸入模型名稱'
          };
        }
        const errBody = await response.text().catch(() => '');
        const snippet = redactApiKey(errBody.slice(0, 200).trim(), cleanKey);
        return {
          ok: false,
          errorCode: `HTTP_${status}`,
          error: snippet
            ? `查詢模型清單失敗（HTTP ${status}）：${snippet}`
            : `查詢模型清單失敗（HTTP ${status}）`
        };
      }

      let data;
      try {
        data = await response.json();
      } catch {
        return {
          ok: false,
          errorCode: 'INVALID_JSON',
          error: '服務商回傳格式非有效 JSON，無法解析模型清單'
        };
      }

      const parsed = parseListModelsResponse(protocol, data);
      for (const id of parsed.ids) {
        collected.add(id);
      }

      if (!parsed.nextPageToken || parsed.nextPageToken === pageToken) {
        break;
      }
      pageToken = parsed.nextPageToken;
    }

    const models = Array.from(collected)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MODEL_LIST_MAX_ITEMS);

    await saveModelListCache(cacheKey, models);
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'UNKNOWN_ERROR',
      error: redactApiKey(err?.message || '取得模型清單時發生未知錯誤', cleanKey)
    };
  }
}

async function handleTestConnection(settingsOverride) {
  const saved = await getSettings();
  const merged = { ...saved, ...(settingsOverride || {}) };
  if (!sanitizeApiKey(merged.apiKey) && !isLocalEndpoint(merged.baseUrl)) {
    return { ok: false, error: '請先填寫 API Key' };
  }
  if (!String(merged.model || '').trim()) {
    return { ok: false, error: '請先選擇模型：按「取得模型清單」後從模型欄位選擇，或直接輸入模型名稱' };
  }

  const lang = resolveTargetLanguage(merged);
  const start = Date.now();
  const reply = await callLLMChat(
    merged,
    [
      {
        role: 'system',
        content: `Translate English to ${lang.promptName}. Output only the translation. ${buildLanguageGuidance(lang)}`
      },
      { role: 'user', content: 'Cross-validation helps prevent overfitting.' }
    ],
    false
  );
  const latencyMs = Date.now() - start;
  return { ok: true, reply: String(reply || '').trim(), latencyMs };
}

// ============================================================
// Dynamic On-Demand Injection & Seamless PDF Reader Launcher
// ============================================================

function isExtensionSender(sender) {
  if (!sender) return false;
  const extOrigin = chrome.runtime.getURL('');
  if (sender.url && sender.url.startsWith(extOrigin)) return true;
  return !sender.tab && sender.id === chrome.runtime.id;
}

async function isFileSchemeAccessAllowed() {
  if (typeof chrome?.extension?.isAllowedFileSchemeAccess !== 'function') {
    return false;
  }
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => {
        void chrome.runtime.lastError;
        resolve(Boolean(allowed));
      });
    } catch (_) {
      resolve(false);
    }
  });
}

const PDF_MAX_BYTES = 100 * 1024 * 1024;
const PDF_CHUNK_BYTES = 1572864; // Exact multiple of 3 for clean base64 slices
const BG_TAB_LOAD_TIMEOUT_MS = 18000;

function hasPdfSignature(bytes) {
  if (!bytes || typeof bytes.length !== 'number') return false;
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i <= limit - 5; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

function getSiteKeyFromHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return '';
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

async function openPdfViewer(pdfUrl, sourceTab = null) {
  const baseUrl = chrome.runtime.getURL('viewer/pdf-viewer.html');
  let cleanUrl = typeof pdfUrl === 'string' ? pdfUrl.trim() : '';
  let parsed = null;
  if (cleanUrl) {
    try {
      parsed = new URL(cleanUrl);
      if (parsed.protocol === 'file:') {
        if (!isFilePdfUrl(cleanUrl)) {
          cleanUrl = '';
          parsed = null;
        }
      } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        cleanUrl = '';
        parsed = null;
      }
    } catch (_) {
      cleanUrl = '';
      parsed = null;
    }
  }

  let targetUrl = baseUrl;
  let resultMeta = { isFileUrl: false, fileAccessAllowed: null };

  if (cleanUrl && parsed?.protocol === 'file:') {
    const fileAccessAllowed = await isFileSchemeAccessAllowed();
    if (fileAccessAllowed) {
      targetUrl = `${baseUrl}?src=${encodeURIComponent(cleanUrl)}`;
      resultMeta = { isFileUrl: true, fileAccessAllowed: true };
    } else {
      let fileName = 'local.pdf';
      try {
        const rawSeg = parsed.pathname.split('/').pop() || '';
        if (rawSeg) fileName = decodeURIComponent(rawSeg);
      } catch (_) {}
      targetUrl = `${baseUrl}?fileAccess=denied&name=${encodeURIComponent(fileName)}`;
      resultMeta = { isFileUrl: true, fileAccessAllowed: false, fileName };
    }
  } else if (cleanUrl) {
    const tabSuffix = sourceTab && typeof sourceTab.id === 'number'
      ? `&tabId=${encodeURIComponent(String(sourceTab.id))}`
      : '';
    targetUrl = `${baseUrl}?src=${encodeURIComponent(cleanUrl)}${tabSuffix}`;
  }

  const createProps = { url: targetUrl, active: true };
  if (sourceTab && typeof sourceTab.index === 'number') {
    createProps.index = sourceTab.index + 1;
  }
  if (sourceTab && typeof sourceTab.windowId === 'number') {
    createProps.windowId = sourceTab.windowId;
  }
  await chrome.tabs.create(createProps);
  return resultMeta;
}

async function probeTabFramesForPdf(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const isPdfDoc =
          document.contentType === 'application/pdf' ||
          (Boolean(document.body) &&
            document.body.children.length === 1 &&
            Boolean(document.body.querySelector(':scope > embed[type="application/pdf"]')));
        let detectedHref = '';
        if (!isPdfDoc && window === window.top) {
          const resolveAbs = (raw) => {
            if (!raw || typeof raw !== 'string') return '';
            try {
              const u = new URL(raw.trim(), location.href);
              return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : '';
            } catch (_) {
              return '';
            }
          };
          const embedEl =
            document.querySelector('embed[type="application/pdf"][src]') ||
            document.querySelector('object[type="application/pdf"][data]');
          if (embedEl) {
            detectedHref = resolveAbs(embedEl.getAttribute('src') || embedEl.getAttribute('data'));
          }
          if (!detectedHref) {
            const iframes = document.querySelectorAll('iframe[src]');
            for (const f of iframes) {
              const cand = resolveAbs(f.getAttribute('src'));
              if (cand && (/\.pdf(?:$|[?#])|\/pdf\/|getpdf|format=pdf/i.test(cand))) {
                detectedHref = cand;
                break;
              }
            }
          }
          if (!detectedHref) {
            const metaPdf = document.querySelector('meta[name="citation_pdf_url"][content]');
            if (metaPdf) {
              detectedHref = resolveAbs(metaPdf.getAttribute('content'));
            }
          }
          if (!detectedHref) {
            const links = document.querySelectorAll('a[href]');
            for (const a of links) {
              const txt = String(a.textContent || '').replace(/\s+/g, ' ').trim();
              const href = resolveAbs(a.getAttribute('href'));
              if (!href) continue;
              const isPdfLabel = /\b(?:view|download|full\s*text|open)\s*pdf\b/i.test(txt) || /^pdf$/i.test(txt);
              const isPdfHref = /\.pdf(?:$|[?#])|\/(?:export\.arxiv\.org|arxiv\.org)\/pdf\/|openreview\.net\/pdf\?|\/doi\/pdf\//i.test(href) ||
                /^https?:\/\/(?:export\.)?arxiv\.org\/pdf\//i.test(href);
              if (isPdfLabel || (isPdfHref && /pdf/i.test(txt))) {
                detectedHref = href;
                break;
              }
            }
          }
        }
        return {
          isPdf: isPdfDoc,
          url: location.href,
          origin: location.origin,
          detectedHref
        };
      }
    });
    if (!Array.isArray(results)) return [];
    return results
      .filter((r) => typeof r?.frameId === 'number' && r.result)
      .map((r) => ({
        frameId: r.frameId,
        isPdf: Boolean(r.result.isPdf),
        url: String(r.result.url || ''),
        origin: String(r.result.origin || ''),
        detectedHref: String(r.result.detectedHref || '')
      }));
  } catch (_) {
    return [];
  }
}

async function detectPdfUrlInTab(tabId, tabUrl = '') {
  const assoc = typeof resolveAssociatedPdfUrl === 'function' ? resolveAssociatedPdfUrl(tabUrl) : '';
  if (assoc) return assoc;
  if (typeof tabId !== 'number') return '';
  const frames = await probeTabFramesForPdf(tabId);
  const pdfFrame = frames.find((f) => f.isPdf && /^https?:\/\//i.test(f.url));
  if (pdfFrame) return pdfFrame.url;
  const topFrame = frames.find((f) => f.frameId === 0);
  if (topFrame?.detectedHref && /^https?:\/\//i.test(topFrame.detectedHref)) {
    return topFrame.detectedHref;
  }
  return '';
}

// Self-contained injected fetcher (must have ZERO outer scope references)
async function fetchPdfInTabAndStream(transferId, targetUrl, maxBytes, chunkBytes) {
  const hasPdfMagic = (u8) => {
    const limit = Math.min(u8.length, 1024);
    for (let i = 0; i <= limit - 5; i++) {
      if (
        u8[i] === 0x25 &&
        u8[i + 1] === 0x50 &&
        u8[i + 2] === 0x44 &&
        u8[i + 3] === 0x46 &&
        u8[i + 4] === 0x2d
      ) {
        return true;
      }
    }
    return false;
  };

  const uint8SliceToBase64 = (slice) => {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < slice.length; i += step) {
      const sub = slice.subarray(i, Math.min(i + step, slice.length));
      binary += String.fromCharCode.apply(null, sub);
    }
    return btoa(binary);
  };

  const attemptFetch = async (cacheMode, withAcceptHeader = false, creds = 'include') => {
    try {
      const fetchOpts = {
        credentials: creds,
        cache: cacheMode
      };
      if (withAcceptHeader) {
        fetchOpts.headers = { Accept: 'application/pdf,application/octet-stream,*/*' };
      }
      const resp = await fetch(targetUrl, fetchOpts);
      if (!resp.ok) {
        return { ok: false, status: resp.status, isHtml: false, error: `HTTP ${resp.status}` };
      }
      const ct = String(resp.headers.get('content-type') || '').toLowerCase();
      const clen = Number(resp.headers.get('content-length') || 0);
      if (clen > maxBytes) {
        return { ok: false, status: 0, isHtml: false, tooLarge: true, error: 'PDF 檔案超過 100 MB 上限' };
      }
      const buf = await resp.arrayBuffer();
      if (!buf || buf.byteLength === 0) {
        return { ok: false, status: resp.status, isHtml: ct.includes('html'), error: 'Empty response' };
      }
      if (buf.byteLength > maxBytes) {
        return { ok: false, status: 0, isHtml: false, tooLarge: true, error: 'PDF 檔案超過 100 MB 上限' };
      }
      const u8 = new Uint8Array(buf);
      if (!hasPdfMagic(u8)) {
        return {
          ok: false,
          status: resp.status,
          isHtml: ct.includes('html') || u8[0] === 0x3c,
          finalUrl: resp.url || targetUrl,
          error: 'Non-PDF response'
        };
      }
      return { ok: true, bytes: u8, finalUrl: resp.url || targetUrl };
    } catch (err) {
      return { ok: false, status: 0, isHtml: false, error: err?.message || 'Fetch failed' };
    }
  };

  let fetched = await attemptFetch('force-cache', false, 'include');
  if (!fetched.ok && !fetched.tooLarge) {
    fetched = await attemptFetch('default', true, 'include');
  }
  if (!fetched.ok && !fetched.tooLarge && (fetched.status === 401 || fetched.status === 403)) {
    fetched = await attemptFetch('default', false, 'omit');
  }
  if (!fetched.ok) {
    return fetched;
  }

  const bytes = fetched.bytes;
  const totalBytes = bytes.byteLength;
  const port = chrome.runtime.connect({ name: 'kct-pdf-bridge' });
  try {
    const ackPromise = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 2000);
      port.onMessage.addListener((m) => {
        if (m?.type === 'PDF_ACK' && m.transferId === transferId) finish();
      });
      port.onDisconnect.addListener(finish);
    });

    port.postMessage({
      type: 'PDF_META',
      transferId,
      totalBytes,
      finalUrl: fetched.finalUrl || targetUrl
    });

    let chunkIdx = 0;
    for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
      const slice = bytes.subarray(offset, Math.min(offset + chunkBytes, totalBytes));
      port.postMessage({
        type: 'PDF_CHUNK',
        transferId,
        index: chunkIdx++,
        data: uint8SliceToBase64(slice)
      });
      if (offset + chunkBytes < totalBytes) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    port.postMessage({ type: 'PDF_END', transferId });
    await ackPromise;
    return { ok: true, streamed: true, totalBytes, finalUrl: fetched.finalUrl || targetUrl };
  } catch (portErr) {
    return { ok: false, status: 0, isHtml: false, error: portErr?.message || 'Bridge transfer failed' };
  } finally {
    try {
      port.disconnect();
    } catch (_) {}
  }
}

async function ensureInjected(tabId, preferredFrameId = null) {
  if (typeof tabId !== 'number') {
    throw new Error('無效的分頁 ID');
  }

  // Probe frames for initialization status and extensionless PDF content-type detection
  let uninjectedFrameIds = null;
  let pdfSubframes = [];
  try {
    const probeResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const isPdfDoc =
          document.contentType === 'application/pdf' ||
          (Boolean(document.body) &&
            document.body.children.length === 1 &&
            Boolean(document.body.querySelector(':scope > embed[type="application/pdf"]')));
        return {
          initialized: Boolean(globalThis.__KCT_INITIALIZED__),
          isPdf: isPdfDoc,
          url: isPdfDoc ? location.href : ''
        };
      }
    });
    if (Array.isArray(probeResults) && probeResults.length > 0) {
      const topFrameProbe = probeResults.find((r) => r.frameId === 0);
      if (topFrameProbe?.result?.isPdf) {
        return { isPdf: true, pdfSubframes: [] };
      }
      pdfSubframes = probeResults
        .filter((r) => r.frameId !== 0 && r.result?.isPdf && r.result?.url)
        .map((r) => ({ frameId: r.frameId, url: r.result.url }));
      uninjectedFrameIds = probeResults
        .filter((r) => !r.result?.initialized && !r.result?.isPdf && typeof r.frameId === 'number')
        .map((r) => r.frameId);
      if (uninjectedFrameIds.length === 0) {
        return { isPdf: false, pdfSubframes }; // All accessible non-PDF frames are already injected
      }
    }
  } catch (_) {
    uninjectedFrameIds = null;
  }

  const target = uninjectedFrameIds ? { tabId, frameIds: uninjectedFrameIds } : { tabId, allFrames: true };
  const hasPreferredSubframe = typeof preferredFrameId === 'number' && preferredFrameId > 0;

  // Inject CSS only into frames not yet initialized; fall back to preferred/top frame if a restricted subframe rejects
  try {
    await chrome.scripting.insertCSS({
      target,
      files: CONTENT_CSS_FILES
    });
  } catch (_) {
    if (hasPreferredSubframe) {
      try {
        await chrome.scripting.insertCSS({
          target: { tabId, frameIds: [preferredFrameId] },
          files: CONTENT_CSS_FILES
        });
      } catch (_) {}
    }
    try {
      await chrome.scripting.insertCSS({
        target: { tabId, allFrames: false },
        files: CONTENT_CSS_FILES
      });
    } catch (cssErr) {
      console.warn('[KCT] insertCSS failed:', cssErr?.message);
    }
  }

  // Inject content scripts in strict dependency order
  let injectedAny = false;
  try {
    await chrome.scripting.executeScript({
      target,
      files: CONTENT_JS_FILES
    });
    injectedAny = true;
  } catch (_) {
    if (hasPreferredSubframe) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [preferredFrameId] },
          files: CONTENT_JS_FILES
        });
        injectedAny = true;
      } catch (_) {}
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: CONTENT_JS_FILES
      });
      injectedAny = true;
    } catch (topErr) {
      if (!injectedAny) throw topErr;
    }
  }

  return { isPdf: false, pdfSubframes };
}

async function injectAndCommandTab(tabId, action, payload = null) {
  const tab = await chrome.tabs.get(tabId);
  if (isPdfUrl(tab?.url)) {
    if (action === 'CLEAR_PAGE') {
      return { ok: true };
    }
    const viewerRes = await openPdfViewer(tab.url, tab);
    return { ok: true, openedPdfViewer: true, ...viewerRes };
  }
  if (!isInjectableUrl(tab?.url)) {
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_URL',
      error: '此頁面不支援翻譯（僅支援一般 http/https 網頁或 PDF 文件）'
    };
  }
  // Never inject scripts onto an untouched tab just to run CLEAR_PAGE
  if (action === 'CLEAR_PAGE') {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'KCT_COMMAND',
        action: 'CLEAR_PAGE'
      });
    } catch (_) {
      // Tab had no injected content script; already clean
    }
    return { ok: true };
  }
  const inj = await ensureInjected(tabId);
  if (inj?.isPdf) {
    const viewerRes = await openPdfViewer(tab.url, tab);
    return { ok: true, openedPdfViewer: true, ...viewerRes };
  }
  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'KCT_COMMAND',
      action,
      ...(payload && typeof payload === 'object' ? payload : {})
    });
    return { ok: true, ...(resp && typeof resp === 'object' ? { data: resp } : {}) };
  } catch (err) {
    // Content script may have just initialized or navigated; report clearly
    return {
      ok: false,
      error: err?.message || '無法傳送指令至頁面'
    };
  }
}

// ============================================================
// Lifecycle, Context Menus, Keyboard Shortcuts & Auto-Whitelist
// ============================================================

function setupContextMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      chrome.contextMenus.create(
        {
          id: 'kct-translate-page',
          title: '翻譯此頁面（NativeRead）',
          contexts: ['page', 'frame']
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
      chrome.contextMenus.create(
        {
          id: 'kct-translate-selection',
          title: 'NativeRead 翻譯選取文字：「%s」',
          contexts: ['selection']
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
      chrome.contextMenus.create(
        {
          id: 'kct-translate-image',
          title: 'NativeRead 翻譯圖片文字',
          contexts: ['image']
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
      chrome.contextMenus.create(
        {
          id: 'kct-open-pdf-link',
          title: '以 NativeRead 閱讀並翻譯此 PDF',
          contexts: ['link'],
          targetUrlPatterns: [
            '*://*/*.pdf',
            '*://*/*.pdf?*',
            '*://*/*.PDF',
            '*://*/*.PDF?*',
            '*://arxiv.org/pdf/*',
            '*://export.arxiv.org/pdf/*',
            '*://openreview.net/pdf*',
            '*://*/doi/pdf/*',
            '*://proceedings.mlr.press/*',
            '*://drive.google.com/file/d/*'
          ]
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    });
  } catch (err) {
    console.warn('[KCT] setupContextMenus error:', err?.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  CacheDB.migrateFromLegacyStorage().catch(() => {});
  trySyncFromOpenTrustedPwaTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
  CacheDB.migrateFromLegacyStorage().catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === 'kct-translate-page') {
      if (isPdfUrl(tab.url)) {
        await openPdfViewer(tab.url, tab);
        return;
      }
      if (!isInjectableUrl(tab.url)) return;
      const inj = await ensureInjected(tab.id);
      if (inj?.isPdf) {
        await openPdfViewer(tab.url, tab);
        return;
      }
      await chrome.tabs.sendMessage(tab.id, {
        type: 'KCT_COMMAND',
        action: 'TRANSLATE_NOW'
      });
    } else if (info.menuItemId === 'kct-translate-selection') {
      if (isPdfUrl(tab.url)) {
        await openPdfViewer(tab.url, tab);
        return;
      }
      if (!isInjectableUrl(tab.url)) return;
      const inj = await ensureInjected(tab.id);
      if (inj?.isPdf) {
        await openPdfViewer(tab.url, tab);
        return;
      }
      const sendOpts = typeof info.frameId === 'number' ? { frameId: info.frameId } : undefined;
      await chrome.tabs.sendMessage(
        tab.id,
        {
          type: 'KCT_COMMAND',
          action: 'TRANSLATE_SELECTION',
          selectionText: info.selectionText || ''
        },
        sendOpts
      );
    } else if (info.menuItemId === 'kct-translate-image') {
      if (isPdfUrl(tab.url) || !isInjectableUrl(tab.url)) return;
      const preferredFrameId = typeof info.frameId === 'number' ? info.frameId : null;
      const inj = await ensureInjected(tab.id, preferredFrameId);
      if (inj?.isPdf) return;
      if (
        typeof info.frameId === 'number' &&
        Array.isArray(inj?.pdfSubframes) &&
        inj.pdfSubframes.some((f) => f.frameId === info.frameId)
      ) {
        return;
      }
      const sendOpts = typeof info.frameId === 'number' ? { frameId: info.frameId } : undefined;
      await chrome.tabs.sendMessage(
        tab.id,
        {
          type: 'KCT_TRANSLATE_IMAGE',
          srcUrl: info.srcUrl || '',
          pageUrl: info.pageUrl || tab.url || ''
        },
        sendOpts
      );
    } else if (info.menuItemId === 'kct-open-pdf-link') {
      const linkUrl = typeof info.linkUrl === 'string' ? info.linkUrl.trim() : '';
      if (linkUrl) {
        await openPdfViewer(linkUrl, tab);
      }
    }
  } catch (err) {
    console.warn('[KCT] contextMenus action failed:', err?.message);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate-page') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    if (isPdfUrl(tab.url)) {
      await openPdfViewer(tab.url, tab);
      return;
    }
    if (!isInjectableUrl(tab.url)) return;
    const inj = await ensureInjected(tab.id);
    if (inj?.isPdf) {
      await openPdfViewer(tab.url, tab);
      return;
    }
    await chrome.tabs.sendMessage(tab.id, {
      type: 'KCT_COMMAND',
      action: 'TOGGLE_OR_TRANSLATE'
    });
  } catch (err) {
    console.warn('[KCT] command toggle-translate-page failed:', err?.message);
  }
});

const TRUSTED_PWA_ORIGIN = 'https://chih-kai-wang.github.io';
const TRUSTED_PWA_PATH_PREFIX = '/native-read';
const ALLOWED_THINKING_EFFORTS = new Set(['fastest', 'balanced', 'deep']);
const ALLOWED_TYPOGRAPHY_MATCHES = new Set(['native', 'system', 'preserve']);
const RECENT_NR_SYNC_TOKENS = new Map(); // tabId -> lastToken

function rememberNrSyncToken(tabId, token) {
  if (typeof tabId !== 'number' || !token) return;
  RECENT_NR_SYNC_TOKENS.delete(tabId);
  RECENT_NR_SYNC_TOKENS.set(tabId, token);
  while (RECENT_NR_SYNC_TOKENS.size > 50) {
    const oldestKey = RECENT_NR_SYNC_TOKENS.keys().next().value;
    RECENT_NR_SYNC_TOKENS.delete(oldestKey);
  }
}

function isTrustedPwaUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    return (
      parsed.protocol === 'https:' &&
      parsed.origin === TRUSTED_PWA_ORIGIN &&
      (parsed.pathname === TRUSTED_PWA_PATH_PREFIX ||
        parsed.pathname.startsWith(`${TRUSTED_PWA_PATH_PREFIX}/`))
    );
  } catch (_) {
    return false;
  }
}

function extractTrustedNrSyncToken(urlStr) {
  if (!urlStr || typeof urlStr !== 'string' || !urlStr.includes('nr_sync=')) return null;
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (_) {
    return null;
  }
  const extOrigin = new URL(chrome.runtime.getURL('')).origin;
  const isTrustedExt = parsed.origin === extOrigin;
  const isTrustedPwa = isTrustedPwaUrl(urlStr);
  if (!isTrustedExt && !isTrustedPwa) return null;

  // Strictly require nr_sync= inside URL hash fragment (#), never query params (?nr_sync=...)
  const hash = parsed.hash || '';
  const match = hash.match(/(?:^|[#&])nr_sync=([A-Za-z0-9_%-]+)/);
  if (!match || !match[1]) return null;
  return { parsed, token: match[1], isTrustedPwa, isTrustedExt };
}

function decodeNrSyncTokenToObject(rawToken) {
  const clean = decodeURIComponent(String(rawToken || '').trim());
  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function validateAndBuildSyncPatch(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const hasOwnK = Object.prototype.hasOwnProperty.call(data, 'k');
  const hasOwnApiKey = Object.prototype.hasOwnProperty.call(data, 'apiKey');
  const rawKey = hasOwnApiKey ? data.apiKey : (hasOwnK ? data.k : undefined);
  const hasExplicitKey = typeof rawKey === 'string';

  const rawProviderId = String(data.providerId || data.p || '').trim();
  if (rawProviderId && !PROVIDER_PRESETS?.[rawProviderId]) return null;
  const providerId = rawProviderId;
  const preset = providerId ? PROVIDER_PRESETS[providerId] : null;

  const rawProtocol = String(data.protocol || data.r || '').trim();
  if (rawProtocol && rawProtocol !== 'openai' && rawProtocol !== 'gemini' && rawProtocol !== 'anthropic') return null;

  const rawBaseUrl = String(data.baseUrl || data.u || '').trim();
  if (rawBaseUrl) {
    let parsedBase;
    try {
      parsedBase = new URL(rawBaseUrl);
    } catch (_) {
      return null;
    }
    if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
      return null;
    }
  }

  const hasEndpointMutationField =
    Boolean(rawBaseUrl) ||
    Boolean(rawProtocol) ||
    Boolean(providerId);

  if (!hasExplicitKey && hasEndpointMutationField) {
    return null;
  }

  const patch = {};
  if (hasExplicitKey) {
    const keyCheck = typeof KCTConfig?.validateApiKey === 'function'
      ? KCTConfig.validateApiKey(rawKey)
      : { ok: true, cleanKey: sanitizeApiKey(rawKey) };
    if (!keyCheck.ok) return null;
    patch.apiKey = keyCheck.cleanKey;
    if (providerId) patch.providerId = providerId;
    const protocol = rawProtocol || preset?.protocol || '';
    if (protocol === 'openai' || protocol === 'gemini' || protocol === 'anthropic') {
      patch.protocol = protocol;
    }
    const resolvedBaseUrl = rawBaseUrl || preset?.baseUrl || '';
    if (resolvedBaseUrl) {
      let parsedResolvedBase;
      try {
        parsedResolvedBase = new URL(resolvedBaseUrl);
      } catch (_) {
        return null;
      }
      if (parsedResolvedBase.protocol !== 'http:' && parsedResolvedBase.protocol !== 'https:') {
        return null;
      }
      patch.baseUrl = resolvedBaseUrl;
    }
  }

  const model = String(data.model || data.m || (hasExplicitKey ? preset?.defaultModel : '') || '').trim();
  if (model) patch.model = model;

  if (
    hasExplicitKey &&
    data.providerProfiles &&
    typeof data.providerProfiles === 'object' &&
    !Array.isArray(data.providerProfiles)
  ) {
    const safeProfiles = {};
    for (const [pid, prof] of Object.entries(data.providerProfiles)) {
      if (!PROVIDER_PRESETS?.[pid] || !prof || typeof prof !== 'object' || Array.isArray(prof)) continue;
      const pProto = String(prof.protocol || PROVIDER_PRESETS[pid].protocol || 'openai').trim();
      if (pProto !== 'openai' && pProto !== 'gemini' && pProto !== 'anthropic') continue;
      const pBase = String(prof.baseUrl || PROVIDER_PRESETS[pid].baseUrl || '').trim();
      try {
        const u = new URL(pBase);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      } catch (_) {
        continue;
      }
      const pk = typeof KCTConfig?.validateApiKey === 'function'
        ? KCTConfig.validateApiKey(prof.apiKey || '')
        : { ok: true, cleanKey: sanitizeApiKey(prof.apiKey || '') };
      if (!pk.ok) continue;
      safeProfiles[pid] = {
        protocol: pProto,
        baseUrl: pBase,
        apiKey: pk.cleanKey,
        model: String(prof.model || PROVIDER_PRESETS[pid].defaultModel || '').trim(),
        ...(prof.thinkingEffort && ALLOWED_THINKING_EFFORTS.has(prof.thinkingEffort)
          ? { thinkingEffort: prof.thinkingEffort }
          : {})
      };
    }
    if (Object.keys(safeProfiles).length > 0) {
      patch.providerProfiles = safeProfiles;
    }
  }

  if (
    hasExplicitKey &&
    typeof data.fallbackProviderId === 'string' &&
    PROVIDER_PRESETS?.[data.fallbackProviderId] &&
    data.fallbackProviderId !== (patch.providerId || providerId)
  ) {
    patch.fallbackProviderId = data.fallbackProviderId;
  }

  const targetLang = String(data.targetLang || data.l || '').trim();
  if (targetLang && (!TARGET_LANGUAGES || TARGET_LANGUAGES[targetLang])) {
    patch.targetLang = targetLang;
  }
  const customTargetLang = String(data.customTargetLang ?? data.c ?? '').trim();
  if (customTargetLang || patch.targetLang === 'custom') {
    patch.customTargetLang = customTargetLang;
  }

  const thinkingEffort = String(data.thinkingEffort || data.e || '').trim();
  if (thinkingEffort && ALLOWED_THINKING_EFFORTS.has(thinkingEffort)) {
    patch.thinkingEffort = thinkingEffort;
  }

  const typographyMatch = String(data.typographyMatch || data.t || '').trim();
  if (typographyMatch && ALLOWED_TYPOGRAPHY_MATCHES.has(typographyMatch)) {
    patch.typographyMatch = typographyMatch;
  }

  if (typeof data.customGlossary === 'string') {
    patch.customGlossary = data.customGlossary;
  }

  if (Object.keys(patch).length === 0) return null;
  return patch;
}

async function tryImportNrSyncFromUrl(urlStr) {
  const trusted = extractTrustedNrSyncToken(urlStr);
  if (!trusted) return false;
  try {
    const data = decodeNrSyncTokenToObject(trusted.token);
    const patch = validateAndBuildSyncPatch(data);
    if (!patch) return false;
    patch.syncedAt = Number(data?.syncedAt) || Date.now();
    await saveSettings(patch);
    return true;
  } catch (_) {
    return false;
  }
}

async function tryImportNrSyncRawInput(rawInput) {
  const text = String(rawInput || '').trim();
  if (!text) return false;
  let token = '';
  const match = text.match(/(?:^|[#&])nr_sync=([A-Za-z0-9_%-]+)/);
  if (match && match[1]) {
    token = match[1];
  } else {
    try {
      const parsed = new URL(text);
      const urlMatch = String(parsed.hash || '').match(/(?:^|[#&])nr_sync=([A-Za-z0-9_%-]+)/);
      if (urlMatch && urlMatch[1]) token = urlMatch[1];
    } catch (_) {}
  }
  if (!token && /^[A-Za-z0-9_-]{12,}={0,2}$/.test(text)) {
    token = text;
  }
  if (!token) return false;
  try {
    const data = decodeNrSyncTokenToObject(token);
    const patch = validateAndBuildSyncPatch(data);
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'apiKey') || !patch.apiKey) {
      return false;
    }
    patch.syncedAt = Number(data?.syncedAt) || Date.now();
    await saveSettings(patch);
    return true;
  } catch (_) {
    return false;
  }
}

async function tryImportFromTrustedPwaTab(tabId, tabUrl) {
  if (typeof tabId !== 'number' || !isTrustedPwaUrl(tabUrl)) return false;
  try {
    const execRes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: () => {
        try {
          return localStorage.getItem('kct_settings_v1');
        } catch (_) {
          return null;
        }
      }
    });
    const raw = execRes?.[0]?.result;
    if (!raw || typeof raw !== 'string') return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const cleanKey = sanitizeApiKey(parsed.apiKey);
    if (!cleanKey || isLocalEndpoint(parsed.baseUrl)) return false;

    const current = await getSettings();
    const currentHasKey = Boolean(sanitizeApiKey(current.apiKey));
    const incomingTs = Number(parsed.syncedAt || 0);
    const currentTs = Number(current.syncedAt || 0);
    if (currentHasKey && incomingTs <= currentTs) {
      return false;
    }

    const patch = validateAndBuildSyncPatch(parsed);
    if (!patch || !patch.apiKey) return false;
    patch.syncedAt = incomingTs || Date.now();
    await saveSettings(patch);
    return true;
  } catch (_) {
    return false;
  }
}

async function trySyncFromOpenTrustedPwaTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (typeof t?.id === 'number' && isTrustedPwaUrl(t.url)) {
        const imported = await tryImportFromTrustedPwaTab(t.id, t.url);
        if (imported) return true;
      }
    }
  } catch (_) {}
  return false;
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  let importedNrSync = false;
  const candidateUrl = changeInfo?.url || tab?.url || '';
  const trustedCandidate = extractTrustedNrSyncToken(candidateUrl);
  if (trustedCandidate && RECENT_NR_SYNC_TOKENS.get(tabId) !== trustedCandidate.token) {
    const imported = await tryImportNrSyncFromUrl(candidateUrl);
    if (imported) {
      importedNrSync = true;
      rememberNrSyncToken(tabId, trustedCandidate.token);
    }
  }
  if (changeInfo.status !== 'complete' || !isInjectableUrl(tab?.url) || isPdfUrl(tab?.url)) return;
  try {
    const trustedComplete = extractTrustedNrSyncToken(tab.url);
    if (trustedComplete) {
      if (RECENT_NR_SYNC_TOKENS.get(tabId) !== trustedComplete.token) {
        const imported = await tryImportNrSyncFromUrl(tab.url);
        if (imported) {
          importedNrSync = true;
          rememberNrSyncToken(tabId, trustedComplete.token);
        }
      }
      if (trustedComplete.isTrustedPwa) {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          func: () => {
            if (location.hash.includes('nr_sync=')) {
              history.replaceState(null, '', location.pathname + location.search);
            }
          }
        }).catch(() => {});
      }
    } else if (!importedNrSync && isTrustedPwaUrl(tab.url)) {
      await tryImportFromTrustedPwaTab(tabId, tab.url);
    }
    const settings = await getSettings();
    if (!settings.enabled) return;
    let host = '';
    try {
      host = new URL(tab.url).hostname;
    } catch (_) {
      return;
    }
    if (settings.autoTranslate || isHostWhitelisted(host, settings)) {
      const inj = await ensureInjected(tabId);
      if (inj?.isPdf) return;
      await chrome.tabs.sendMessage(tabId, {
        type: 'KCT_COMMAND',
        action: 'TRANSLATE_NOW',
        trigger: 'auto'
      });
    }
  } catch (_) {
    // Tab may have navigated away or closed
  }
});

// ============================================================
// SSE Streaming Port ('kct-stream')
// ============================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'kct-stream') return;

  let portDisconnected = false;
  const activeControllers = new Map();

  const safePost = (msg) => {
    if (portDisconnected) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (_) {
      portDisconnected = true;
      return false;
    }
  };

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    portDisconnected = true;
    for (const ctrl of activeControllers.values()) {
      try {
        ctrl.abort();
      } catch (_) {}
    }
    activeControllers.clear();
  });

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'CANCEL_STREAM' && msg.requestId) {
      const ctrl = activeControllers.get(msg.requestId);
      if (ctrl) {
        try {
          ctrl.abort();
        } catch (_) {}
        activeControllers.delete(msg.requestId);
      }
      return;
    }

    if (msg.type !== 'TRANSLATE_STREAM') return;

    (async () => {
      const requestId = msg.requestId || `req_${Date.now()}`;
      const items = Array.isArray(msg.items) ? msg.items : [];
      const pageContext = msg.pageContext || null;

      if (items.length === 0) {
        safePost({ type: 'DONE', requestId, translatedCount: 0 });
        return;
      }

      const bid = nextBatchSeq++;
      activeBatchDebug.set(bid, {
        id: bid,
        mode: 'stream',
        total: items.length,
        sample: items.slice(0, 2).map((x) => String(x.text || '').slice(0, 40)),
        startedAt: Date.now(),
        stage: 'start'
      });

      const controller = new AbortController();
      activeControllers.set(requestId, controller);
      const toPersist = [];
      let translatedCount = 0;
      let settings = null;
      let activeFbSettings = null;

      try {
        settings = await getSettings();
        if (!sanitizeApiKey(settings.apiKey) && !isLocalEndpoint(settings.baseUrl)) {
          finishBatchEvent(bid, { stage: 'no_key' });
          safePost({
            type: 'ERROR',
            requestId,
            errorCode: 'NO_API_KEY',
            error: '尚未設定大模型 API Key，請點選擴充功能圖示或前往設定頁填寫。'
          });
          return;
        }

        const lang = resolveTargetLanguage(settings);
        const sig = buildCacheSignature(settings, pageContext);
        const cacheKeys = items.map((item) => `${sig}::${item.key}`);
        const cachedMap = await CacheDB.getMany(cacheKeys);

        if (portDisconnected || controller.signal.aborted) {
          finishBatchEvent(bid, { stage: 'aborted' });
          return;
        }

        const uncached = [];
        for (const item of items) {
          const cacheKey = `${sig}::${item.key}`;
          const cachedZh = cachedMap.get(cacheKey);
          if (
            typeof cachedZh === 'string' &&
            cachedZh.trim() &&
            !isUntranslatedEcho(item.text, cachedZh, lang.id)
          ) {
            translatedCount += 1;
            safePost({
              type: 'ITEM',
              requestId,
              key: item.key,
              zh: cachedZh,
              cached: true
            });
          } else {
            uncached.push({ ...item, cacheKey });
          }
        }

        if (uncached.length === 0) {
          finishBatchEvent(bid, { stage: 'done_cached', translated: 0 });
          safePost({ type: 'DONE', requestId, translatedCount });
          return;
        }

        recordBatchEvent(bid, {
          stage: 'streaming_llm',
          uncached: uncached.length,
          cached: items.length - uncached.length
        });

        const emittedKeys = new Set();
        const emitItem = (item, text, { allowEcho = false } = {}) => {
          const cleanZh = String(text || '').trim();
          if (!cleanZh || emittedKeys.has(item.key)) return;
          const isEcho = isUntranslatedEcho(item.text, cleanZh, lang.id);
          if (isEcho && !allowEcho) {
            return;
          }
          emittedKeys.add(item.key);
          translatedCount += 1;
          if (!isEcho) {
            toPersist.push({ key: item.cacheKey, zh: cleanZh });
          }
          safePost({
            type: 'ITEM',
            requestId,
            key: item.key,
            zh: cleanZh,
            cached: false
          });
        };

        const sendHeartbeat = (stage, detail = null) => {
          safePost({
            type: 'HEARTBEAT',
            requestId,
            stage,
            ...(detail && typeof detail === 'object' ? detail : {})
          });
        };

        const runWithProvider = async (activeSettings, activeUncached) => {
          if (activeSettings.streamTranslation !== false) {
            try {
              await streamTranslateItems(
                activeSettings,
                activeUncached,
                pageContext,
                (idx, text) => {
                  const target = activeUncached[idx];
                  if (target) {
                    emitItem(target, text);
                  }
                },
                controller.signal,
                sendHeartbeat
              );
            } catch (streamErr) {
              if (portDisconnected || controller.signal.aborted || streamErr?.isExternalAbort) {
                throw streamErr;
              }
              const isFatal =
                streamErr?.httpStatus >= 500 ||
                streamErr?.httpStatus === 529 ||
                streamErr?.httpStatus === 401 ||
                streamErr?.httpStatus === 402 ||
                streamErr?.httpStatus === 403 ||
                streamErr?.httpStatus === 404 ||
                streamErr?.httpStatus === 422 ||
                streamErr?.httpStatus === 429 ||
                streamErr?.noSplit === true;
              if (isFatal) {
                throw streamErr;
              }
              console.warn('[KCT] SSE stream failed, falling back to batch JSON:', streamErr?.message);
            }
          }

          const remaining = activeUncached.filter((it) => !emittedKeys.has(it.key));
          if (remaining.length > 0 && !portDisconnected && !controller.signal.aborted) {
            sendHeartbeat('fallback_batch', { remaining: remaining.length });
            recordBatchEvent(bid, { stage: 'fallback_batch', remaining: remaining.length });
            const fallbackMap = await translateItemsWithFallback(
              activeSettings,
              remaining,
              pageContext,
              controller.signal
            );
            for (const item of remaining) {
              const zh = fallbackMap[item.key];
              if (zh) {
                emitItem(item, zh, { allowEcho: true });
              }
            }
          }
        };

        let fallbackUsed = null;
        try {
          await runWithProvider(settings, uncached);
        } catch (primaryErr) {
          if (portDisconnected || controller.signal.aborted || primaryErr?.isExternalAbort) {
            finishBatchEvent(bid, { stage: 'aborted' });
            return;
          }
          const fbSettings = isFallbackEligibleError(primaryErr) ? resolveFallbackSettings(settings) : null;
          if (!fbSettings) {
            throw primaryErr;
          }
          activeFbSettings = fbSettings;
          sendHeartbeat('fallback_provider', { provider: fbSettings.providerId, model: fbSettings.model });
          recordBatchEvent(bid, { stage: 'fallback_provider', provider: fbSettings.providerId, model: fbSettings.model });

          const fbSig = buildCacheSignature(fbSettings, pageContext);
          const remaining = uncached.filter((it) => !emittedKeys.has(it.key));
          const fbKeys = remaining.map((it) => `${fbSig}::${it.key}`);
          const fbCachedMap = fbKeys.length > 0 ? await CacheDB.getMany(fbKeys) : new Map();
          const fbUncached = [];
          for (const it of remaining) {
            const fbCacheKey = `${fbSig}::${it.key}`;
            const fbHit = fbCachedMap.get(fbCacheKey);
            if (typeof fbHit === 'string' && fbHit.trim() && !isUntranslatedEcho(it.text, fbHit, lang.id)) {
              emittedKeys.add(it.key);
              translatedCount += 1;
              safePost({
                type: 'ITEM',
                requestId,
                key: it.key,
                zh: fbHit,
                cached: true
              });
            } else {
              fbUncached.push({ ...it, cacheKey: fbCacheKey });
            }
          }
          if (fbUncached.length > 0 && !portDisconnected && !controller.signal.aborted) {
            await runWithProvider(fbSettings, fbUncached);
          }
          fallbackUsed = {
            providerId: fbSettings.providerId,
            label: PROVIDER_PRESETS[fbSettings.providerId]?.label || fbSettings.providerId,
            model: fbSettings.model
          };
        }

        if (toPersist.length > 0) {
          await CacheDB.putMany(toPersist);
        }
        finishBatchEvent(bid, { stage: 'done', translated: toPersist.length, fallback: fallbackUsed?.providerId || '' });
        safePost({
          type: 'DONE',
          requestId,
          translatedCount,
          ...(fallbackUsed ? { fallbackUsed } : {})
        });
      } catch (err) {
        if (toPersist.length > 0) {
          CacheDB.putMany(toPersist).catch(() => {});
        }
        if (portDisconnected || controller.signal.aborted || err?.isExternalAbort) {
          finishBatchEvent(bid, { stage: 'aborted' });
          return;
        }
        const safeErrMsg = redactAllKeys(err?.message || String(err), settings, activeFbSettings);
        finishBatchEvent(bid, { stage: 'error', error: safeErrMsg });
        safePost({
          type: 'ERROR',
          requestId,
          error: safeErrMsg || '串流翻譯失敗',
          errorCode: err?.errorCode || (err?.httpStatus ? `HTTP_${err.httpStatus}` : 'STREAM_ERROR')
        });
      } finally {
        activeControllers.delete(requestId);
      }
    })();
  });
});

// ============================================================
// Seamless PDF Transfer Ports ('kct-pdf-fetch' & 'kct-pdf-bridge')
// ============================================================

const activePdfTransfers = new Map(); // transferId -> { viewerPort, requestId, aborted, resolve, reject }

function createTransferId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

async function findCandidatePdfFrame(targetUrl, preferredTabId = null) {
  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (_) {
    return null;
  }
  const targetOrigin = parsedTarget.origin;
  const targetSite = getSiteKeyFromHost(parsedTarget.hostname);
  const inspectedTabIds = new Set();

  const inspectTab = async (tabId) => {
    if (typeof tabId !== 'number' || inspectedTabIds.has(tabId)) return null;
    inspectedTabIds.add(tabId);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      return null;
    }
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) return null;

    const frames = await probeTabFramesForPdf(tab.id);
    const exactMatch = frames.find((f) => f.url === targetUrl) ||
      frames.find((f) => f.isPdf && f.origin === targetOrigin);
    if (exactMatch) {
      return { tabId: tab.id, frameId: exactMatch.frameId, url: exactMatch.url || targetUrl };
    }
    const sameOriginFrame = frames.find((f) => f.origin === targetOrigin);
    if (sameOriginFrame) {
      return { tabId: tab.id, frameId: sameOriginFrame.frameId, url: targetUrl };
    }
    try {
      const tabUrlObj = new URL(tab.url);
      const tabSite = getSiteKeyFromHost(tabUrlObj.hostname);
      if (tabUrlObj.origin === targetOrigin || (targetSite && tabSite === targetSite)) {
        return { tabId: tab.id, frameId: 0, url: targetUrl };
      }
    } catch (_) {}
    return null;
  };

  if (typeof preferredTabId === 'number') {
    const preferredHit = await inspectTab(preferredTabId);
    if (preferredHit) return preferredHit;
  }

  let allTabs = [];
  try {
    allTabs = await chrome.tabs.query({});
  } catch (_) {}

  for (const t of allTabs) {
    if (!t?.url || inspectedTabIds.has(t.id) || !/^https?:\/\//i.test(t.url)) continue;
    try {
      if (t.url === targetUrl || new URL(t.url).origin === targetOrigin) {
        const hit = await inspectTab(t.id);
        if (hit) return hit;
      }
    } catch (_) {}
  }

  for (const t of allTabs) {
    if (!t?.url || inspectedTabIds.has(t.id) || !/^https?:\/\//i.test(t.url)) continue;
    try {
      const tabSite = getSiteKeyFromHost(new URL(t.url).hostname);
      if (targetSite && tabSite === targetSite) {
        const hit = await inspectTab(t.id);
        if (hit) return hit;
      }
    } catch (_) {}
  }

  return null;
}

async function runTabPdfTransfer(viewerPort, requestId, tabId, frameId, fetchUrl) {
  const transferId = createTransferId();
  let transferSettled = false;
  let resolveTransfer;
  let rejectTransfer;
  const transferPromise = new Promise((resolve, reject) => {
    resolveTransfer = (val) => {
      if (transferSettled) return;
      transferSettled = true;
      resolve(val);
    };
    rejectTransfer = (err) => {
      if (transferSettled) return;
      transferSettled = true;
      reject(err);
    };
  });

  activePdfTransfers.set(transferId, {
    viewerPort,
    requestId,
    aborted: false,
    resolve: resolveTransfer,
    reject: rejectTransfer
  });

  try {
    const execRes = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'ISOLATED',
      func: fetchPdfInTabAndStream,
      args: [transferId, fetchUrl, PDF_MAX_BYTES, PDF_CHUNK_BYTES]
    });
    const scriptOut = execRes?.[0]?.result;
    if (!scriptOut?.ok) {
      activePdfTransfers.delete(transferId);
      rejectTransfer(new Error(scriptOut?.error || 'Tab fetch failed'));
      return {
        ok: false,
        status: Number(scriptOut?.status || 0),
        isHtml: Boolean(scriptOut?.isHtml),
        tooLarge: Boolean(scriptOut?.tooLarge),
        finalUrl: scriptOut?.finalUrl || fetchUrl,
        error: scriptOut?.error || 'Tab fetch failed'
      };
    }
    await transferPromise;
    return { ok: true, finalUrl: scriptOut.finalUrl || fetchUrl };
  } catch (err) {
    activePdfTransfers.delete(transferId);
    return {
      ok: false,
      status: 0,
      isHtml: false,
      error: err?.message || 'Script transfer failed'
    };
  }
}

function waitForTabLoadComplete(tabId, timeoutMs, isAbortedFn) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(abortPoll);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(ok);
    };
    const onUpdated = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        finish(true);
      }
    };
    const onRemoved = (removedId) => {
      if (removedId === tabId) {
        finish(false);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const abortPoll = setInterval(() => {
      if (isAbortedFn?.()) finish(false);
    }, 250);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((t) => {
      if (isAbortedFn?.()) {
        finish(false);
      } else if (t?.status === 'complete') {
        finish(true);
      }
    }).catch(() => finish(false));
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'kct-pdf-bridge') {
    let boundTransferId = null;
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      const transferId = msg.transferId;
      if (!transferId) return;
      const entry = activePdfTransfers.get(transferId);
      if (!entry || entry.aborted) return;
      boundTransferId = transferId;

      if (msg.type === 'PDF_META') {
        try {
          entry.viewerPort.postMessage({
            type: 'PDF_META',
            requestId: entry.requestId,
            totalBytes: msg.totalBytes,
            finalUrl: msg.finalUrl || ''
          });
        } catch (_) {
          entry.aborted = true;
          activePdfTransfers.delete(transferId);
          entry.reject(new Error('Viewer port closed'));
        }
      } else if (msg.type === 'PDF_CHUNK') {
        try {
          entry.viewerPort.postMessage({
            type: 'PDF_CHUNK',
            requestId: entry.requestId,
            index: msg.index,
            data: msg.data
          });
        } catch (_) {
          entry.aborted = true;
          activePdfTransfers.delete(transferId);
          entry.reject(new Error('Viewer port closed'));
        }
      } else if (msg.type === 'PDF_END') {
        try {
          entry.viewerPort.postMessage({
            type: 'PDF_END',
            requestId: entry.requestId
          });
        } catch (_) {}
        activePdfTransfers.delete(transferId);
        entry.resolve({ ok: true });
        try {
          port.postMessage({ type: 'PDF_ACK', transferId });
        } catch (_) {}
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (boundTransferId && activePdfTransfers.has(boundTransferId)) {
        const entry = activePdfTransfers.get(boundTransferId);
        activePdfTransfers.delete(boundTransferId);
        entry?.reject(new Error('PDF bridge disconnected early'));
      }
    });
    return;
  }

  if (port.name !== 'kct-pdf-fetch') return;
  if (!isExtensionSender(port.sender)) {
    try {
      port.disconnect();
    } catch (_) {}
    return;
  }

  let portDisconnected = false;
  const activeBgTabIds = new Set();

  const safePost = (msg) => {
    if (portDisconnected) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (_) {
      portDisconnected = true;
      return false;
    }
  };

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    portDisconnected = true;
    for (const [tid, entry] of activePdfTransfers.entries()) {
      if (entry.viewerPort === port) {
        entry.aborted = true;
        activePdfTransfers.delete(tid);
        entry.reject(new Error('Viewer disconnected'));
      }
    }
    for (const bgId of activeBgTabIds) {
      chrome.tabs.remove(bgId).catch(() => {});
    }
    activeBgTabIds.clear();
  });

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    const requestId = msg.requestId || `pdf_${Date.now()}`;
    const rawUrl = String(msg.url || '').trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      safePost({ type: 'PDF_FALLBACK', requestId, reason: 'INVALID_URL' });
      return;
    }

    if (msg.type === 'FETCH_PDF_FROM_TAB') {
      (async () => {
        try {
          const preferredTabId = typeof msg.tabId === 'number' ? msg.tabId : null;
          const cand = await findCandidatePdfFrame(rawUrl, preferredTabId);
          if (!cand || portDisconnected) {
            safePost({ type: 'PDF_FALLBACK', requestId, reason: 'NO_CANDIDATE_TAB' });
            return;
          }
          const res = await runTabPdfTransfer(port, requestId, cand.tabId, cand.frameId, cand.url || rawUrl);
          if (!res.ok && !portDisconnected) {
            safePost({
              type: 'PDF_FALLBACK',
              requestId,
              reason: res.error || 'TAB_FETCH_FAILED',
              status: res.status || 0,
              isHtml: Boolean(res.isHtml),
              tooLarge: Boolean(res.tooLarge),
              finalUrl: res.finalUrl || rawUrl
            });
          }
        } catch (err) {
          if (!portDisconnected) {
            safePost({ type: 'PDF_FALLBACK', requestId, reason: err?.message || 'TAB_FETCH_FAILED' });
          }
        }
      })();
      return;
    }

    if (msg.type === 'FETCH_PDF_VIA_BG_TAB') {
      (async () => {
        let bgTabId = null;
        try {
          const bgTab = await chrome.tabs.create({ url: rawUrl, active: false });
          bgTabId = bgTab?.id ?? null;
          if (typeof bgTabId !== 'number') {
            safePost({ type: 'PDF_FALLBACK', requestId, reason: 'BG_TAB_CREATE_FAILED' });
            return;
          }
          if (portDisconnected) {
            await chrome.tabs.remove(bgTabId).catch(() => {});
            return;
          }
          activeBgTabIds.add(bgTabId);

          const loaded = await waitForTabLoadComplete(bgTabId, BG_TAB_LOAD_TIMEOUT_MS, () => portDisconnected);
          if (portDisconnected) return;

          let currentUrl = rawUrl;
          try {
            const tabState = await chrome.tabs.get(bgTabId);
            if (tabState?.url && /^https?:\/\//i.test(tabState.url)) {
              currentUrl = tabState.url;
            }
          } catch (_) {}

          if (!loaded) {
            safePost({ type: 'PDF_AUTH_REQUIRED', requestId, finalUrl: currentUrl, reason: 'BG_TAB_TIMEOUT' });
            return;
          }

          const pickDetectedHref = (frameList) => {
            const topFrame = frameList.find((f) => f.frameId === 0);
            const rawDetected = topFrame?.detectedHref || '';
            return /^https?:\/\//i.test(rawDetected) ? rawDetected : '';
          };

          let frames = await probeTabFramesForPdf(bgTabId);
          let pdfFrame = frames.find((f) => f.isPdf);
          let detectedHref = '';
          if (!pdfFrame) {
            detectedHref = pickDetectedHref(frames);
            if (detectedHref) {
              await sleep(300);
              if (portDisconnected) return;
              frames = await probeTabFramesForPdf(bgTabId);
              pdfFrame = frames.find((f) => f.isPdf);
              if (!pdfFrame) {
                detectedHref = pickDetectedHref(frames) || detectedHref;
              }
            } else {
              for (let poll = 0; poll < 2; poll++) {
                await sleep(600);
                if (portDisconnected) return;
                try {
                  const tabState = await chrome.tabs.get(bgTabId);
                  if (tabState?.url && /^https?:\/\//i.test(tabState.url)) {
                    currentUrl = tabState.url;
                  }
                } catch (_) {}
                frames = await probeTabFramesForPdf(bgTabId);
                pdfFrame = frames.find((f) => f.isPdf);
                detectedHref = pickDetectedHref(frames);
                if (pdfFrame || detectedHref) break;
              }
            }
          }

          if (!pdfFrame && detectedHref) {
            // HTML PDF wrapper (e.g. IEEE stamp.jsp) or iframe embed with explicit PDF URL
            const res = await runTabPdfTransfer(port, requestId, bgTabId, 0, detectedHref);
            if (!res.ok && !portDisconnected) {
              safePost({
                type: 'PDF_AUTH_REQUIRED',
                requestId,
                finalUrl: res.finalUrl || currentUrl,
                status: res.status || 0,
                reason: res.error || 'BG_TAB_WRAPPER_FAILED'
              });
            }
            return;
          }

          if (!pdfFrame) {
            // Site returned an HTML login page, paywall, or verification gate instead of rendering PDF
            safePost({ type: 'PDF_AUTH_REQUIRED', requestId, finalUrl: currentUrl });
            return;
          }

          const transferUrl = /^https?:\/\//i.test(pdfFrame.url) ? pdfFrame.url : currentUrl;
          const res = await runTabPdfTransfer(port, requestId, bgTabId, pdfFrame.frameId, transferUrl);
          if (!res.ok && !portDisconnected) {
            safePost({
              type: 'PDF_AUTH_REQUIRED',
              requestId,
              finalUrl: res.finalUrl || transferUrl,
              status: res.status || 0,
              reason: res.error || 'BG_TAB_STREAM_FAILED'
            });
          }
        } catch (err) {
          if (!portDisconnected) {
            safePost({ type: 'PDF_AUTH_REQUIRED', requestId, finalUrl: rawUrl, reason: err?.message || 'BG_TAB_ERROR' });
          }
        } finally {
          if (typeof bgTabId === 'number') {
            activeBgTabIds.delete(bgTabId);
            await chrome.tabs.remove(bgTabId).catch(() => {});
          }
        }
      })();
    }
  });
});

// ============================================================
// R4: On-Demand Vision Image Overlay Translation
// ============================================================

const MAX_RAW_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_VISION_DIMENSION = 1600;
const MAX_DIRECT_VISION_BYTES = 4 * 1024 * 1024;

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function makeVisionError(message, errorCode, httpStatus = 0) {
  const err = new Error(message);
  if (errorCode) err.errorCode = errorCode;
  if (httpStatus) err.httpStatus = httpStatus;
  return err;
}

function isVisionUnsupportedError(errText, httpStatus) {
  if (httpStatus === 415) return true;
  if (httpStatus !== 400 && httpStatus !== 404 && httpStatus !== 422) return false;
  return /image|vision|multimodal|inline_data|inlineData|image_url|media|content.{0,30}(must be|expected).{0,20}string|invalid type:\s*sequence|content array|unknown variant.{0,20}image_url|not.{0,12}multimodal|does not support.{0,25}(image|vision|multimodal|media|file)|unsupported.{0,20}(type|modality|content|image|media)/i.test(
    String(errText || '')
  );
}

function srgbChannelToLinear(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function computeRelativeLuminance(r, g, b) {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

function computeContrastRatio(lum1, lum2) {
  const hi = Math.max(lum1, lum2);
  const lo = Math.min(lum1, lum2);
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHex(r, g, b) {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}

function pickHighContrastFallback(bgLum) {
  const slateDarkLum = computeRelativeLuminance(15, 23, 42); // #0f172a
  const slateLightLum = computeRelativeLuminance(248, 250, 252); // #f8fafc
  const crLight = computeContrastRatio(bgLum, slateLightLum);
  const crDark = computeContrastRatio(bgLum, slateDarkLum);
  const preferLight = crLight > crDark;
  const bestCr = preferLight ? crLight : crDark;
  if (bestCr >= 4.5) {
    return { fg: preferLight ? '#f8fafc' : '#0f172a', isDarkBg: preferLight };
  }
  const pureWhiteCr = computeContrastRatio(bgLum, 1.0);
  const pureBlackCr = computeContrastRatio(bgLum, 0.0);
  return {
    fg: pureWhiteCr >= pureBlackCr ? '#ffffff' : '#000000',
    isDarkBg: pureWhiteCr >= pureBlackCr
  };
}

// Expand a vision text box so the opaque label also covers glyph edges the model's box cut off
function refineImageBoxToInk(samplePixels, W, H, box, bg) {
  if (!samplePixels || !W || !H || !bg) {
    return { ymin: box.ymin, xmin: box.xmin, ymax: box.ymax, xmax: box.xmax };
  }

  // 1. Convert normalized 0..1000 box to inclusive sample pixel coordinates, clamped to image.
  const initX0 = Math.max(0, Math.min(W - 1, Math.floor((box.xmin / 1000) * W)));
  const initX1 = Math.max(initX0, Math.min(W - 1, Math.ceil((box.xmax / 1000) * W) - 1));
  const initY0 = Math.max(0, Math.min(H - 1, Math.floor((box.ymin / 1000) * H)));
  const initY1 = Math.max(initY0, Math.min(H - 1, Math.ceil((box.ymax / 1000) * H) - 1));

  let x0 = initX0;
  let x1 = initX1;
  let y0 = initY0;
  let y1 = initY1;

  const bgR = bg.r;
  const bgG = bg.g;
  const bgB = bg.b;

  // 2. Check whether pixel (x, y) is foreground ink relative to sampled background.
  const isInk = (x, y) => {
    const idx = (y * W + x) * 4;
    if (samplePixels[idx + 3] < 128) return false;
    const dr = Math.abs(samplePixels[idx] - bgR);
    const dg = Math.abs(samplePixels[idx + 1] - bgG);
    const db = Math.abs(samplePixels[idx + 2] - bgB);
    return Math.max(dr, dg, db) >= 56;
  };

  // 3. Growth budgets derived from the height of ONE text line, not the whole box: multi-line titles
  //    are tall, and budgets based on their full height let the box creep into nearby illustrations.
  const hPx = initY1 - initY0 + 1;
  let lineBands = 0;
  let inBand = false;
  for (let y = initY0; y <= initY1; y++) {
    let rowHasInk = false;
    for (let x = initX0; x <= initX1; x++) {
      if (isInk(x, y)) { rowHasInk = true; break; }
    }
    if (rowHasInk && !inBand) lineBands++;
    inBand = rowHasInk;
  }
  const lineH = hPx / Math.max(1, lineBands);
  const maxGrowX = Math.max(2, Math.round(0.6 * lineH));
  const maxGrowY = Math.max(2, Math.round(0.3 * lineH));
  // Only bridge letter spacing (not word spaces), so a cut-off glyph is covered without swallowing neighbours
  const gapTol = Math.max(1, Math.round(0.15 * lineH));

  // Clamp per-side expansion limits so total growth across passes never exceeds budgets.
  const minAllowedX0 = Math.max(0, initX0 - maxGrowX);
  const maxAllowedX1 = Math.min(W - 1, initX1 + maxGrowX);
  const minAllowedY0 = Math.max(0, initY0 - maxGrowY);
  const maxAllowedY1 = Math.min(H - 1, initY1 + maxGrowY);

  // 4. Horizontal scan helper: expand x0 left and x1 right from current edges.
  const expandHorizontal = () => {
    const spanH = y1 - y0 + 1;

    // Scan left from current x0
    let bestLeft = x0;
    let emptyRun = 0;
    for (let x = x0 - 1; x >= minAllowedX0; x--) {
      let inkCount = 0;
      for (let y = y0; y <= y1; y++) {
        if (isInk(x, y)) inkCount++;
      }
      if (inkCount / spanH > 0.7) break; // Stop at solid border / rule / illustration edge
      if (inkCount > 0) {
        bestLeft = x;
        emptyRun = 0;
      } else {
        emptyRun++;
        if (emptyRun > gapTol) break;
      }
    }
    x0 = bestLeft;

    // Scan right from current x1
    let bestRight = x1;
    emptyRun = 0;
    for (let x = x1 + 1; x <= maxAllowedX1; x++) {
      let inkCount = 0;
      for (let y = y0; y <= y1; y++) {
        if (isInk(x, y)) inkCount++;
      }
      if (inkCount / spanH > 0.7) break; // Stop at solid border / rule / illustration edge
      if (inkCount > 0) {
        bestRight = x;
        emptyRun = 0;
      } else {
        emptyRun++;
        if (emptyRun > gapTol) break;
      }
    }
    x1 = bestRight;
  };

  // 5. Vertical scan helper: expand y0 up and y1 down with zero gap tolerance.
  const expandVertical = () => {
    const spanW = x1 - x0 + 1;

    // Scan up from current y0
    let bestTop = y0;
    for (let y = y0 - 1; y >= minAllowedY0; y--) {
      let inkCount = 0;
      for (let x = x0; x <= x1; x++) {
        if (isInk(x, y)) inkCount++;
      }
      if (inkCount === 0 || inkCount / spanW > 0.6) break;
      bestTop = y;
    }
    y0 = bestTop;

    // Scan down from current y1
    let bestBottom = y1;
    for (let y = y1 + 1; y <= maxAllowedY1; y++) {
      let inkCount = 0;
      for (let x = x0; x <= x1; x++) {
        if (isInk(x, y)) inkCount++;
      }
      if (inkCount === 0 || inkCount / spanW > 0.6) break;
      bestBottom = y;
    }
    y1 = bestBottom;
  };

  // 6. Horizontal -> Vertical -> Horizontal (vertical expansion can uncover overhanging glyphs).
  expandHorizontal();
  expandVertical();
  expandHorizontal();

  // 7. Add 1 px safety margin on each side that actually grew, clamped to image bounds.
  const grewLeft = x0 < initX0;
  const grewRight = x1 > initX1;
  const grewTop = y0 < initY0;
  const grewBottom = y1 > initY1;

  if (grewLeft) x0 = Math.max(0, x0 - 1);
  if (grewRight) x1 = Math.min(W - 1, x1 + 1);
  if (grewTop) y0 = Math.max(0, y0 - 1);
  if (grewBottom) y1 = Math.min(H - 1, y1 + 1);

  // Convert inclusive pixel bounds [x0..x1], [y0..y1] back to 0..1000 integers,
  // ensuring the refined box is never smaller than the input box on any edge.
  const inYmin = Math.max(0, Math.min(1000, Math.floor(box.ymin)));
  const inXmin = Math.max(0, Math.min(1000, Math.floor(box.xmin)));
  const inYmax = Math.max(0, Math.min(1000, Math.ceil(box.ymax)));
  const inXmax = Math.max(0, Math.min(1000, Math.ceil(box.xmax)));

  const outXmin = grewLeft
    ? Math.max(0, Math.min(inXmin, Math.floor((x0 / W) * 1000)))
    : inXmin;
  const outXmax = grewRight
    ? Math.min(1000, Math.max(inXmax, Math.ceil(((x1 + 1) / W) * 1000)))
    : inXmax;
  const outYmin = grewTop
    ? Math.max(0, Math.min(inYmin, Math.floor((y0 / H) * 1000)))
    : inYmin;
  const outYmax = grewBottom
    ? Math.min(1000, Math.max(inYmax, Math.ceil(((y1 + 1) / H) * 1000)))
    : inYmax;

  return {
    ymin: outYmin,
    xmin: outXmin,
    ymax: outYmax,
    xmax: outXmax,
  };
}

function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function sampleImageBoxColors(samplePixels, W, H, box) {
  if (!samplePixels || !W || !H) {
    return { bg: '#ffffff', fg: '#0f172a', isDarkBg: false };
  }
  const x0 = Math.max(0, Math.min(W - 1, Math.floor((box.xmin / 1000) * W)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor((box.ymin / 1000) * H)));
  const x1 = Math.max(x0, Math.min(W - 1, Math.ceil((box.xmax / 1000) * W)));
  const y1 = Math.max(y0, Math.min(H - 1, Math.ceil((box.ymax / 1000) * H)));

  const buckets = new Map();
  let totalPerim = 0;
  let opaquePerim = 0;

  const pushBorder = (px, py) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    totalPerim += 1;
    const idx = (py * W + px) * 4;
    if (samplePixels[idx + 3] < 128) return;
    opaquePerim += 1;
    const r = samplePixels[idx];
    const g = samplePixels[idx + 1];
    const b = samplePixels[idx + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let entry = buckets.get(key);
    if (!entry) {
      entry = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
      buckets.set(key, entry);
    }
    entry.count += 1;
    entry.sumR += r;
    entry.sumG += g;
    entry.sumB += b;
  };

  const pad = Math.max(1, Math.round(W * 0.004));
  const rings = [
    { rx0: x0, ry0: y0, rx1: x1, ry1: y1 },
    {
      rx0: Math.max(0, x0 - pad),
      ry0: Math.max(0, y0 - pad),
      rx1: Math.min(W - 1, x1 + pad),
      ry1: Math.min(H - 1, y1 + pad)
    }
  ];
  for (const ring of rings) {
    for (let x = ring.rx0; x <= ring.rx1; x += 2) {
      pushBorder(x, ring.ry0);
      pushBorder(x, ring.ry1);
    }
    for (let y = ring.ry0; y <= ring.ry1; y += 2) {
      pushBorder(ring.rx0, y);
      pushBorder(ring.rx1, y);
    }
  }

  let bgR = 255;
  let bgG = 255;
  let bgB = 255;
  let bgHex = '#ffffff';

  if (totalPerim === 0 || opaquePerim / totalPerim < 0.4 || buckets.size === 0) {
    // Transparent perimeter: infer matte from opaque interior pixel luminance
    let lumSum = 0;
    let lumCount = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const idx = (y * W + x) * 4;
        if (samplePixels[idx + 3] < 128) continue;
        lumSum += computeRelativeLuminance(samplePixels[idx], samplePixels[idx + 1], samplePixels[idx + 2]);
        lumCount += 1;
      }
    }
    const avgInteriorLum = lumCount > 0 ? lumSum / lumCount : 0.1;
    if (avgInteriorLum > 0.45) {
      bgR = 15;
      bgG = 23;
      bgB = 42;
      bgHex = '#0f172a';
    } else {
      bgR = 255;
      bgG = 255;
      bgB = 255;
      bgHex = '#ffffff';
    }
  } else {
    let bestBucket = null;
    for (const bucket of buckets.values()) {
      if (!bestBucket || bucket.count > bestBucket.count) {
        bestBucket = bucket;
      }
    }
    bgR = Math.round(bestBucket.sumR / bestBucket.count);
    bgG = Math.round(bestBucket.sumG / bestBucket.count);
    bgB = Math.round(bestBucket.sumB / bestBucket.count);
    bgHex = rgbToHex(bgR, bgG, bgB);
  }

  const bgLum = computeRelativeLuminance(bgR, bgG, bgB);
  const fallback = pickHighContrastFallback(bgLum);
  const isDarkBg = fallback.isDarkBg;

  const contrastPixels = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const idx = (y * W + x) * 4;
      if (samplePixels[idx + 3] < 128) continue;
      const r = samplePixels[idx];
      const g = samplePixels[idx + 1];
      const b = samplePixels[idx + 2];
      const lum = computeRelativeLuminance(r, g, b);
      const lumDiff = Math.abs(lum - bgLum);
      const rgbDist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
      if (lumDiff >= 0.12 || rgbDist >= 110) {
        contrastPixels.push({ r, g, b, cr: computeContrastRatio(bgLum, lum) });
      }
    }
  }

  let fg = fallback.fg;
  if (contrastPixels.length >= 3) {
    contrastPixels.sort((a, b) => b.cr - a.cr);
    const take = Math.max(2, Math.min(24, Math.ceil(contrastPixels.length * 0.12)));
    let sR = 0;
    let sG = 0;
    let sB = 0;
    for (let i = 0; i < take; i++) {
      sR += contrastPixels[i].r;
      sG += contrastPixels[i].g;
      sB += contrastPixels[i].b;
    }
    const fgR = Math.round(sR / take);
    const fgG = Math.round(sG / take);
    const fgB = Math.round(sB / take);
    const fgLum = computeRelativeLuminance(fgR, fgG, fgB);
    if (computeContrastRatio(bgLum, fgLum) >= 4.5) {
      fg = rgbToHex(fgR, fgG, fgB);
    }
  }

  return {
    bg: bgHex,
    fg,
    isDarkBg
  };
}

function sniffImageMime(bytes) {
  if (!bytes || bytes.length === 0) return '';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const hdr6 = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
    if (hdr6 === 'GIF87a' || hdr6 === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
    const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (ftyp === 'ftyp') {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return 'image/x-icon';
  }

  let head = '';
  const limit = Math.min(bytes.length, 512);
  for (let i = 0; i < limit; i++) {
    const b = bytes[i];
    if (b === 0) return '';
    head += String.fromCharCode(b);
  }
  const cleanHead = head.replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (
    cleanHead.startsWith('<!doctype') ||
    cleanHead.startsWith('<html') ||
    cleanHead.startsWith('<head') ||
    cleanHead.startsWith('<body') ||
    cleanHead.startsWith('<script') ||
    cleanHead.startsWith('{') ||
    cleanHead.startsWith('[')
  ) {
    return 'text/invalid';
  }
  if (cleanHead.startsWith('<svg') || (cleanHead.startsWith('<?xml') && cleanHead.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return '';
}

function parseImageDataUrl(rawDataUrl) {
  const str = String(rawDataUrl || '').trim();
  const match = str.match(/^data:(image\/[a-z0-9.+-]+)((?:;[a-z0-9=._+-]+)*),(.*)$/i);
  if (!match) {
    throw makeVisionError('無效的圖片 Data URL', 'FETCH_FAILED');
  }
  let mimeType = match[1].toLowerCase();
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
  const params = String(match[2] || '').toLowerCase();
  const payload = match[3] || '';

  let rawBytes;
  if (params.includes(';base64')) {
    try {
      rawBytes = base64ToUint8(payload.replace(/\s+/g, ''));
    } catch (_) {
      throw makeVisionError('圖片 Base64 編碼無效', 'FETCH_FAILED');
    }
  } else if (mimeType === 'image/svg+xml') {
    try {
      rawBytes = new TextEncoder().encode(decodeURIComponent(payload));
    } catch (_) {
      rawBytes = new TextEncoder().encode(payload);
    }
  } else {
    throw makeVisionError('不支援的非 Base64 圖片 Data URL', 'FETCH_FAILED');
  }

  if (rawBytes.byteLength === 0) {
    throw makeVisionError('圖片內容為空', 'FETCH_FAILED');
  }
  if (rawBytes.byteLength > MAX_RAW_IMAGE_BYTES) {
    throw makeVisionError('圖片超過 16MB 上限', 'FETCH_FAILED');
  }
  const sniffed = sniffImageMime(rawBytes);
  if (sniffed === 'text/invalid') {
    throw makeVisionError('圖片資料內容無效', 'FETCH_FAILED');
  }
  if (sniffed === 'image/svg+xml') {
    mimeType = 'image/svg+xml';
  }
  return { mimeType, rawBytes };
}

function normalizeHttpImageUrl(rawUrl) {
  const str = String(rawUrl || '').trim();
  if (!str) return '';
  let parsed;
  try {
    parsed = new URL(str);
  } catch (_) {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '';
  }
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

async function readResponseBytesBounded(resp, maxBytes) {
  if (resp.body && typeof resp.body.getReader === 'function') {
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          total += value.byteLength;
          if (total > maxBytes) {
            try {
              await reader.cancel();
            } catch (_) {}
            throw makeVisionError('圖片超過 16MB 上限', 'FETCH_FAILED');
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_) {}
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw makeVisionError('圖片超過 16MB 上限', 'FETCH_FAILED');
  }
  return new Uint8Array(buf);
}

async function computeImageDigest(rawBytes, fallbackIdentity) {
  if (rawBytes && rawBytes.byteLength > 0 && globalThis.crypto?.subtle?.digest) {
    try {
      const digestBuf = await globalThis.crypto.subtle.digest('SHA-256', rawBytes);
      const view = new Uint8Array(digestBuf);
      let hex = '';
      for (let i = 0; i < view.length; i++) {
        hex += view[i].toString(16).padStart(2, '0');
      }
      if (hex) return hex;
    } catch (_) {}
  }
  return hashText(String(fallbackIdentity || ''));
}

async function prepareImagePayloadForVision(srcUrl, dataUrl) {
  let mimeType = 'image/png';
  let rawBytes = null;

  const cleanDataUrl = String(dataUrl || '').trim();
  const cleanSrcUrl = String(srcUrl || '').trim();

  if (cleanDataUrl) {
    const parsedData = parseImageDataUrl(cleanDataUrl);
    mimeType = parsedData.mimeType;
    rawBytes = parsedData.rawBytes;
  } else if (/^data:/i.test(cleanSrcUrl)) {
    const parsedData = parseImageDataUrl(cleanSrcUrl);
    mimeType = parsedData.mimeType;
    rawBytes = parsedData.rawBytes;
  } else if (/^https?:\/\//i.test(cleanSrcUrl)) {
    let parsedUrl;
    try {
      parsedUrl = new URL(cleanSrcUrl);
    } catch (_) {
      throw makeVisionError('無效的圖片網址', 'FETCH_FAILED');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw makeVisionError('不支援此圖片來源協定', 'FETCH_FAILED');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      let resp;
      try {
        resp = await fetch(cleanSrcUrl, { credentials: 'include', signal: controller.signal });
      } catch (e) {
        if (controller.signal.aborted) throw e;
        resp = await fetch(cleanSrcUrl, { credentials: 'omit', signal: controller.signal });
      }
      if (!resp.ok) {
        throw makeVisionError(`無法下載圖片 (HTTP ${resp.status})`, 'FETCH_FAILED', resp.status);
      }
      const clHeader = resp.headers?.get?.('content-length');
      if (clHeader !== null && clHeader !== undefined && clHeader !== '') {
        const cl = Number(clHeader);
        if (Number.isFinite(cl) && cl > MAX_RAW_IMAGE_BYTES) {
          throw makeVisionError('圖片超過 16MB 上限', 'FETCH_FAILED');
        }
      }
      const ct = (resp.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
      const isOctetStream = ct === 'application/octet-stream' || ct === 'binary/octet-stream';
      if (ct && !ct.startsWith('image/') && !isOctetStream) {
        throw makeVisionError(`來源非圖片格式 (${ct})`, 'FETCH_FAILED');
      }

      rawBytes = await readResponseBytesBounded(resp, MAX_RAW_IMAGE_BYTES);
      if (rawBytes.byteLength === 0) {
        throw makeVisionError('圖片內容為空', 'FETCH_FAILED');
      }

      const sniffed = sniffImageMime(rawBytes);
      if (sniffed === 'text/invalid') {
        throw makeVisionError('來源回傳內容非有效圖片', 'FETCH_FAILED');
      }
      if (!ct || isOctetStream) {
        if (!sniffed || !sniffed.startsWith('image/')) {
          throw makeVisionError('無法辨識圖片來源格式', 'FETCH_FAILED');
        }
        mimeType = sniffed;
      } else {
        mimeType = ct === 'image/jpg' ? 'image/jpeg' : ct;
        if (sniffed === 'image/svg+xml') {
          mimeType = 'image/svg+xml';
        }
      }
    } catch (err) {
      if (err?.errorCode) throw err;
      if (err?.name === 'AbortError') {
        throw makeVisionError('下載圖片逾時', 'FETCH_FAILED');
      }
      throw makeVisionError(err?.message || '無法下載圖片', 'FETCH_FAILED');
    } finally {
      clearTimeout(timer);
    }
  } else if (/^blob:/i.test(cleanSrcUrl)) {
    throw makeVisionError('blob: 圖片需由頁面轉換後傳送', 'FETCH_FAILED');
  } else {
    throw makeVisionError('不支援此圖片來源協定', 'FETCH_FAILED');
  }

  const blob = new Blob([rawBytes], { type: mimeType });
  let samplePixels = null;
  let sampleW = 0;
  let sampleH = 0;
  let sendBytes = null;
  let sendMime = mimeType;
  let width = 0;
  let height = 0;

  if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(blob);
      const origW = bitmap.width;
      const origH = bitmap.height;
      width = origW;
      height = origH;

      // Sample buffer (~480px max edge) preserving alpha for accurate color & transparency sampling
      const sampleScale = Math.min(1, 480 / Math.max(origW, origH, 1));
      sampleW = Math.max(16, Math.round(origW * sampleScale));
      sampleH = Math.max(16, Math.round(origH * sampleScale));
      const sCanvas = new OffscreenCanvas(sampleW, sampleH);
      const sCtx = sCanvas.getContext('2d', { willReadFrequently: true });
      sCtx.drawImage(bitmap, 0, 0, sampleW, sampleH);
      samplePixels = sCtx.getImageData(0, 0, sampleW, sampleH).data;

      let transparentCount = 0;
      let opaqueLumSum = 0;
      let opaqueCount = 0;
      const pixelTotal = sampleW * sampleH;
      for (let i = 0; i < samplePixels.length; i += 4) {
        if (samplePixels[i + 3] < 245) {
          transparentCount += 1;
        }
        if (samplePixels[i + 3] >= 128) {
          opaqueLumSum += computeRelativeLuminance(samplePixels[i], samplePixels[i + 1], samplePixels[i + 2]);
          opaqueCount += 1;
        }
      }
      const hasAlpha = pixelTotal > 0 && transparentCount / pixelTotal > 0.02;
      const opaqueAvgLum = opaqueCount > 0 ? opaqueLumSum / opaqueCount : 0.2;

      const needsReencode =
        Math.max(origW, origH) > MAX_VISION_DIMENSION ||
        rawBytes.byteLength > MAX_DIRECT_VISION_BYTES ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType);

      if (needsReencode) {
        const scale = Math.min(1, MAX_VISION_DIMENSION / Math.max(origW, origH, 1));
        const outW = Math.max(32, Math.round(origW * scale));
        const outH = Math.max(32, Math.round(origH * scale));
        const oCanvas = new OffscreenCanvas(outW, outH);
        const oCtx = oCanvas.getContext('2d');

        let exported = null;
        if (hasAlpha) {
          oCtx.drawImage(bitmap, 0, 0, outW, outH);
          const pngBlob = await oCanvas.convertToBlob({ type: 'image/png' });
          if (pngBlob.size <= MAX_DIRECT_VISION_BYTES) {
            exported = { blob: pngBlob, mime: 'image/png' };
          } else {
            oCtx.clearRect(0, 0, outW, outH);
            oCtx.fillStyle = opaqueAvgLum > 0.45 ? '#0f172a' : '#ffffff';
            oCtx.fillRect(0, 0, outW, outH);
            oCtx.drawImage(bitmap, 0, 0, outW, outH);
          }
        } else {
          oCtx.drawImage(bitmap, 0, 0, outW, outH);
        }

        if (!exported) {
          const jpgBlob = await oCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
          exported = { blob: jpgBlob, mime: 'image/jpeg' };
        }
        sendBytes = new Uint8Array(await exported.blob.arrayBuffer());
        sendMime = exported.mime;
        width = outW;
        height = outH;
      }
    } catch (_) {
      if (mimeType === 'image/svg+xml') {
        throw makeVisionError(
          '目前模型不支援未點陣化的 SVG 向量圖，請改用 PNG / JPEG / WebP 圖片。',
          'VISION_UNSUPPORTED'
        );
      }
    } finally {
      try {
        bitmap?.close?.();
      } catch (_) {}
    }
  } else if (mimeType === 'image/svg+xml') {
    throw makeVisionError(
      '目前環境無法將 SVG 向量圖點陣化以進行視覺翻譯。',
      'VISION_UNSUPPORTED'
    );
  }

  if (!sendBytes) {
    if (mimeType === 'image/svg+xml') {
      throw makeVisionError(
        '目前模型不支援未點陣化的 SVG 向量圖，請改用 PNG / JPEG / WebP 圖片。',
        'VISION_UNSUPPORTED'
      );
    }
    sendBytes = rawBytes;
  }

  const base64 = uint8ToBase64(sendBytes);
  return {
    base64,
    mimeType: sendMime,
    dataUrl: `data:${sendMime};base64,${base64}`,
    width,
    height,
    rawBytes,
    samplePixels,
    sampleW,
    sampleH
  };
}

function buildVisionImagePrompts(settings, pageContext = null, dims = null) {
  const lang = resolveTargetLanguage(settings);
  const glossarySection = buildGlossarySection(settings, pageContext);
  const { roleLine, topicLine } = buildRoleAndTopicLines(pageContext);

  const systemPrompt = [
    'You are an expert multimodal infographic & technical diagram translator.',
    roleLine,
    buildLanguageGuidance(lang),
    'Task: Detect every readable text block (titles, panel badges like "(A) ...", headings, wrapped paragraphs, subheadings, captions, diagram callouts, axis labels) inside the image that is NOT already in the target language, and translate it accurately and naturally.',
    'Strict Layout & Bounding-Box Rules:',
    '1. Group lines belonging to the SAME heading, sentence, or short paragraph into ONE block so the translation reads naturally; keep visually distinct UI elements (e.g. badge vs bold summary vs colored subheading vs small caption) as SEPARATE non-overlapping boxes.',
    '2. Keep each `box_2d` [ymin, xmin, ymax, xmax] (integers 0..1000) TIGHT around ONLY the text itself — NEVER cover pure illustrations, 3D schematics, photos, icons, vertical accent bars, or card borders.',
    '3. Preserve symbols, parenthetical codes like (A) or (IFC), units, numbers, bullets (•), formulas, and brand/product names accurately. If there is no untranslated readable text, return {"blocks":[]}.',
    '4. Output ONLY valid JSON in this exact shape: {"blocks":[{"box_2d":[ymin,xmin,ymax,xmax],"text":"translated text","role":"title|badge|body"}]}',
    '5. No markdown code fences, no commentary.',
    glossarySection
  ].filter(Boolean).join('\n');

  const dimLine = dims?.width > 0 && dims?.height > 0
    ? `Image dimensions: ${dims.width}x${dims.height} px.`
    : '';
  const userPrompt = [
    topicLine,
    dimLine,
    `Detect and translate all readable text blocks into ${lang.promptName || lang.label}. Return strict JSON {"blocks":[...]}.`
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt };
}

function parseVisionBlocksJson(rawContent) {
  const parsed = extractJsonObject(rawContent);
  let rawBlocks = null;
  if (Array.isArray(parsed)) {
    rawBlocks = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.blocks)) {
      rawBlocks = parsed.blocks;
    } else if (Array.isArray(parsed.data)) {
      rawBlocks = parsed.data;
    }
  }
  if (!rawBlocks) {
    throw makeVisionError('JSON 缺少 blocks 陣列', 'PARSE_FAILED');
  }

  const blocks = [];
  for (const b of rawBlocks) {
    if (!b || typeof b !== 'object') continue;
    const coords = Array.isArray(b.box_2d)
      ? b.box_2d
      : (Array.isArray(b.box) ? b.box : [b.ymin, b.xmin, b.ymax, b.xmax]);
    if (!Array.isArray(coords) || coords.length < 4) continue;

    let ymin = Number(coords[0]);
    let xmin = Number(coords[1]);
    let ymax = Number(coords[2]);
    let xmax = Number(coords[3]);
    if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) continue;

    // Handle models that return 0..1 normalized floats instead of 0..1000
    if (ymin >= 0 && xmin >= 0 && ymax > ymin && xmax > xmin && ymax <= 1 && xmax <= 1) {
      ymin *= 1000;
      xmin *= 1000;
      ymax *= 1000;
      xmax *= 1000;
    }

    ymin = Math.max(0, Math.min(1000, Math.round(ymin)));
    xmin = Math.max(0, Math.min(1000, Math.round(xmin)));
    ymax = Math.max(0, Math.min(1000, Math.round(ymax)));
    xmax = Math.max(0, Math.min(1000, Math.round(xmax)));

    if (ymin >= ymax || xmin >= xmax || (ymax - ymin) < 2 || (xmax - xmin) < 2) {
      continue;
    }

    const translated = String(b.text || b.zh || b.translation || '').trim();
    if (!translated) continue;
    const role = b.role === 'title' || b.role === 'badge' ? b.role : 'body';
    blocks.push({ ymin, xmin, ymax, xmax, text: translated, role });
  }
  return blocks;
}

async function callVisionImageLLM(settings, systemPrompt, userPrompt, mimeType, base64Data) {
  assertModelConfigured(settings);
  const endpoint = resolveEndpoint(settings);
  if (!endpoint) {
    throw makeVisionError('API 地址無效，請檢查設定中的 Base URL', 'INVALID_ENDPOINT');
  }

  const pacingKey = getProviderPacingKey(settings);
  const cleanKey = sanitizeApiKey(settings.apiKey);
  // Locating text boxes and translating in one multimodal call is too hard at MINIMAL thinking (boxes get
  // dropped or swapped between cards), so on-demand image translation uses at least the 'balanced' level.
  const visionEffort = settings.thinkingEffort === 'deep' ? 'deep' : 'balanced';
  const thinkingConfig = resolveThinkingConfig(settings.model, visionEffort);
  const maxAttempts = 3;
  let lastVisionErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let sleepAfterAttemptMs = 0;
    await acquireRequestSlot(null, pacingKey);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60000);

    try {
      let resp;
      let preReadErrText = null;

      if (settings.protocol === 'gemini') {
        const normModel = normalizeGeminiModelId(settings.model);
        const isGemini3Or4 = /^gemini-(?:3|4)(?:[.\-]|$)/.test(normModel);
        const generationConfig = {
          responseMimeType: 'application/json'
        };
        if (!isGemini3Or4) {
          generationConfig.temperature = 0.15;
        }
        if (thinkingConfig) {
          generationConfig.thinkingConfig = thinkingConfig;
        }
        const headers = buildProviderAuthHeaders(settings, cleanKey);
        resp = await fetch(endpoint, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [
              {
                role: 'user',
                parts: [
                  { text: userPrompt },
                  { inlineData: { mimeType, data: base64Data } }
                ]
              }
            ],
            generationConfig
          })
        });
      } else if (settings.protocol === 'anthropic') {
        const headers = buildProviderAuthHeaders(settings, cleanKey);
        const bodyObj = buildAnthropicMessagesBody(
          { ...settings, thinkingEffort: visionEffort },
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          { stream: false, maxTokens: 16000, image: { mimeType, base64: base64Data } }
        );
        resp = await fetch(endpoint, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify(bodyObj)
        });
      } else {
        const model = String(settings.model || '').trim();
        const effort = settings.thinkingEffort || 'fastest';
        const isOpenAIReasoning = /^o[134](?:-|$)/i.test(model);
        const isDeepSeekReasoner = /deepseek-reasoner|^r1\b/i.test(model);

        const headers = buildProviderAuthHeaders(settings, cleanKey);
        const bodyObj = {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                { type: 'text', text: userPrompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } }
              ]
            }
          ],
          response_format: { type: 'json_object' }
        };
        if (!isOpenAIReasoning && !isDeepSeekReasoner) {
          bodyObj.temperature = 0.15;
        }
        if (effort === 'fastest') {
          if (isOpenAIReasoning && /api\.openai\.com/i.test(endpoint)) {
            bodyObj.reasoning_effort = 'low';
          } else if (/^qwen3/i.test(model) && /dashscope\.aliyuncs\.com/i.test(endpoint)) {
            bodyObj.enable_thinking = false;
          }
        }

        resp = await fetch(endpoint, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify(bodyObj)
        });

        // Pre-inference HTTP 400 optional-param fallback (only when NOT a Vision-unsupported error)
        if (!resp.ok && resp.status === 400) {
          const errText = await resp.text();
          if (
            !isVisionUnsupportedError(errText, 400) &&
            /response_format|json_object|reasoning_effort|enable_thinking|temperature/i.test(errText)
          ) {
            delete bodyObj.response_format;
            delete bodyObj.reasoning_effort;
            delete bodyObj.enable_thinking;
            if (/temperature/i.test(errText)) delete bodyObj.temperature;
            resp = await fetch(endpoint, {
              method: 'POST',
              headers,
              signal: controller.signal,
              body: JSON.stringify(bodyObj)
            });
          } else {
            preReadErrText = errText;
          }
        }
      }

      if (!resp.ok) {
        const rawErrText = preReadErrText !== null ? preReadErrText : await resp.text();
        const safeRawText = redactAllKeys(rawErrText, settings);

        if (resp.status === 429) {
          const isDailyOrZeroQuota = /PerDay|RequestsPerDay|GenerateRequestsPerDay|"quotaValue"\s*:\s*"0"|limit:\s*0/i.test(safeRawText);
          const retryDelayMs = parseRetryDelayMs(safeRawText, resp);
          if (!isDailyOrZeroQuota) {
            const waitMs = Math.min(26000, retryDelayMs > 0 ? retryDelayMs + 400 : 4500);
            const now = Date.now();
            const st = getPacingState(pacingKey);
            st.adaptivePacingUntil = Math.max(st.adaptivePacingUntil, now + 90000);
            st.globalCooldownUntil = Math.max(st.globalCooldownUntil, now + waitMs);
            if (attempt < maxAttempts && retryDelayMs <= 20000) {
              continue;
            }
          }
          const waitSec = retryDelayMs > 0 ? Math.ceil(retryDelayMs / 1000) : null;
          const msg = isDailyOrZeroQuota
            ? 'HTTP 429：已達每日免費額度上限（或模型配額為 0）'
            : waitSec
              ? `HTTP 429：請求頻率達上限，請等待約 ${waitSec}s 後再試`
              : `HTTP 429：請求頻率達上限 (${safeRawText.slice(0, 160) || resp.statusText})`;
          throw makeVisionError(msg, isDailyOrZeroQuota ? 'QUOTA_EXCEEDED' : 'RATE_LIMIT', 429);
        }

        if (isVisionUnsupportedError(safeRawText, resp.status)) {
          throw makeVisionError(
            '目前模型不支援圖片視覺翻譯，請於設定頁改用多模態模型（如 Gemini / GPT-4o）。',
            'VISION_UNSUPPORTED',
            resp.status
          );
        }

        if ((resp.status >= 500 || resp.status === 529) && attempt < maxAttempts) {
          sleepAfterAttemptMs = computeOverloadBackoffMs(resp.status, attempt, safeRawText, resp, pacingKey);
          lastVisionErr = makeVisionError(
            `Vision API 錯誤 (${resp.status}): ${safeRawText.slice(0, 240)}`,
            resp.status === 503 || resp.status === 529 ? 'OVERLOADED' : `HTTP_${resp.status}`,
            resp.status
          );
          continue;
        }

        throw makeVisionError(
          `Vision API 錯誤 (${resp.status}): ${safeRawText.slice(0, 240)}`,
          resp.status === 503 || resp.status === 529 ? 'OVERLOADED' : `HTTP_${resp.status}`,
          resp.status
        );
      }

      const rawText = await resp.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (_) {
        throw makeVisionError('Vision API 回應非有效 JSON', 'PARSE_FAILED');
      }

      if (data?.error?.message) {
        throw makeVisionError(redactAllKeys(data.error.message, settings), 'API_ERROR');
      }

      let outText = '';
      if (settings.protocol === 'gemini') {
        const candidate = data?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const answerParts = parts.filter((p) => !p.thought && typeof p.text === 'string');
        outText = (answerParts.length ? answerParts : parts)
          .map((p) => (typeof p.text === 'string' ? p.text : ''))
          .join('\n')
          .trim();
      } else if (settings.protocol === 'anthropic') {
        outText = String(extractAnthropicText(data) || '').trim();
      } else {
        outText = String(data?.choices?.[0]?.message?.content || '').trim();
      }

      if (!outText) {
        throw makeVisionError('模型未返回有效的圖片翻譯內容', 'PARSE_FAILED');
      }
      return outText;
    } catch (err) {
      if (err?.name === 'AbortError' || timedOut) {
        lastVisionErr = makeVisionError('圖片視覺翻譯逾時 (60s)，請檢查網路或稍後重試', 'TIMEOUT');
        if (attempt < maxAttempts) {
          sleepAfterAttemptMs = 1000 * attempt;
          continue;
        }
        throw lastVisionErr;
      }
      if (err?.errorCode === 'INVALID_API_KEY_CHARS' || err?.errorCode === 'VISION_UNSUPPORTED' || err?.errorCode === 'PARSE_FAILED' || err?.errorCode === 'API_ERROR' || err?.httpStatus === 401 || err?.httpStatus === 403 || err?.httpStatus === 404) {
        if (err?.message) err.message = redactAllKeys(err.message, settings);
        throw err;
      }
      const isNet = err?.name === 'TypeError' || /network|failed to fetch|load failed|networkerror|fetch/i.test(String(err?.message || ''));
      if (isNet) {
        const netErr = makeVisionError(redactAllKeys(err?.message || '網路連線失敗', settings), 'NETWORK_ERROR');
        lastVisionErr = netErr;
        if (attempt < maxAttempts) {
          sleepAfterAttemptMs = 1000 * attempt;
          continue;
        }
        throw netErr;
      }
      if (err?.message) {
        err.message = redactAllKeys(err.message, settings);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      releaseRequestSlot(pacingKey);
      if (sleepAfterAttemptMs > 0) {
        await sleep(sleepAfterAttemptMs);
      }
    }
  }

  throw lastVisionErr || makeVisionError('圖片視覺翻譯失敗', 'VISION_ERROR');
}

function extractCachedVisionBlocks(cachedRaw) {
  if (!cachedRaw || typeof cachedRaw !== 'string') return null;
  try {
    const parsed = JSON.parse(cachedRaw);
    const list = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.blocks) ? parsed.blocks : null);
    if (Array.isArray(list) && list.length > 0) {
      return list;
    }
  } catch (_) {}
  return null;
}

async function handleTranslateImage(message) {
  const settings = await getSettings();
  const cleanKey = sanitizeApiKey(settings.apiKey);
  if (!cleanKey && !isLocalEndpoint(settings.baseUrl)) {
    return {
      ok: false,
      errorCode: 'NO_API_KEY',
      error: '請先於 NativeRead 設定頁填入 API Key'
    };
  }

  const effectiveSettings = { ...settings };
  const reqTargetLang = typeof message?.targetLang === 'string' ? message.targetLang.trim() : '';
  if (reqTargetLang && (TARGET_LANGUAGES?.[reqTargetLang] || reqTargetLang === 'custom')) {
    effectiveSettings.targetLang = reqTargetLang;
  }
  if (typeof message?.customTargetLang === 'string' && message.customTargetLang.trim()) {
    effectiveSettings.customTargetLang = message.customTargetLang.trim();
  }

  const srcUrl = String(message?.srcUrl || '').trim();
  const dataUrl = String(message?.dataUrl || '').trim();
  const pageContext = message?.pageContext || null;
  const force = Boolean(message?.force);

  if (!srcUrl && !dataUrl) {
    return { ok: false, errorCode: 'FETCH_FAILED', error: '找不到圖片來源' };
  }

  const lang = resolveTargetLanguage(effectiveSettings);
  const cacheSig = buildCacheSignature(effectiveSettings, pageContext);
  const modelPart = String(effectiveSettings.model || '').trim() || 'default';
  const langAndSig = `${lang.id}:${hashText(cacheSig)}`;

  const normalizedHttpUrl = !dataUrl ? normalizeHttpImageUrl(srcUrl) : '';
  const urlCacheKey = normalizedHttpUrl
    ? `img:v4:u_${hashText(normalizedHttpUrl)}:${modelPart}:${langAndSig}`
    : '';

  if (!force && urlCacheKey) {
    try {
      const hitMap = await CacheDB.getMany([urlCacheKey]);
      const cachedBlocks = extractCachedVisionBlocks(hitMap.get(urlCacheKey));
      if (cachedBlocks) {
        return { ok: true, cached: true, blocks: cachedBlocks };
      }
    } catch (_) {}
  }

  let prepared;
  try {
    prepared = await prepareImagePayloadForVision(srcUrl, dataUrl);
  } catch (err) {
    return {
      ok: false,
      errorCode: err?.errorCode || 'FETCH_FAILED',
      error: redactApiKey(err?.message || '無法讀取圖片內容', effectiveSettings.apiKey)
    };
  }

  const fallbackIdentity = normalizedHttpUrl || (dataUrl ? hashText(dataUrl) : srcUrl);
  const imgDigest = await computeImageDigest(prepared.rawBytes, fallbackIdentity);
  const shaCacheKey = `img:v4:${imgDigest}:${modelPart}:${langAndSig}`;

  if (!force) {
    try {
      const hitMap = await CacheDB.getMany([shaCacheKey]);
      const cachedBlocks = extractCachedVisionBlocks(hitMap.get(shaCacheKey));
      if (cachedBlocks) {
        if (urlCacheKey) {
          try {
            await CacheDB.putMany([{ key: urlCacheKey, zh: JSON.stringify({ blocks: cachedBlocks }) }]);
          } catch (_) {}
        }
        return { ok: true, cached: true, blocks: cachedBlocks };
      }
    } catch (_) {}
  }

  const reqWidth = Number(message?.width) > 0 ? Math.round(Number(message.width)) : (prepared.width || 0);
  const reqHeight = Number(message?.height) > 0 ? Math.round(Number(message.height)) : (prepared.height || 0);
  const prompts = buildVisionImagePrompts(effectiveSettings, pageContext, {
    width: reqWidth,
    height: reqHeight
  });

  let rawContent;
  let fbVisionSettings = null;
  let fallbackUsed = null;
  try {
    try {
      rawContent = await callVisionImageLLM(
        effectiveSettings,
        prompts.systemPrompt,
        prompts.userPrompt,
        prepared.mimeType,
        prepared.base64
      );
    } catch (primaryErr) {
      const fbBase = isFallbackEligibleError(primaryErr) ? resolveFallbackSettings(effectiveSettings) : null;
      if (!fbBase) throw primaryErr;
      fbVisionSettings = {
        ...fbBase,
        targetLang: effectiveSettings.targetLang,
        customTargetLang: effectiveSettings.customTargetLang,
        thinkingEffort: effectiveSettings.thinkingEffort
      };
      const fbPrompts = buildVisionImagePrompts(fbVisionSettings, pageContext, {
        width: reqWidth,
        height: reqHeight
      });
      rawContent = await callVisionImageLLM(
        fbVisionSettings,
        fbPrompts.systemPrompt,
        fbPrompts.userPrompt,
        prepared.mimeType,
        prepared.base64
      );
      fallbackUsed = {
        providerId: fbVisionSettings.providerId,
        label: PROVIDER_PRESETS[fbVisionSettings.providerId]?.label || fbVisionSettings.providerId,
        model: fbVisionSettings.model
      };
    }
  } catch (err) {
    return {
      ok: false,
      errorCode: err?.errorCode || (err?.httpStatus ? `HTTP_${err.httpStatus}` : 'VISION_ERROR'),
      error: redactAllKeys(err?.message || '圖片視覺翻譯失敗', effectiveSettings, fbVisionSettings)
    };
  }

  let blocks;
  try {
    blocks = parseVisionBlocksJson(rawContent);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'PARSE_FAILED',
      error: redactAllKeys(err?.message || '無法解析圖片翻譯結果，請重試', effectiveSettings, fbVisionSettings)
    };
  }

  const enriched = blocks.map((b) => {
    const colors = sampleImageBoxColors(prepared.samplePixels, prepared.sampleW, prepared.sampleH, b);
    const bgRgb = hexToRgbTriplet(colors.bg);
    const refined = bgRgb
      ? refineImageBoxToInk(prepared.samplePixels, prepared.sampleW, prepared.sampleH, b, bgRgb)
      : null;
    return {
      ...b,
      ...(refined || {}),
      bg: colors.bg,
      fg: colors.fg,
      isDarkBg: colors.isDarkBg
    };
  });

  if (enriched.length > 0) {
    const serialized = JSON.stringify({ blocks: enriched });
    const cacheEntries = [{ key: shaCacheKey, zh: serialized }];
    if (urlCacheKey && urlCacheKey !== shaCacheKey) {
      cacheEntries.push({ key: urlCacheKey, zh: serialized });
    }
    try {
      await CacheDB.putMany(cacheEntries);
    } catch (_) {}
  }

  return fallbackUsed
    ? { ok: true, cached: false, blocks: enriched, fallbackUsed }
    : { ok: true, cached: false, blocks: enriched };
}

// ============================================================
// Runtime Message Router
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'ENSURE_AND_COMMAND': {
          if (!isExtensionSender(sender)) {
            sendResponse({ ok: false, error: '拒絕未授權來源呼叫' });
            break;
          }
          const tabId = typeof message.tabId === 'number' ? message.tabId : sender?.tab?.id;
          if (typeof tabId !== 'number') {
            sendResponse({ ok: false, error: '找不到目標分頁' });
            break;
          }
          const res = await injectAndCommandTab(tabId, message.action, message.payload || null);
          sendResponse(res);
          break;
        }
        case 'TRANSLATE_BATCH': {
          const res = await handleTranslateBatch(message.items || [], message.pageContext || null);
          sendResponse(res);
          break;
        }
        case 'TRANSLATE_SINGLE': {
          const res = await handleTranslateSingle(
            message.text || '',
            message.mode || 'selection',
            message.pageContext || null
          );
          sendResponse(res);
          break;
        }
        case 'TRANSLATE_IMAGE': {
          const res = await handleTranslateImage(message);
          sendResponse(res);
          break;
        }
        case 'FRAME_STATUS': {
          const tabId = sender?.tab?.id;
          if (tabId) {
            try {
              await chrome.tabs.sendMessage(
                tabId,
                {
                  type: 'KCT_FRAME_STATUS',
                  frameId: sender.frameId ?? -1,
                  stats: message.stats
                },
                { frameId: 0 }
              );
            } catch (_) {
              // Top frame might not be ready yet
            }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'TEST_CONNECTION': {
          if (!isExtensionSender(sender)) {
            sendResponse({ ok: false, error: '拒絕未授權來源呼叫' });
            break;
          }
          const res = await handleTestConnection(message.settings);
          sendResponse(res);
          break;
        }
        case 'LIST_MODELS': {
          if (!isExtensionSender(sender)) {
            sendResponse({ ok: false, errorCode: 'UNAUTHORIZED', error: '拒絕未授權來源呼叫' });
            break;
          }
          const res = await handleListModels(message.settings);
          sendResponse(res);
          break;
        }
        case 'OPEN_OPTIONS': {
          await chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }
        case 'OPEN_PDF_VIEWER': {
          if (!isExtensionSender(sender)) {
            sendResponse({ ok: false, error: '拒絕未授權來源呼叫' });
            break;
          }
          let sourceTab = null;
          if (typeof message.tabId === 'number') {
            try {
              sourceTab = await chrome.tabs.get(message.tabId);
            } catch (_) {}
          }
          if (!sourceTab) {
            sourceTab = sender?.tab || null;
          }
          let pdfUrl = typeof message.url === 'string' && message.url.trim() ? message.url.trim() : '';
          if (!pdfUrl && message.detectFromTab && sourceTab?.id && isInjectableUrl(sourceTab.url)) {
            pdfUrl = await detectPdfUrlInTab(sourceTab.id, sourceTab.url);
          }
          const viewerRes = await openPdfViewer(pdfUrl, sourceTab);
          sendResponse({ ok: true, ...viewerRes });
          break;
        }
        case 'IMPORT_SYNC_PAYLOAD': {
          if (!isExtensionSender(sender)) {
            sendResponse({ ok: false, error: '拒絕未授權來源呼叫' });
            break;
          }
          const imported = await tryImportNrSyncRawInput(message.raw);
          if (!imported) {
            sendResponse({ ok: false, error: '同步連結格式無效或金鑰不合法' });
            break;
          }
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        }
        case 'GET_CACHE_STATS': {
          const { entries, bytes } = await CacheDB.stats();
          sendResponse({ ok: true, entries, bytes });
          break;
        }
        case 'GET_SW_DEBUG': {
          if (!isExtensionSender(sender)) {
            sendResponse({ ok: false, error: '拒絕未授權來源呼叫' });
            break;
          }
          sendResponse({
            ok: true,
            now: Date.now(),
            active: Array.from(activeBatchDebug.values()),
            recent: recentBatchDebug
          });
          break;
        }
        case 'CLEAR_CACHE': {
          if (!isExtensionSender(sender)) {
            sendResponse({ ok: false, error: '拒絕未授權來源呼叫' });
            break;
          }
          await CacheDB.clear();
          sendResponse({ ok: true });
          break;
        }
        case 'BROADCAST_TO_TAB': {
          const tabId = isExtensionSender(sender)
            ? (message.tabId || sender?.tab?.id)
            : sender?.tab?.id;
          if (tabId) {
            try {
              await chrome.tabs.sendMessage(tabId, message.payload);
            } catch (err) {
              console.warn('Broadcast to tab failed:', err.message);
            }
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      let safeErr = err?.message || '未知錯誤';
      try {
        const currentSettings = await getSettings();
        safeErr = redactAllKeys(safeErr, currentSettings);
      } catch (_) {}
      sendResponse({
        ok: false,
        error: safeErr,
        errorCode: err?.errorCode || (err?.httpStatus ? `HTTP_${err.httpStatus}` : undefined)
      });
    }
  })();
  return true;
});
