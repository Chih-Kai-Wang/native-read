(() => {
  if (globalThis.KCTConfig) return;

  // Provider registry: every base URL was checked on 2026-11-21 (GET /models and POST /chat/completions
  // answered 401/403/200, not 404). Default models are only set where they were confirmed available that day;
  // everywhere else the user picks from the live list ("取得模型清單"), so presets cannot go stale.
  const PROVIDER_PRESETS = {
    gemini: {
      id: 'gemini',
      label: 'Google Gemini（原生 · 有免費額度）',
      group: '原生介面',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-3.5-flash-lite',
      suggestedModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-2.5-flash'],
      placeholderKey: 'AQ... 或 AIza...',
      hint: '使用 Google AI Studio API Key；免費額度首選 gemini-3.5-flash-lite。按「取得模型清單」可看到帳號實際可用的模型。'
    },
    anthropic: {
      id: 'anthropic',
      label: 'Anthropic Claude（原生 Messages API）',
      group: '原生介面',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-opus-5-5',
      suggestedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
      placeholderKey: 'sk-ant-...',
      hint: '請至 platform.claude.com 取得 API Key；若需節省成本，可改選 claude-sonnet-5-5 或 claude-haiku-5-5。'
    },
    openai: {
      id: 'openai',
      label: 'OpenAI',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'sk-...',
      hint: '填入金鑰後按「取得模型清單」選擇模型。'
    },
    azure: {
      id: 'azure',
      label: 'Azure OpenAI（v1 API · api-key）',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'Azure API Key...',
      hint: '請將網址中的 YOUR-RESOURCE 替換為您的 Azure 資源名稱，並在模型欄位填入部署名稱（Deployment Name）。'
    },
    openrouter: {
      id: 'openrouter',
      label: 'OpenRouter（多家模型聚合）',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'google/gemini-2.5-flash',
      suggestedModels: ['google/gemini-2.5-flash'],
      placeholderKey: 'sk-or-...',
      publicModelList: true,
      hint: '聚合數百個模型，模型清單不需金鑰即可查詢。'
    },
    groq: {
      id: 'groq',
      label: 'Groq',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'gsk_...',
      hint: '低延遲推論；填入金鑰後按「取得模型清單」。'
    },
    mistral: {
      id: 'mistral',
      label: 'Mistral AI',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.mistral.ai/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    xai: {
      id: 'xai',
      label: 'xAI（Grok）',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'xai-...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    together: {
      id: 'together',
      label: 'Together AI',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.together.xyz/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      hint: '開源模型託管；填入金鑰後按「取得模型清單」。'
    },
    fireworks: {
      id: 'fireworks',
      label: 'Fireworks AI',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'fw_...',
      hint: '開源模型託管；填入金鑰後按「取得模型清單」。'
    },
    cerebras: {
      id: 'cerebras',
      label: 'Cerebras',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.cerebras.ai/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'csk-...',
      hint: '高速推論；填入金鑰後按「取得模型清單」。'
    },
    deepinfra: {
      id: 'deepinfra',
      label: 'DeepInfra',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.deepinfra.com/v1/openai',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      publicModelList: true,
      hint: '開源模型託管；模型清單不需金鑰即可查詢。'
    },
    huggingface: {
      id: 'huggingface',
      label: 'Hugging Face Inference Providers',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://router.huggingface.co/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'hf_...',
      publicModelList: true,
      hint: '使用 Hugging Face Token；模型清單不需金鑰即可查詢。'
    },
    novita: {
      id: 'novita',
      label: 'Novita AI',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.novita.ai/openai',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      publicModelList: true,
      hint: '開源模型託管；模型清單不需金鑰即可查詢。'
    },
    deepseek: {
      id: 'deepseek',
      label: 'DeepSeek',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'sk-...',
      hint: '填入金鑰後按「取得模型清單」選擇模型。'
    },
    'qwen-intl': {
      id: 'qwen-intl',
      label: '阿里雲百煉 Qwen（國際站）',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'sk-...',
      hint: '國際站金鑰；填入後按「取得模型清單」。'
    },
    'moonshot-intl': {
      id: 'moonshot-intl',
      label: 'Moonshot AI / Kimi（國際站）',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.moonshot.ai/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'sk-...',
      hint: 'platform.moonshot.ai 金鑰；填入後按「取得模型清單」。'
    },
    zai: {
      id: 'zai',
      label: 'Z.ai（智譜國際站）',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    'minimax-intl': {
      id: 'minimax-intl',
      label: 'MiniMax（國際站）',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.minimax.io/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    'siliconflow-intl': {
      id: 'siliconflow-intl',
      label: 'SiliconFlow（國際站）',
      group: '國際服務',
      protocol: 'openai',
      baseUrl: 'https://api.siliconflow.com/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'sk-...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    qwen: {
      id: 'qwen',
      label: '阿里雲百煉 Qwen（中國站）',
      group: '中國大陸服務',
      protocol: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'sk-...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    moonshot: {
      id: 'moonshot',
      label: 'Moonshot AI / Kimi（中國站）',
      group: '中國大陸服務',
      protocol: 'openai',
      baseUrl: 'https://api.moonshot.cn/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'sk-...',
      hint: 'platform.moonshot.cn 金鑰；填入後按「取得模型清單」。'
    },
    zhipu: {
      id: 'zhipu',
      label: '智譜 BigModel（中國站）',
      group: '中國大陸服務',
      protocol: 'openai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    siliconflow: {
      id: 'siliconflow',
      label: 'SiliconFlow 矽基流動（中國站）',
      group: '中國大陸服務',
      protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'sk-...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    volcengine: {
      id: 'volcengine',
      label: '火山引擎方舟 Doubao',
      group: '中國大陸服務',
      protocol: 'openai',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      hint: '模型欄位可填模型 ID 或推論接入點 ID；填入金鑰後按「取得模型清單」。'
    },
    qianfan: {
      id: 'qianfan',
      label: '百度千帆（v2 OpenAI 相容）',
      group: '中國大陸服務',
      protocol: 'openai',
      baseUrl: 'https://qianfan.baidubce.com/v2',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'bce-v3/...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    hunyuan: {
      id: 'hunyuan',
      label: '騰訊混元',
      group: '中國大陸服務',
      protocol: 'openai',
      baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: 'sk-...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    minimax: {
      id: 'minimax',
      label: 'MiniMax（中國站）',
      group: '中國大陸服務',
      protocol: 'openai',
      baseUrl: 'https://api.minimaxi.com/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    stepfun: {
      id: 'stepfun',
      label: '階躍星辰 StepFun',
      group: '中國大陸服務',
      protocol: 'openai',
      baseUrl: 'https://api.stepfun.com/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '...',
      hint: '填入金鑰後按「取得模型清單」。'
    },
    ollama: {
      id: 'ollama',
      label: 'Ollama（本機）',
      group: '本機 / 自訂',
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '可留空',
      hint: '本機模型不需金鑰；啟動 Ollama 後按「取得模型清單」。'
    },
    lmstudio: {
      id: 'lmstudio',
      label: 'LM Studio（本機）',
      group: '本機 / 自訂',
      protocol: 'openai',
      baseUrl: 'http://localhost:1234/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '可留空',
      hint: '本機模型不需金鑰；在 LM Studio 開啟本機伺服器後按「取得模型清單」。'
    },
    custom: {
      id: 'custom',
      label: '自訂 OpenAI 相容介面',
      group: '本機 / 自訂',
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: '',
      suggestedModels: [],
      placeholderKey: '可留空或填金鑰',
      hint: '支援任何 OpenAI 相容中轉站或自架端點；填好網址後按「取得模型清單」。'
    }
  };

  const LATIN_FONTS = {
    serifFontStack: 'Georgia, "Noto Serif", "Times New Roman", serif',
    sansFontStack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif',
    monoFontStack: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
  };

  const TARGET_LANGUAGES = {
    'zh-TW': {
      id: 'zh-TW',
      label: '繁體中文（台灣）',
      shortLabel: '繁中',
      promptName: 'Traditional Chinese (Taiwanese Mandarin phrasing and terminology)',
      fontClass: 'kct-lang-tc',
      testSampleHint: '繁體中文（台灣用語）',
      serifFontStack: '"Songti TC", "Noto Serif TC", "PMingLiU", serif',
      sansFontStack: '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif',
      monoFontStack: '"PingFang TC", "Noto Sans TC", monospace'
    },
    'zh-CN': {
      id: 'zh-CN',
      label: '简体中文',
      shortLabel: '简中',
      promptName: 'Simplified Chinese (Mainland China phrasing)',
      fontClass: 'kct-lang-sc',
      testSampleHint: '简体中文',
      serifFontStack: '"Songti SC", "Noto Serif SC", "SimSun", serif',
      sansFontStack: '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
      monoFontStack: '"PingFang SC", "Noto Sans SC", monospace'
    },
    ja: {
      id: 'ja',
      label: '日本語',
      shortLabel: '日本語',
      promptName: 'Japanese (natural technical Japanese)',
      fontClass: 'kct-lang-ja',
      testSampleHint: '日本語',
      serifFontStack: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
      sansFontStack: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif',
      monoFontStack: '"Hiragino Sans", "Noto Sans JP", monospace'
    },
    ko: {
      id: 'ko',
      label: '한국어',
      shortLabel: '한국어',
      promptName: 'Korean (natural technical Korean)',
      fontClass: 'kct-lang-ko',
      testSampleHint: '한국어',
      serifFontStack: '"AppleMyungjo", "Batang", "Noto Serif KR", serif',
      sansFontStack: '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif',
      monoFontStack: '"Apple SD Gothic Neo", "Noto Sans KR", monospace'
    },
    es: {
      id: 'es',
      label: 'Español',
      shortLabel: 'ES',
      promptName: 'Spanish (neutral technical Spanish)',
      fontClass: 'kct-lang-latin',
      testSampleHint: 'Español',
      ...LATIN_FONTS
    },
    fr: {
      id: 'fr',
      label: 'Français',
      shortLabel: 'FR',
      promptName: 'French (natural technical French)',
      fontClass: 'kct-lang-latin',
      testSampleHint: 'Français',
      ...LATIN_FONTS
    },
    de: {
      id: 'de',
      label: 'Deutsch',
      shortLabel: 'DE',
      promptName: 'German (natural technical German)',
      fontClass: 'kct-lang-latin',
      testSampleHint: 'Deutsch',
      ...LATIN_FONTS
    },
    vi: {
      id: 'vi',
      label: 'Tiếng Việt',
      shortLabel: 'VI',
      promptName: 'Vietnamese (natural technical Vietnamese)',
      fontClass: 'kct-lang-latin',
      testSampleHint: 'Tiếng Việt',
      ...LATIN_FONTS
    },
    pt: {
      id: 'pt',
      label: 'Português',
      shortLabel: 'PT',
      promptName: 'Portuguese (natural technical Portuguese)',
      fontClass: 'kct-lang-latin',
      testSampleHint: 'Português',
      ...LATIN_FONTS
    },
    custom: {
      id: 'custom',
      label: '自訂語言...',
      shortLabel: '自訂',
      promptName: '',
      fontClass: 'kct-lang-latin',
      testSampleHint: 'Custom',
      ...LATIN_FONTS
    }
  };

  const DEFAULT_GLOSSARY = [
    'overfitting -> 過度擬合',
    'underfitting -> 擬合不足',
    'cross-validation -> 交叉驗證',
    'validation set -> 驗證集',
    'validation data -> 驗證資料',
    'training set -> 訓練集',
    'training data -> 訓練資料',
    'test set -> 測試集',
    'feature engineering -> 特徵工程',
    'gradient boosting -> 梯度提升',
    'random forest -> 隨機森林',
    'decision tree -> 決策樹',
    'mean absolute error (MAE) -> 平均絕對誤差 (MAE)',
    'RMSE -> 均方根誤差 (RMSE)',
    'target leakage -> 目標洩漏',
    'data leakage -> 資料洩漏',
    'pipeline -> 管線 (Pipeline)',
    'function -> 函式',
    'hyperparameter -> 超參數'
  ].join('\n');

  const CURRENT_SCHEMA_VERSION = 6;

  const DEFAULT_SETTINGS = {
    settingsSchemaVersion: CURRENT_SCHEMA_VERSION,
    enabled: true,
    autoTranslate: false,
    autoTranslateHosts: [],
    targetLang: 'zh-TW',
    customTargetLang: '',
    displayMode: 'replace', // 'replace' | 'original' | 'bilingual'
    scope: 'course', // 'course' | 'all'
    translateCodeComments: true,
    selectionTranslate: true,
    showFloatingBall: true,
    showOutputTranslateBtn: true,
    checkForUpdates: true,
    lazyViewport: true,
    streamTranslation: true,
    thinkingEffort: 'fastest', // 'fastest' | 'balanced' | 'deep'
    typographyMatch: 'native', // 'native' | 'system' | 'preserve'
    providerId: 'gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    model: 'gemini-3.5-flash-lite',
    providerProfiles: {},
    fallbackProviderId: '',
    temperature: 0.2,
    batchSize: 20,
    maxBatchChars: 5500,
    customGlossary: DEFAULT_GLOSSARY
  };

  const SETTINGS_KEY = 'kct_settings_v1';
  const CACHE_KEY = 'kct_translation_cache_v1';

  function resolveTargetLanguage(settings) {
    const id = settings?.targetLang || 'zh-TW';
    if (id === 'custom') {
      const customName = String(settings?.customTargetLang || '').trim();
      return {
        id: 'custom',
        label: customName || '自訂語言',
        shortLabel: customName ? customName.slice(0, 4) : '自訂',
        promptName: customName || 'Traditional Chinese (Taiwan)',
        fontClass: 'kct-lang-latin',
        isCustom: true,
        ...LATIN_FONTS
      };
    }
    return TARGET_LANGUAGES[id] || TARGET_LANGUAGES['zh-TW'];
  }

  function normalizeOpenAIEndpoint(baseUrl) {
    const raw = String(baseUrl || '').trim();
    if (!raw) return '';
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(pathname)) {
      parsed.pathname = pathname;
      return parsed.toString();
    }
    if (/\/(v\d+|openai|compatible-mode\/v1|api\/paas\/v\d+|openai\/deployments\/[^/]+)$/i.test(pathname) || (isAzureOpenAIEndpoint(raw) && pathname && pathname !== '/')) {
      parsed.pathname = `${pathname}/chat/completions`;
    } else {
      parsed.pathname = `${pathname}/v1/chat/completions`;
    }
    return parsed.toString();
  }

  function normalizeGeminiEndpoint(baseUrl, model) {
    const raw = String(baseUrl || '').trim() || 'https://generativelanguage.googleapis.com/v1beta';
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (/:(?:stream)?generateContent$/i.test(pathname)) {
      parsed.pathname = pathname;
      return parsed.toString();
    }
    const m = String(model ?? '').trim().replace(/^models\//i, '');
    if (!m) return '';
    if (/\/v1(?:alpha|beta)?\/models$/i.test(pathname)) {
      parsed.pathname = `${pathname}/${encodeURIComponent(m)}:generateContent`;
    } else if (/\/v1(?:alpha|beta)?$/i.test(pathname)) {
      parsed.pathname = `${pathname}/models/${encodeURIComponent(m)}:generateContent`;
    } else {
      parsed.pathname = `${pathname}/v1beta/models/${encodeURIComponent(m)}:generateContent`;
    }
    return parsed.toString();
  }

  function isAzureOpenAIEndpoint(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return false;
    try {
      const { hostname } = new URL(baseUrl.trim());
      const host = hostname.toLowerCase();
      return (
        host.endsWith('.openai.azure.com') ||
        host.endsWith('.services.ai.azure.com') ||
        host.endsWith('.cognitiveservices.azure.com')
      );
    } catch (_) {
      return false;
    }
  }

  function normalizeAnthropicEndpoint(baseUrl) {
    const raw = String(baseUrl || '').trim();
    if (!raw) return 'https://api.anthropic.com/v1/messages';
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (/\/v1\/messages$/i.test(pathname)) {
      parsed.pathname = pathname;
    } else if (/\/v1$/i.test(pathname)) {
      parsed.pathname = `${pathname}/messages`;
    } else {
      parsed.pathname = `${pathname}/v1/messages`;
    }
    return parsed.toString();
  }

  function buildProviderAuthHeaders(settings, cleanKey) {
    const headers = { 'Content-Type': 'application/json' };
    const protocol = settings?.protocol || 'openai';
    const check = validateApiKey(cleanKey);
    if (!check.ok) {
      const err = new Error(check.error);
      err.errorCode = 'INVALID_API_KEY_CHARS';
      err.noRetry = true;
      err.noSplit = true;
      throw err;
    }
    const key = check.cleanKey;

    if (protocol === 'gemini') {
      if (key) headers['x-goog-api-key'] = key;
      return headers;
    }

    if (protocol === 'anthropic') {
      if (key) headers['x-api-key'] = key;
      headers['anthropic-version'] = '2026-10-21';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      return headers;
    }

    if (key) {
      if (isAzureOpenAIEndpoint(settings?.baseUrl)) {
        headers['api-key'] = key;
      } else {
        headers['Authorization'] = `Bearer ${key}`;
      }
    }
    return headers;
  }

  function resolveAnthropicEffort(model, thinkingEffort) {
    const m = String(model || '').trim();
    const supportsEffort =
      /^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:5|[6-9])(?:[-.]|$)/.test(m) ||
      /^claude-(?:opus-4-[5-9]|sonnet-4-6|opus-4-6)(?:[-.]|$)/.test(m);
    if (!supportsEffort) return '';

    const map = {
      fastest: 'low',
      balanced: 'medium',
      deep: 'high'
    };
    return map[thinkingEffort] || '';
  }

  function buildAnthropicMessagesBody(
    settings,
    messages,
    { stream = false, maxTokens = 16000, image = null } = {}
  ) {
    const systemParts = [];
    const convMessages = [];

    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.role;
        const text = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
        if (!text.trim()) continue;

        if (role === 'system') {
          systemParts.push(text);
        } else if (role === 'user' || role === 'assistant') {
          convMessages.push({ role, content: text });
        }
      }
    }

    if (image && image.base64 && image.mimeType) {
      let lastUserIdx = -1;
      for (let i = convMessages.length - 1; i >= 0; i--) {
        if (convMessages[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx !== -1) {
        const cleanBase64 = String(image.base64).replace(/^data:[^;]+;base64,/, '');
        const textContent = convMessages[lastUserIdx].content;
        convMessages[lastUserIdx] = {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: String(image.mimeType).trim(),
                data: cleanBase64
              }
            },
            {
              type: 'text',
              text: textContent
            }
          ]
        };
      }
    }

    const model = String(settings?.model || '').trim();
    const body = {
      model,
      max_tokens: Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : 16000,
      messages: convMessages
    };

    if (systemParts.length > 0) {
      body.system = systemParts.join('\n\n');
    }

    if (stream) {
      body.stream = true;
    }

    const effort = resolveAnthropicEffort(model, settings?.thinkingEffort);
    if (effort) {
      body.output_config = { effort };
    }

    return body;
  }

  function extractAnthropicText(data) {
    if (!data || typeof data !== 'object') return '';

    if (data.type === 'error') {
      const msg = data.error?.message || data.error?.type || 'Anthropic API Error';
      throw new Error(msg);
    }

    const stopReason = data.stop_reason;
    if (stopReason === 'refusal') {
      const category = data.stop_details?.category || 'refusal';
      const err = new Error(`Claude 拒絕了此請求（${category}）`);
      err.noRetry = true;
      err.noSplit = true;
      throw err;
    }

    let text = '';
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        }
      }
    }

    if (stopReason === 'max_tokens' && !text) {
      const err = new Error('Claude 輸出被截斷（max_tokens）');
      err.noSplit = false;
      throw err;
    }

    return text;
  }

  function extractAnthropicStreamDelta(eventObj) {
    const result = { text: '', error: '', stopReason: '' };
    if (!eventObj || typeof eventObj !== 'object') return result;

    try {
      if (
        eventObj.type === 'content_block_delta' &&
        eventObj.delta?.type === 'text_delta' &&
        typeof eventObj.delta.text === 'string'
      ) {
        result.text = eventObj.delta.text;
      } else if (eventObj.type === 'error') {
        result.error = String(
          eventObj.error?.message || eventObj.error?.type || 'Anthropic Stream Error'
        );
      } else if (eventObj.type === 'message_delta') {
        if (typeof eventObj.delta?.stop_reason === 'string') {
          result.stopReason = eventObj.delta.stop_reason;
        }
      }
    } catch (_) {
      // Never throw
    }

    return result;
  }

  function buildListModelsUrl(settings, pageToken = '') {
    const protocol = String(settings?.protocol || 'openai').trim().toLowerCase();
    const rawBase = String(settings?.baseUrl || '').trim();

    if (isAzureOpenAIEndpoint(rawBase)) {
      return '';
    }

    try {
      if (protocol === 'gemini') {
        const parsed = new URL(rawBase || 'https://generativelanguage.googleapis.com/v1beta');
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
        let pathname = parsed.pathname
          .replace(/\/+$/, '')
          .replace(/\/models\/[^/?#]+$/i, '')
          .replace(/\/models$/i, '')
          .replace(/\/+$/, '');
        if (!/\/v1(?:alpha|beta)?$/i.test(pathname)) {
          pathname = `${pathname}/v1beta`;
        }
        parsed.pathname = `${pathname}/models`;
        parsed.searchParams.set('pageSize', '1000');
        if (pageToken) {
          parsed.searchParams.set('pageToken', String(pageToken));
        }
        return parsed.toString();
      }

      if (protocol === 'anthropic') {
        const parsed = new URL(rawBase || 'https://api.anthropic.com/v1');
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
        const pathname = parsed.pathname
          .replace(/\/+$/, '')
          .replace(/\/messages$/i, '')
          .replace(/\/models$/i, '')
          .replace(/\/+$/, '');
        parsed.pathname = /\/v1$/i.test(pathname) ? `${pathname}/models` : `${pathname}/v1/models`;
        parsed.searchParams.set('limit', '1000');
        if (pageToken) {
          parsed.searchParams.set('after_id', String(pageToken));
        }
        return parsed.toString();
      }

      if (protocol === 'openai') {
        if (!rawBase) return '';
        const parsed = new URL(rawBase);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
        const pathname = parsed.pathname
          .replace(/\/+$/, '')
          .replace(/\/chat\/completions$/i, '')
          .replace(/\/models$/i, '')
          .replace(/\/+$/, '');
        parsed.pathname = /\/(v\d+|openai|compatible-mode\/v1|api\/paas\/v\d+|openai\/deployments\/[^/]+)$/i.test(pathname) || (isAzureOpenAIEndpoint(rawBase) && pathname && pathname !== '/')
          ? `${pathname}/models`
          : `${pathname}/v1/models`;
        return parsed.toString();
      }
    } catch {
      return '';
    }

    return '';
  }

  function parseListModelsResponse(protocol, data) {
    const proto = String(protocol || 'openai').trim().toLowerCase();
    const ids = [];
    let nextPageToken = '';

    if (!data || typeof data !== 'object') {
      return { ids, nextPageToken };
    }

    if (proto === 'gemini') {
      const list = Array.isArray(data.models) ? data.models : [];
      for (const item of list) {
        const methods = Array.isArray(item?.supportedGenerationMethods)
          ? item.supportedGenerationMethods
          : [];
        if (!methods.includes('generateContent')) continue;
        const id = String(item?.name || '').replace(/^models\//, '').trim();
        if (id) ids.push(id);
      }
      if (typeof data.nextPageToken === 'string' && data.nextPageToken.trim()) {
        nextPageToken = data.nextPageToken.trim();
      }
      return { ids, nextPageToken };
    }

    if (proto === 'anthropic') {
      const list = Array.isArray(data.data) ? data.data : [];
      for (const item of list) {
        const id = String(item?.id || '').trim();
        if (id) ids.push(id);
      }
      if (data.has_more === true && typeof data.last_id === 'string' && data.last_id.trim()) {
        nextPageToken = data.last_id.trim();
      }
      return { ids, nextPageToken };
    }

    const list = Array.isArray(data)
      ? data
      : Array.isArray(data.data)
        ? data.data
        : Array.isArray(data.models)
          ? data.models
          : [];
    for (const item of list) {
      if (typeof item === 'string') {
        const id = item.trim();
        if (id) ids.push(id);
      } else if (item && typeof item === 'object') {
        const rawId = typeof item.id === 'string' && item.id.trim() ? item.id : item.name;
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (id) ids.push(id);
      }
    }
    return { ids, nextPageToken: '' };
  }

  function resolveEndpoint(settings) {
    if (settings?.protocol === 'gemini') {
      return normalizeGeminiEndpoint(settings.baseUrl, settings.model);
    }
    if (settings?.protocol === 'anthropic') {
      return normalizeAnthropicEndpoint(settings.baseUrl);
    }
    return normalizeOpenAIEndpoint(settings?.baseUrl);
  }

  function resolveStreamEndpoint(settings) {
    if (settings?.protocol === 'anthropic') {
      return normalizeAnthropicEndpoint(settings.baseUrl);
    }
    const endpoint = resolveEndpoint(settings);
    if (!endpoint) return '';
    if (settings?.protocol === 'gemini') {
      const streamUrl = endpoint.includes(':streamGenerateContent')
        ? endpoint
        : endpoint.replace(':generateContent', ':streamGenerateContent');
      try {
        const parsed = new URL(streamUrl);
        parsed.searchParams.set('alt', 'sse');
        return parsed.toString();
      } catch (_) {
        return streamUrl.includes('?') ? `${streamUrl}&alt=sse` : `${streamUrl}?alt=sse`;
      }
    }
    return endpoint;
  }

  function resolveThinkingConfig(model, effort = 'fastest') {
    const norm = String(model || '').replace(/^models\//i, '').trim().toLowerCase();
    if (!norm) return null;
    const mode = effort === 'balanced' || effort === 'deep' ? effort : 'fastest';

    if (/^gemini-(?:3\.5-flash-lite|3\.6-flash|3-flash|3\.1-flash-lite)/.test(norm)) {
      if (mode === 'fastest') return { thinkingLevel: 'MINIMAL' };
      if (mode === 'balanced') return { thinkingLevel: 'LOW' };
      return { thinkingLevel: 'MEDIUM' };
    }
    if (/^gemini-(?:3\.8-flash|4-|3\.1-pro|3-pro)/.test(norm)) {
      if (mode === 'deep') return { thinkingLevel: 'MEDIUM' };
      return { thinkingLevel: 'LOW' };
    }
    if (/^gemini-2\.5-flash(?:-lite)?(?:$|[-.])/.test(norm)) {
      if (mode === 'fastest') return { thinkingBudget: 0 };
      if (mode === 'balanced') return { thinkingBudget: 512 };
      return { thinkingBudget: 2048 };
    }
    return null;
  }

  function normalizeHostname(host) {
    return String(host || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  }

  function isHostWhitelisted(hostname, settings) {
    const norm = normalizeHostname(hostname);
    if (!norm) return false;
    const hosts = Array.isArray(settings?.autoTranslateHosts) ? settings.autoTranslateHosts : [];
    return hosts.some((entry) => {
      const rule = normalizeHostname(entry);
      if (!rule) return false;
      return norm === rule || norm.endsWith(`.${rule}`);
    });
  }

  async function toggleHostWhitelist(hostname) {
    const norm = normalizeHostname(hostname);
    const current = await getSettings();
    if (!norm) {
      return { whitelisted: false, settings: current };
    }
    const existing = Array.isArray(current.autoTranslateHosts)
      ? current.autoTranslateHosts.map(normalizeHostname).filter(Boolean)
      : [];
    const matched = existing.some((rule) => norm === rule || norm.endsWith(`.${rule}`));
    let nextHosts;
    let whitelisted;
    if (matched) {
      nextHosts = existing.filter((rule) => !(norm === rule || norm.endsWith(`.${rule}`)));
      whitelisted = false;
    } else {
      nextHosts = Array.from(new Set([...existing, norm]));
      whitelisted = true;
    }
    const settings = await saveSettings({ autoTranslateHosts: nextHosts });
    return { whitelisted, settings };
  }

  function isInjectableUrl(url) {
    if (!url || typeof url !== 'string') return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    const pathname = (parsed.pathname || '').toLowerCase();
    if (host === 'chromewebstore.google.com') return false;
    if (host === 'addons.mozilla.org') return false;
    if (host === 'chrome.google.com' && pathname.startsWith('/webstore')) return false;
    if (host === 'microsoftedge.microsoft.com' && pathname.startsWith('/addons')) return false;
    return true;
  }

  function isLocalEndpoint(baseUrl) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(String(baseUrl || '').trim());
  }

  const EXTENSIONLESS_PDF_HOSTS = new Set([
    'arxiv.org',
    'export.arxiv.org',
    'openreview.net',
    'aclanthology.org',
    'proceedings.mlr.press'
  ]);

  function isFileUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      return new URL(url).protocol === 'file:';
    } catch (_) {
      return false;
    }
  }

  function isFilePdfUrl(url) {
    if (!url || typeof url !== 'string') return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return false;
    }
    if (parsed.protocol !== 'file:') return false;
    const pathname = parsed.pathname || '';
    if (/\.html?$/i.test(pathname)) return false;
    return /\.pdf$/i.test(pathname);
  }

  function isRemotePdfUrl(url) {
    if (!url || typeof url !== 'string') return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname || '';
    // Never hijack HTML viewer pages wrapping a .pdf filename (e.g. GitHub /blob/..., Wikipedia File:...)
    if (/\/blob\//i.test(pathname) || /\/wiki\/File:/i.test(pathname) || /\.html?$/i.test(pathname)) {
      return false;
    }
    if (/\.pdf$/i.test(pathname)) return true;
    if (EXTENSIONLESS_PDF_HOSTS.has(host) && /^\/pdf\/[^/]+/i.test(pathname)) return true;
    if (host === 'openreview.net' && /^\/pdf\/?$/i.test(pathname) && parsed.searchParams.has('id')) return true;
    for (const [k, v] of parsed.searchParams.entries()) {
      if (k.toLowerCase() === 'format' && v.toLowerCase() === 'pdf') return true;
    }
    return false;
  }

  function isPdfUrl(url, { includeFile = true } = {}) {
    return isRemotePdfUrl(url) || (includeFile && isFilePdfUrl(url));
  }

  function extractGoogleDriveFileId(url) {
    if (!url || typeof url !== 'string') return '';
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return '';
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'drive.google.com' && host !== 'docs.google.com') return '';
    const m = (parsed.pathname || '').match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
    const qId = parsed.searchParams.get('id');
    if (qId && /^[a-zA-Z0-9_-]{10,}$/.test(qId)) return qId;
    return '';
  }

  function resolvePdfSourceUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const gdriveId = extractGoogleDriveFileId(url);
    if (gdriveId) {
      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(gdriveId)}`;
    }
    if (isPdfUrl(url)) return url;
    return '';
  }

  async function getSettings() {
    if (!chrome?.runtime?.id) {
      return { ...DEFAULT_SETTINGS, autoTranslateHosts: [], providerProfiles: {} };
    }
    let data;
    try {
      data = await chrome.storage.local.get(SETTINGS_KEY);
    } catch (_) {
      return { ...DEFAULT_SETTINGS, autoTranslateHosts: [], providerProfiles: {} };
    }
    const raw = data[SETTINGS_KEY];
    if (!raw) {
      return { ...DEFAULT_SETTINGS, autoTranslateHosts: [], providerProfiles: {} };
    }
    const ver = raw.settingsSchemaVersion || 1;
    if (ver < CURRENT_SCHEMA_VERSION) {
      let migrated = { ...DEFAULT_SETTINGS, ...raw };
      if (ver < 2) {
        migrated = {
          ...migrated,
          targetLang: raw.targetLang || 'zh-TW',
          displayMode: raw.displayMode === 'bilingual' ? 'replace' : (raw.displayMode || 'replace'),
          translateCodeComments: raw.translateCodeComments ?? true,
          customGlossary: (!raw.customGlossary || raw.customGlossary.includes('过拟合'))
            ? DEFAULT_GLOSSARY
            : raw.customGlossary
        };
      }
      if (ver < 5) {
        migrated.autoTranslate = false;
      } else {
        migrated.autoTranslate = Boolean(raw.autoTranslate);
      }
      migrated.autoTranslateHosts = Array.isArray(raw.autoTranslateHosts)
        ? raw.autoTranslateHosts.map(normalizeHostname).filter(Boolean)
        : [];
      migrated.lazyViewport = raw.lazyViewport ?? true;
      migrated.streamTranslation = raw.streamTranslation ?? true;
      migrated.thinkingEffort = raw.thinkingEffort || 'fastest';
      migrated.typographyMatch = raw.typographyMatch || 'native';
      if (ver < 4) {
        migrated.batchSize = (!raw.batchSize || raw.batchSize === 8 || raw.batchSize === 16 || raw.batchSize === 24)
          ? 20
          : raw.batchSize;
        migrated.maxBatchChars = (!raw.maxBatchChars || raw.maxBatchChars === 1800 || raw.maxBatchChars === 4500 || raw.maxBatchChars === 6500)
          ? 5500
          : raw.maxBatchChars;
      }
      migrated.apiKey = sanitizeApiKey(migrated.apiKey);
      migrated.providerProfiles = normalizeProviderProfiles(raw.providerProfiles, migrated);
      const rawFb = String(raw.fallbackProviderId || '').trim();
      migrated.fallbackProviderId = rawFb === migrated.providerId ? '' : rawFb;
      migrated.settingsSchemaVersion = CURRENT_SCHEMA_VERSION;
      try {
        await chrome.storage.local.set({ [SETTINGS_KEY]: migrated });
      } catch (_) {
        // Ignore persistence error during read-time migration
      }
      return migrated;
    }
    const normalized = {
      ...DEFAULT_SETTINGS,
      ...raw,
      apiKey: sanitizeApiKey(raw.apiKey),
      autoTranslateHosts: Array.isArray(raw.autoTranslateHosts)
        ? raw.autoTranslateHosts.map(normalizeHostname).filter(Boolean)
        : [],
      fallbackProviderId: String(raw.fallbackProviderId || '').trim()
    };
    if (normalized.fallbackProviderId === normalized.providerId) {
      normalized.fallbackProviderId = '';
    }
    normalized.providerProfiles = normalizeProviderProfiles(raw.providerProfiles, normalized);
    return normalized;
  }

  let settingsSaveChain = Promise.resolve();

  function saveSettings(partial) {
    const run = settingsSaveChain.then(async () => {
      const current = await getSettings();
      const hasExplicitProfiles =
        Boolean(partial) &&
        typeof partial.providerProfiles === 'object' &&
        partial.providerProfiles !== null &&
        !Array.isArray(partial.providerProfiles);
      const baseProfiles = hasExplicitProfiles ? partial.providerProfiles : current.providerProfiles;
      const next = {
        ...current,
        ...(partial && typeof partial === 'object' ? partial : {}),
        providerProfiles: baseProfiles,
        settingsSchemaVersion: CURRENT_SCHEMA_VERSION
      };
      next.apiKey = sanitizeApiKey(next.apiKey);
      if (Array.isArray(next.autoTranslateHosts)) {
        next.autoTranslateHosts = Array.from(
          new Set(next.autoTranslateHosts.map(normalizeHostname).filter(Boolean))
        );
      } else {
        next.autoTranslateHosts = [];
      }
      next.fallbackProviderId = String(next.fallbackProviderId || '').trim();
      if (next.fallbackProviderId === next.providerId) {
        next.fallbackProviderId = '';
      }
      next.providerProfiles = normalizeProviderProfiles(next.providerProfiles, next);
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      return next;
    });
    settingsSaveChain = run.catch(() => {});
    return run;
  }

  function hashText(str) {
    // FNV-1a 64-bit split into two 32-bit hashes for very low collision
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= (c + i) & 0xffff;
      h2 = Math.imul(h2, 0x01000193);
    }
    return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}_${str.length}`;
  }

  function sanitizeApiKey(rawKey) {
    return String(rawKey || '')
      .replace(/[\u200B-\u200D\uFEFF\r\n\t]+/g, '')
      .trim()
      .replace(/^Bearer\s+/i, '')
      .trim();
  }

  function validateApiKey(rawKey) {
    const cleanKey = sanitizeApiKey(rawKey);
    if (!cleanKey) return { ok: true, cleanKey: '', error: '' };
    if (!/^[\x21-\x7E]+$/.test(cleanKey)) {
      return {
        ok: false,
        cleanKey,
        error: 'API Key 格式錯誤：包含空白、不可見字元或非 ASCII 字元，請重新複製純金鑰。'
      };
    }
    return { ok: true, cleanKey, error: '' };
  }

  function normalizeProviderProfiles(rawProfiles, activeSettings = null) {
    const out = {};
    if (rawProfiles && typeof rawProfiles === 'object' && !Array.isArray(rawProfiles)) {
      for (const [id, entry] of Object.entries(rawProfiles)) {
        const pid = String(id || '').trim();
        if (!pid || !entry || typeof entry !== 'object') continue;
        const preset = PROVIDER_PRESETS[pid] || null;
        const cleanEntry = {
          protocol: String(entry.protocol || preset?.protocol || 'openai').trim(),
          baseUrl: String(entry.baseUrl ?? preset?.baseUrl ?? '').trim(),
          apiKey: sanitizeApiKey(entry.apiKey),
          model: String(entry.model ?? preset?.defaultModel ?? '').trim(),
          thinkingEffort: String(entry.thinkingEffort || 'fastest').trim()
        };
        if (isProfileSaved(pid, cleanEntry)) {
          out[pid] = cleanEntry;
        }
      }
    }
    const activeId = String(activeSettings?.providerId || '').trim();
    if (activeId) {
      const preset = PROVIDER_PRESETS[activeId] || null;
      const cleanKey = sanitizeApiKey(activeSettings.apiKey);
      const activeUrl = String(activeSettings.baseUrl ?? preset?.baseUrl ?? '').trim();
      const activeModel = String(activeSettings.model ?? preset?.defaultModel ?? out[activeId]?.model ?? '').trim();
      const candidate = {
        protocol: String(activeSettings.protocol || preset?.protocol || out[activeId]?.protocol || 'openai').trim(),
        baseUrl: activeUrl,
        apiKey: cleanKey,
        model: activeModel,
        thinkingEffort: String(activeSettings.thinkingEffort || out[activeId]?.thinkingEffort || 'fastest').trim()
      };
      if (isProfileSaved(activeId, candidate) || Object.prototype.hasOwnProperty.call(out, activeId)) {
        out[activeId] = candidate;
      }
    }
    return out;
  }

  function isProfileSaved(providerId, profile) {
    if (!profile || typeof profile !== 'object') return false;
    if (sanitizeApiKey(profile.apiKey)) return true;
    const rawUrl = profile.baseUrl !== undefined ? profile.baseUrl : (PROVIDER_PRESETS[providerId]?.baseUrl || '');
    const url = String(rawUrl || '').trim();
    const model = String(profile.model || '').trim();
    if (isLocalEndpoint(url) && model) return true;
    if (providerId === 'custom' && url && model) return true;
    return false;
  }

  function isProfileReady(providerId, profile) {
    if (!isProfileSaved(providerId, profile)) return false;
    const rawUrl = profile.baseUrl !== undefined ? profile.baseUrl : (PROVIDER_PRESETS[providerId]?.baseUrl || '');
    const url = String(rawUrl || '').trim();
    const model = String(profile?.model || PROVIDER_PRESETS[providerId]?.defaultModel || '').trim();
    const hasKey = Boolean(sanitizeApiKey(profile?.apiKey));
    return Boolean(model) && (hasKey || isLocalEndpoint(url));
  }

  function listSavedProviders(settings) {
    const profiles = normalizeProviderProfiles(settings?.providerProfiles, settings);
    const activeId = String(settings?.providerId || '').trim();
    const fallbackId = String(settings?.fallbackProviderId || '').trim();
    const seen = new Set();
    const orderedIds = [];
    if (activeId) {
      orderedIds.push(activeId);
      seen.add(activeId);
    }
    for (const presetId of Object.keys(PROVIDER_PRESETS)) {
      if (!seen.has(presetId) && profiles[presetId] && isProfileSaved(presetId, profiles[presetId])) {
        orderedIds.push(presetId);
        seen.add(presetId);
      }
    }
    for (const pid of Object.keys(profiles)) {
      if (!seen.has(pid) && isProfileSaved(pid, profiles[pid])) {
        orderedIds.push(pid);
        seen.add(pid);
      }
    }
    return orderedIds.map((pid) => {
      const preset = PROVIDER_PRESETS[pid] || null;
      const prof = (pid === activeId)
        ? {
            protocol: settings?.protocol || preset?.protocol || 'openai',
            baseUrl: settings?.baseUrl ?? preset?.baseUrl ?? '',
            apiKey: sanitizeApiKey(settings?.apiKey),
            model: settings?.model ?? preset?.defaultModel ?? '',
            thinkingEffort: settings?.thinkingEffort || 'fastest'
          }
        : (profiles[pid] || {});
      const rawUrl = prof.baseUrl !== undefined ? prof.baseUrl : (preset?.baseUrl || '');
      const url = String(rawUrl || '').trim();
      const hasKey = Boolean(sanitizeApiKey(prof.apiKey));
      const local = isLocalEndpoint(url);
      const model = String(prof.model || '').trim();
      const isReady = isProfileReady(pid, { ...prof, baseUrl: url, model });
      return {
        providerId: pid,
        label: preset?.label || pid,
        model,
        protocol: prof.protocol || preset?.protocol || 'openai',
        baseUrl: url,
        hasKey,
        isLocal: local,
        isReady,
        isActive: pid === activeId,
        isFallback: Boolean(fallbackId && pid === fallbackId && pid !== activeId)
      };
    });
  }

  function switchActiveProviderSettings(settings, targetProviderId) {
    const cur = settings && typeof settings === 'object' ? settings : { ...DEFAULT_SETTINGS };
    const targetId = String(targetProviderId || '').trim();
    if (!targetId) return { ...cur };
    const targetPreset = PROVIDER_PRESETS[targetId] || null;
    const nextProfiles = normalizeProviderProfiles(cur.providerProfiles, null);
    const curId = String(cur.providerId || '').trim();
    if (curId) {
      const curPreset = PROVIDER_PRESETS[curId] || null;
      const curKey = sanitizeApiKey(cur.apiKey);
      const curUrl = String(cur.baseUrl ?? curPreset?.baseUrl ?? '').trim();
      const curModel = String(cur.model || '').trim();
      const isNonDefaultModel = Boolean(curModel && curModel !== (curPreset?.defaultModel || ''));
      if (curKey || (isLocalEndpoint(curUrl) && curModel) || isNonDefaultModel || Object.prototype.hasOwnProperty.call(nextProfiles, curId)) {
        nextProfiles[curId] = {
          protocol: String(cur.protocol || curPreset?.protocol || 'openai').trim(),
          baseUrl: curUrl,
          apiKey: curKey,
          model: curModel,
          thinkingEffort: String(cur.thinkingEffort || 'fastest').trim()
        };
      }
    }
    const savedTarget = nextProfiles[targetId] || null;
    return {
      ...cur,
      providerId: targetId,
      protocol: savedTarget?.protocol || targetPreset?.protocol || cur.protocol || 'openai',
      baseUrl: savedTarget?.baseUrl || targetPreset?.baseUrl || '',
      apiKey: savedTarget ? sanitizeApiKey(savedTarget.apiKey) : '',
      model: savedTarget?.model || targetPreset?.defaultModel || '',
      thinkingEffort: savedTarget?.thinkingEffort || cur.thinkingEffort || 'fastest',
      providerProfiles: nextProfiles,
      fallbackProviderId: cur.fallbackProviderId === targetId ? '' : String(cur.fallbackProviderId || '')
    };
  }

  function removeProviderProfile(settings, providerId) {
    const cur = settings && typeof settings === 'object' ? settings : { ...DEFAULT_SETTINGS };
    const targetId = String(providerId || '').trim();
    const curId = String(cur.providerId || '').trim();
    const nextProfiles = normalizeProviderProfiles(cur.providerProfiles, cur);
    if (!targetId || targetId === curId) {
      return {
        ...cur,
        providerProfiles: nextProfiles
      };
    }
    delete nextProfiles[targetId];
    return {
      ...cur,
      providerProfiles: nextProfiles,
      fallbackProviderId: cur.fallbackProviderId === targetId ? '' : String(cur.fallbackProviderId || '')
    };
  }

  function resolveFallbackSettings(settings) {
    const fbId = String(settings?.fallbackProviderId || '').trim();
    const curId = String(settings?.providerId || '').trim();
    if (!fbId || fbId === curId) return null;
    const prof = settings?.providerProfiles?.[fbId];
    if (!isProfileReady(fbId, prof)) return null;
    const preset = PROVIDER_PRESETS[fbId] || null;
    return {
      ...settings,
      providerId: fbId,
      protocol: String(prof.protocol || preset?.protocol || 'openai').trim(),
      baseUrl: String(prof.baseUrl || preset?.baseUrl || '').trim(),
      apiKey: sanitizeApiKey(prof.apiKey),
      model: String(prof.model || preset?.defaultModel || '').trim(),
      thinkingEffort: String(prof.thinkingEffort || settings?.thinkingEffort || 'fastest').trim(),
      fallbackProviderId: ''
    };
  }

  function formatApiError(errOrMsg, httpStatus = 0, errorCode = '') {
    const rawMsg = (
      typeof errOrMsg === 'string'
        ? errOrMsg
        : (errOrMsg?.message || String(errOrMsg || ''))
    ).replace(/\s+/g, ' ').trim();
    let status = Number(httpStatus || (typeof errOrMsg === 'object' && errOrMsg?.httpStatus) || 0);
    if (!status && rawMsg) {
      const m = rawMsg.match(/\bHTTP(?:_|\s+)(\d{3})\b/i);
      if (m) status = Number(m[1]);
    }
    const code = String(errorCode || (typeof errOrMsg === 'object' && errOrMsg?.errorCode) || '').trim();

    if (code === 'INVALID_API_KEY_CHARS' || /API Key 格式錯誤|non ISO-8859-1|Invalid header value/i.test(rawMsg)) {
      return {
        shortMsg: 'API Key 格式有誤',
        detailMsg: 'API Key 含有不可見字元或非英文 ASCII 符號，請重新複製純金鑰並儲存',
        rawMsg,
        retryable: false,
        suggestSwitch: true
      };
    }

    if (code === 'NO_API_KEY' || /尚未設定.*API Key/i.test(rawMsg)) {
      return {
        shortMsg: '尚未設定 API Key',
        detailMsg: '尚未設定 API Key，請先填寫金鑰或切換其他已設定的供應商',
        rawMsg,
        retryable: false,
        suggestSwitch: true
      };
    }

    if (code === 'NO_MODEL' || /尚未選擇模型/i.test(rawMsg)) {
      return {
        shortMsg: '尚未選擇模型',
        detailMsg: rawMsg || '尚未選擇模型，請先至設定頁選擇模型',
        rawMsg,
        retryable: false,
        suggestSwitch: false
      };
    }

    if (status === 401 || status === 403 || code === 'AUTH_ERROR' || code === 'HTTP_401' || code === 'HTTP_403') {
      const displayStatus = status || (code === 'HTTP_403' ? 403 : 401);
      return {
        shortMsg: 'API Key 驗證失敗',
        detailMsg: `API Key 無效或無存取權限（HTTP ${displayStatus}），請檢查金鑰設定`,
        rawMsg,
        retryable: false,
        suggestSwitch: true
      };
    }

    if (status === 404 || code === 'HTTP_404') {
      return {
        shortMsg: '模型不存在 (404)',
        detailMsg: '找不到指定模型（HTTP 404），請至設定重新取得模型清單',
        rawMsg,
        retryable: false,
        suggestSwitch: true
      };
    }

    if (
      status === 429 ||
      code === 'QUOTA_EXCEEDED' ||
      code === 'RATE_LIMITED' ||
      code === 'RATE_LIMIT' ||
      /rate limit|PerDay|RequestsPerDay|GenerateRequestsPerDay/i.test(rawMsg)
    ) {
      if (
        code === 'QUOTA_EXCEEDED' ||
        /PerDay|RequestsPerDay|GenerateRequestsPerDay|每日.*額度|配額上限|額度已用盡|配額為 0|quota/i.test(rawMsg)
      ) {
        return {
          shortMsg: '每日額度已用盡 (429)',
          detailMsg: '已達此供應商配額上限（HTTP 429），建議切換其他供應商或模型',
          rawMsg,
          retryable: false,
          suggestSwitch: true
        };
      }
      return {
        shortMsg: '請求過頻 (429)',
        detailMsg: 'API 請求頻率達上限（HTTP 429），請稍候重試或切換供應商',
        rawMsg,
        retryable: true,
        suggestSwitch: true
      };
    }

    const noExplicitStatusOrOverload = !status || status === 503 || status === 529;
    if (
      status === 503 ||
      status === 529 ||
      code === 'OVERLOADED' ||
      (noExplicitStatusOrOverload && /high demand|overloaded|UNAVAILABLE|capacity|temporarily unavailable/i.test(rawMsg))
    ) {
      const displayStatus = status === 529 ? 529 : 503;
      return {
        shortMsg: `模型尖峰過載 (${displayStatus})`,
        detailMsg: `目前模型流量過載（HTTP ${displayStatus}），可重試或立即切換其他供應商`,
        rawMsg,
        retryable: true,
        suggestSwitch: true
      };
    }

    if (status === 500 || status === 502 || status === 504 || code === 'SERVER_ERROR') {
      const displayStatus = status || 500;
      return {
        shortMsg: `服務暫時異常 (${displayStatus})`,
        detailMsg: `AI 服務端暫時異常（HTTP ${displayStatus}），可重試或切換供應商`,
        rawMsg,
        retryable: true,
        suggestSwitch: true
      };
    }

    if (code === 'TIMEOUT' || code === 'NETWORK_ERROR' || /timeout|timed out|逾時|failed to fetch|networkerror|load failed/i.test(rawMsg)) {
      return {
        shortMsg: '連線逾時或網路異常',
        detailMsg: rawMsg || '請求逾時或網路連線失敗，可重試或切換其他供應商',
        rawMsg,
        retryable: true,
        suggestSwitch: true
      };
    }

    const fallbackShort = rawMsg
      ? (rawMsg.length > 22 ? `${rawMsg.slice(0, 21)}…` : rawMsg)
      : '翻譯失敗';
    const fallbackDetail = rawMsg
      ? (rawMsg.length > 90 ? `${rawMsg.slice(0, 89)}…` : rawMsg)
      : '翻譯失敗，請稍後重試或切換供應商';
    return {
      shortMsg: fallbackShort,
      detailMsg: fallbackDetail,
      rawMsg,
      retryable: true,
      suggestSwitch: true
    };
  }

  globalThis.KCTConfig = {
    PROVIDER_PRESETS,
    TARGET_LANGUAGES,
    DEFAULT_GLOSSARY,
    DEFAULT_SETTINGS,
    SETTINGS_KEY,
    CACHE_KEY,
    resolveTargetLanguage,
    normalizeOpenAIEndpoint,
    normalizeGeminiEndpoint,
    resolveEndpoint,
    resolveStreamEndpoint,
    resolveThinkingConfig,
    normalizeHostname,
    isHostWhitelisted,
    toggleHostWhitelist,
    isInjectableUrl,
    isFileUrl,
    isFilePdfUrl,
    isRemotePdfUrl,
    isPdfUrl,
    extractGoogleDriveFileId,
    resolvePdfSourceUrl,
    isAzureOpenAIEndpoint,
    buildListModelsUrl,
    parseListModelsResponse,
    normalizeAnthropicEndpoint,
    buildProviderAuthHeaders,
    resolveAnthropicEffort,
    buildAnthropicMessagesBody,
    extractAnthropicText,
    extractAnthropicStreamDelta,
    isLocalEndpoint,
    sanitizeApiKey,
    validateApiKey,
    normalizeProviderProfiles,
    isProfileSaved,
    isProfileReady,
    listSavedProviders,
    switchActiveProviderSettings,
    removeProviderProfile,
    resolveFallbackSettings,
    formatApiError,
    getSettings,
    saveSettings,
    hashText
  };
})();
