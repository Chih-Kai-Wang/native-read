package com.chihkaiwang.nativeread

import android.annotation.SuppressLint
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import com.chihkaiwang.nativeread.ui.theme.NativeReadTheme
import kotlinx.coroutines.delay
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    private lateinit var syncStore: SyncStore
    private var selectedTab by mutableIntStateOf(0)
    private var urlInput by mutableStateOf("https://www.kaggle.com/")
    private var activeUrl by mutableStateOf("https://www.kaggle.com/")
    private var navigationSeq by mutableIntStateOf(1)
    private var pendingAutoStart by mutableStateOf(false)
    private var translateTriggerSeq by mutableIntStateOf(0)
    private var goBackSeq by mutableIntStateOf(0)
    private var reloadSeq by mutableIntStateOf(0)
    private var displayMode by mutableStateOf("replace")
    private var modeTriggerSeq by mutableIntStateOf(0)
    private var isConfigured by mutableStateOf(false)
    private var bannerMessage by mutableStateOf<String?>(null)
    private var bannerIsError by mutableStateOf(false)
    private var pdfReloadSeq by mutableIntStateOf(1)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        syncStore = SyncStore(applicationContext)
        refreshStoreState()
        handleIncomingIntent(intent)

        setContent {
            NativeReadTheme {
                NativeReadMobileShell(
                    syncStore = syncStore,
                    selectedTab = selectedTab,
                    onSelectTab = { selectedTab = it },
                    urlInput = urlInput,
                    onUrlInputChange = { urlInput = it },
                    activeUrl = activeUrl,
                    navigationSeq = navigationSeq,
                    pendingAutoStart = pendingAutoStart,
                    onConsumeAutoStart = { pendingAutoStart = false },
                    onNavigateUrl = { raw, autoTranslate ->
                        navigateToUrl(raw, autoTranslate)
                    },
                    translateTriggerSeq = translateTriggerSeq,
                    onTapTranslate = {
                        if (!isConfigured) {
                            showBanner("請先匯入電腦設定或填寫 API 金鑰，即可一鍵翻譯。", isError = true)
                            selectedTab = 2
                        } else {
                            translateTriggerSeq += 1
                        }
                    },
                    goBackSeq = goBackSeq,
                    onTapBack = { goBackSeq += 1 },
                    reloadSeq = reloadSeq,
                    onTapReload = { reloadSeq += 1 },
                    displayMode = displayMode,
                    modeTriggerSeq = modeTriggerSeq,
                    onSelectMode = { mode ->
                        displayMode = mode
                        modeTriggerSeq += 1
                    },
                    isConfigured = isConfigured,
                    onSettingsUpdated = { msg ->
                        refreshStoreState()
                        pdfReloadSeq += 1
                        if (msg != null) showBanner(msg, isError = false)
                    },
                    bannerMessage = bannerMessage,
                    bannerIsError = bannerIsError,
                    onDismissBanner = { bannerMessage = null },
                    onErrorBanner = { msg -> showBanner(msg, isError = true) },
                    pdfReloadSeq = pdfReloadSeq,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun refreshStoreState() {
        val obj = syncStore.loadSettingsJson()
        isConfigured = syncStore.isConfigured(obj)
        displayMode = obj.optString("displayMode", "replace")
    }

    private fun showBanner(text: String, isError: Boolean) {
        bannerMessage = text
        bannerIsError = isError
    }

    private fun navigateToUrl(raw: String, autoTranslate: Boolean) {
        var cleaned = raw.trim()
        if (cleaned.isEmpty()) return
        if (!cleaned.contains("://")) {
            cleaned = "https://$cleaned"
        }
        val parsed = runCatching { Uri.parse(cleaned) }.getOrNull()
        val scheme = parsed?.scheme?.lowercase().orEmpty()
        if (parsed == null || (scheme != "http" && scheme != "https") || parsed.host.isNullOrBlank()) {
            showBanner("請輸入有效的 http:// 或 https:// 網址", isError = true)
            return
        }
        urlInput = parsed.toString()
        activeUrl = parsed.toString()
        pendingAutoStart = autoTranslate
        navigationSeq += 1
        selectedTab = 0
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action
        val data = intent.data

        if (action == Intent.ACTION_VIEW && data != null) {
            val abs = data.toString()
            if (abs.contains("nr_sync=")) {
                if (syncStore.importSyncToken(abs)) {
                    refreshStoreState()
                    pdfReloadSeq += 1
                    showBanner("✅ 已一鍵同步電腦端 NativeRead 設定！", isError = false)
                }
            }
            if (data.scheme.equals("nativeread", ignoreCase = true) && data.host.equals("open", ignoreCase = true)) {
                val targetUrl = data.getQueryParameter("url").orEmpty()
                if (targetUrl.isNotBlank()) {
                    navigateToUrl(targetUrl, autoTranslate = isConfigured)
                }
                return
            }
            if (data.scheme.equals("nativeread", ignoreCase = true)) {
                selectedTab = if (isConfigured) 0 else 2
                return
            }
            if (intent.type == "application/pdf" || abs.lowercase().endsWith(".pdf")) {
                selectedTab = 1
                return
            }
        }

        if (action == Intent.ACTION_SEND) {
            val type = intent.type.orEmpty()
            if (type == "application/pdf") {
                selectedTab = 1
                showBanner("已切換至 PDF 閱讀器，請點選本機檔案開啟 PDF。", isError = false)
                return
            }
            val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
            val urlMatch = Regex("""https?://[^\s<>"']+""").find(sharedText)
            if (urlMatch != null) {
                val sharedUrl = urlMatch.value.trimEnd('.', ',', ';', ')', ']')
                if (sharedUrl.lowercase().contains(".pdf")) {
                    selectedTab = 1
                    pdfReloadSeq += 1
                    showBanner("偵測到 PDF 連結，已開啟 PDF 閱讀器。", isError = false)
                } else {
                    navigateToUrl(sharedUrl, autoTranslate = isConfigured)
                    if (!isConfigured) {
                        showBanner("已載入分享網頁！先完成下方一秒同步後即可一鍵翻譯。", isError = true)
                    } else {
                        showBanner("⚡ 已接收分享網頁，正在保留原版排版自動翻譯...", isError = false)
                    }
                }
            }
        }
    }
}

@Composable
private fun NativeReadMobileShell(
    syncStore: SyncStore,
    selectedTab: Int,
    onSelectTab: (Int) -> Unit,
    urlInput: String,
    onUrlInputChange: (String) -> Unit,
    activeUrl: String,
    navigationSeq: Int,
    pendingAutoStart: Boolean,
    onConsumeAutoStart: () -> Unit,
    onNavigateUrl: (String, Boolean) -> Unit,
    translateTriggerSeq: Int,
    onTapTranslate: () -> Unit,
    goBackSeq: Int,
    onTapBack: () -> Unit,
    reloadSeq: Int,
    onTapReload: () -> Unit,
    displayMode: String,
    modeTriggerSeq: Int,
    onSelectMode: (String) -> Unit,
    isConfigured: Boolean,
    onSettingsUpdated: (String?) -> Unit,
    bannerMessage: String?,
    bannerIsError: Boolean,
    onDismissBanner: () -> Unit,
    onErrorBanner: (String) -> Unit,
    pdfReloadSeq: Int,
) {
    var webStatusText by remember { mutableStateOf("就緒") }
    var isTranslating by remember { mutableStateOf(false) }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = selectedTab == 0,
                    onClick = { onSelectTab(0) },
                    icon = { Text("🌐") },
                    label = { Text("網頁直譯", maxLines = 1) },
                )
                NavigationBarItem(
                    selected = selectedTab == 1,
                    onClick = { onSelectTab(1) },
                    icon = { Text("📄") },
                    label = { Text("PDF 閱讀", maxLines = 1) },
                )
                NavigationBarItem(
                    selected = selectedTab == 2,
                    onClick = { onSelectTab(2) },
                    icon = { Text("⚙") },
                    label = { Text("同步設定", maxLines = 1) },
                )
            }
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            if (bannerMessage != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(if (bannerIsError) Color(0xFFB45309) else Color(0xFF0284C7))
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = bannerMessage,
                        color = Color.White,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    TextButton(onClick = onDismissBanner) {
                        Text("關閉", color = Color.White)
                    }
                }
            }

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                when (selectedTab) {
                    0 -> WebTranslatorTab(
                        syncStore = syncStore,
                        urlInput = urlInput,
                        onUrlInputChange = onUrlInputChange,
                        activeUrl = activeUrl,
                        navigationSeq = navigationSeq,
                        pendingAutoStart = pendingAutoStart,
                        onConsumeAutoStart = onConsumeAutoStart,
                        onNavigateUrl = onNavigateUrl,
                        translateTriggerSeq = translateTriggerSeq,
                        onTapTranslate = onTapTranslate,
                        goBackSeq = goBackSeq,
                        onTapBack = onTapBack,
                        reloadSeq = reloadSeq,
                        onTapReload = onTapReload,
                        displayMode = displayMode,
                        modeTriggerSeq = modeTriggerSeq,
                        onSelectMode = onSelectMode,
                        isConfigured = isConfigured,
                        onGoSettings = { onSelectTab(2) },
                        webStatusText = webStatusText,
                        isTranslating = isTranslating,
                        onStatusChanged = { translating, status ->
                            isTranslating = translating
                            webStatusText = status
                        },
                        onSettingsUpdated = { onSettingsUpdated(null) },
                    )

                    1 -> PdfReaderTab(
                        syncStore = syncStore,
                        pdfReloadSeq = pdfReloadSeq,
                    )

                    else -> SyncSettingsTab(
                        syncStore = syncStore,
                        isConfigured = isConfigured,
                        onSettingsUpdated = onSettingsUpdated,
                        onErrorBanner = onErrorBanner,
                    )
                }
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun WebTranslatorTab(
    syncStore: SyncStore,
    urlInput: String,
    onUrlInputChange: (String) -> Unit,
    activeUrl: String,
    navigationSeq: Int,
    pendingAutoStart: Boolean,
    onConsumeAutoStart: () -> Unit,
    onNavigateUrl: (String, Boolean) -> Unit,
    translateTriggerSeq: Int,
    onTapTranslate: () -> Unit,
    goBackSeq: Int,
    onTapBack: () -> Unit,
    reloadSeq: Int,
    onTapReload: () -> Unit,
    displayMode: String,
    modeTriggerSeq: Int,
    onSelectMode: (String) -> Unit,
    isConfigured: Boolean,
    onGoSettings: () -> Unit,
    webStatusText: String,
    isTranslating: Boolean,
    onStatusChanged: (Boolean, String) -> Unit,
    onSettingsUpdated: () -> Unit,
) {
    val context = LocalContext.current
    val userscriptBody = remember {
        runCatching {
            context.assets.open("nativeread.user.js").bufferedReader().use { it.readText() }
        }.getOrDefault("")
    }

    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    var lastNavSeq by remember { mutableIntStateOf(0) }
    var lastTranslateSeq by remember { mutableIntStateOf(0) }
    var lastModeSeq by remember { mutableIntStateOf(0) }
    var lastBackSeq by remember { mutableIntStateOf(0) }
    var lastReloadSeq by remember { mutableIntStateOf(0) }

    val bridge = remember {
        NativeReadBridge(
            syncStore = syncStore,
            webViewProvider = { webViewRef },
            onSettingsSaved = onSettingsUpdated,
        )
    }

    LaunchedEffect(Unit) {
        while (true) {
            delay(800)
            val wv = webViewRef ?: continue
            wv.evaluateJavascript(
                "typeof globalThis.__NATIVEREAD_GET_STATE__==='function'?JSON.stringify(globalThis.__NATIVEREAD_GET_STATE__()):''",
            ) { result ->
                if (result.isNullOrBlank() || result == "null" || result == "\"\"") return@evaluateJavascript
                val decoded = runCatching { JSONObject("{\"v\":$result}").optString("v", "") }.getOrDefault("")
                if (decoded.isBlank()) return@evaluateJavascript
                val obj = runCatching { JSONObject(decoded) }.getOrNull() ?: return@evaluateJavascript
                val translating = obj.optBoolean("isTranslating", false)
                val done = obj.optInt("totalTranslated", 0)
                val total = obj.optInt("totalDetected", 0)
                val err = obj.optString("lastErrorMsg", "")
                val status = when {
                    err.isNotEmpty() -> err
                    translating -> "翻譯中 $done/$total"
                    done > 0 -> "已譯 $done 段"
                    else -> "就緒"
                }
                onStatusChanged(translating, status)
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Surface(tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    OutlinedButton(onClick = onTapBack) {
                        Text("←")
                    }
                    OutlinedTextField(
                        value = urlInput,
                        onValueChange = onUrlInputChange,
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("https://...") },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Go,
                        ),
                        keyboardActions = KeyboardActions(
                            onGo = { onNavigateUrl(urlInput, false) },
                        ),
                    )
                    Button(onClick = { onNavigateUrl(urlInput, false) }) {
                        Text("前往")
                    }
                }

                Spacer(modifier = Modifier.height(6.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Button(onClick = onTapTranslate) {
                        Text(if (isTranslating) "重新翻譯" else "一鍵翻譯", maxLines = 1)
                    }
                    FilterChip(
                        selected = displayMode == "replace",
                        onClick = { onSelectMode("replace") },
                        label = { Text("譯文", maxLines = 1) },
                    )
                    FilterChip(
                        selected = displayMode == "bilingual",
                        onClick = { onSelectMode("bilingual") },
                        label = { Text("雙語", maxLines = 1) },
                    )
                    FilterChip(
                        selected = displayMode == "original",
                        onClick = { onSelectMode("original") },
                        label = { Text("原文", maxLines = 1) },
                    )
                    Spacer(modifier = Modifier.weight(1f))
                    Text(
                        text = webStatusText,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                if (!isConfigured) {
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0x22F59E0B), MaterialTheme.shapes.small)
                            .clickable { onGoSettings() }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("尚未同步 API 金鑰，點此一秒匯入", style = MaterialTheme.typography.bodySmall)
                        Text("去同步 →", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        AndroidView(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            factory = { ctx ->
                WebView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = true
                    settings.builtInZoomControls = true
                    settings.displayZoomControls = false
                    addJavascriptInterface(bridge, "NRAndroidBridge")
                    webViewClient = object : WebViewClient() {
                        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                            super.onPageStarted(view, url, favicon)
                            bridge.rotateNonce()
                        }

                        override fun onPageFinished(view: WebView, url: String?) {
                            super.onPageFinished(view, url)
                            if (!url.isNullOrBlank() && url != "about:blank") {
                                onUrlInputChange(url)
                            }
                            if (userscriptBody.isNotEmpty()) {
                                val autoStart = pendingAutoStart
                                if (autoStart) onConsumeAutoStart()
                                val script = bridge.buildInjectionScript(autoStart, userscriptBody)
                                view.evaluateJavascript(script, null)
                                onStatusChanged(autoStart, if (autoStart) "自動翻譯啟動中..." else "就緒")
                            }
                        }
                    }
                    webViewRef = this
                    lastNavSeq = navigationSeq
                    loadUrl(activeUrl)
                }
            },
            update = { wv ->
                webViewRef = wv
                if (lastNavSeq != navigationSeq) {
                    lastNavSeq = navigationSeq
                    wv.loadUrl(activeUrl)
                }
                if (lastBackSeq != goBackSeq) {
                    lastBackSeq = goBackSeq
                    if (wv.canGoBack()) wv.goBack()
                }
                if (lastReloadSeq != reloadSeq) {
                    lastReloadSeq = reloadSeq
                    wv.reload()
                }
                if (lastTranslateSeq != translateTriggerSeq) {
                    lastTranslateSeq = translateTriggerSeq
                    wv.evaluateJavascript(
                        "if(typeof globalThis.__NATIVEREAD_RELOAD_SETTINGS__==='function'){Promise.resolve(globalThis.__NATIVEREAD_RELOAD_SETTINGS__()).then(function(){if(typeof globalThis.__NATIVEREAD_TRANSLATE_NOW__==='function')globalThis.__NATIVEREAD_TRANSLATE_NOW__();});}else if(typeof globalThis.__NATIVEREAD_TRANSLATE_NOW__==='function'){globalThis.__NATIVEREAD_TRANSLATE_NOW__();}",
                        null,
                    )
                }
                if (lastModeSeq != modeTriggerSeq) {
                    lastModeSeq = modeTriggerSeq
                    val clean = if (displayMode == "bilingual" || displayMode == "original") displayMode else "replace"
                    wv.evaluateJavascript(
                        "if(typeof globalThis.__NATIVEREAD_SET_MODE__==='function')globalThis.__NATIVEREAD_SET_MODE__('$clean');",
                        null,
                    )
                }
            },
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            webViewRef?.destroy()
            webViewRef = null
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun PdfReaderTab(
    syncStore: SyncStore,
    pdfReloadSeq: Int,
) {
    val context = LocalContext.current
    val assetLoader = remember {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
    }
    var filePathCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val fileChooserLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    var lastPdfSeq by remember { mutableIntStateOf(0) }
    var pdfWebView by remember { mutableStateOf<WebView?>(null) }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                webChromeClient = object : WebChromeClient() {
                    override fun onShowFileChooser(
                        webView: WebView?,
                        callback: ValueCallback<Array<Uri>>?,
                        params: FileChooserParams?,
                    ): Boolean {
                        filePathCallback?.onReceiveValue(null)
                        filePathCallback = callback
                        val chooser = runCatching { params?.createIntent() }.getOrNull()
                            ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                                type = "application/pdf"
                                addCategory(Intent.CATEGORY_OPENABLE)
                            }
                        fileChooserLauncher.launch(chooser)
                        return true
                    }
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest,
                    ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                    override fun onPageFinished(view: WebView, url: String?) {
                        super.onPageFinished(view, url)
                        val rawJson = syncStore.loadRawJson() ?: return
                        val seedJs = "try{localStorage.setItem(${JSONObject.quote(SyncStore.SETTINGS_KEY)},${JSONObject.quote(rawJson)});window.dispatchEvent(new Event('nativeread:pwa-settings-synced'));}catch(_){}"
                        view.evaluateJavascript(seedJs, null)
                    }
                }
                pdfWebView = this
                lastPdfSeq = pdfReloadSeq
                loadUrl("https://appassets.androidplatform.net/assets/pwa/index.html")
            }
        },
        update = { wv ->
            pdfWebView = wv
            if (lastPdfSeq != pdfReloadSeq) {
                lastPdfSeq = pdfReloadSeq
                wv.reload()
            }
        },
    )

    DisposableEffect(Unit) {
        onDispose {
            pdfWebView?.destroy()
            pdfWebView = null
        }
    }
}

@Composable
private fun SyncSettingsTab(
    syncStore: SyncStore,
    isConfigured: Boolean,
    onSettingsUpdated: (String?) -> Unit,
    onErrorBanner: (String) -> Unit,
) {
    val context = LocalContext.current
    val initial = remember(isConfigured) { syncStore.loadSettingsJson() }
    var syncInput by remember { mutableStateOf("") }
    var providerId by remember { mutableStateOf(initial.optString("providerId", "gemini")) }
    var protocol by remember { mutableStateOf(initial.optString("protocol", "gemini")) }
    var baseUrl by remember { mutableStateOf(initial.optString("baseUrl", "https://generativelanguage.googleapis.com/v1beta")) }
    var apiKey by remember { mutableStateOf(initial.optString("apiKey", "")) }
    var modelName by remember { mutableStateOf(initial.optString("model", "gemini-3.5-flash-lite")) }
    var targetLang by remember { mutableStateOf(initial.optString("targetLang", "zh-TW")) }
    var providerMenuExpanded by remember { mutableStateOf(false) }
    var langMenuExpanded by remember { mutableStateOf(false) }

    LaunchedEffect(isConfigured) {
        val fresh = syncStore.loadSettingsJson()
        providerId = fresh.optString("providerId", "gemini")
        protocol = fresh.optString("protocol", "gemini")
        baseUrl = fresh.optString("baseUrl", baseUrl)
        apiKey = fresh.optString("apiKey", "")
        modelName = fresh.optString("model", "")
        targetLang = fresh.optString("targetLang", "zh-TW")
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = if (isConfigured) Color(0x1810B981) else Color(0x18F59E0B),
            ),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = if (isConfigured) "✅ 已同步電腦端設定 · 一鍵可用" else "⚠️ 尚未匯入 API 金鑰",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text = if (isConfigured) {
                        "供應商：$providerId · 模型：${modelName.ifBlank { "未指定" }} · 目標語言：$targetLang"
                    } else {
                        "從電腦「📱 手機同步」複製連結後點下方一鍵貼上，或掃描 QR Code 打開本 App 即可自動匯入。"
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("一秒同步設定連結", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Button(
                    onClick = {
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        val clip = cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
                        if (clip.isBlank()) {
                            onErrorBanner("剪貼簿是空的，請先從電腦複製同步連結。")
                        } else if (syncStore.importSyncToken(clip)) {
                            onSettingsUpdated("✅ 已從剪貼簿匯入設定！")
                        } else {
                            onErrorBanner("⚠️ 剪貼簿內容不是有效的 #nr_sync 同步連結。")
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("📋 從剪貼簿一鍵匯入")
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = syncInput,
                        onValueChange = { syncInput = it },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("貼上 https://...#nr_sync=...") },
                    )
                    OutlinedButton(
                        onClick = {
                            if (syncStore.importSyncToken(syncInput)) {
                                syncInput = ""
                                onSettingsUpdated("✅ 已匯入設定！")
                            } else {
                                onErrorBanner("⚠️ 同步連結格式無效或金鑰不合法。")
                            }
                        },
                    ) {
                        Text("匯入")
                    }
                }
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("手動設定 AI 模型", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)

                Box {
                    OutlinedButton(onClick = { providerMenuExpanded = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("供應商：${SyncStore.presetFor(providerId).label}")
                    }
                    DropdownMenu(expanded = providerMenuExpanded, onDismissRequest = { providerMenuExpanded = false }) {
                        SyncStore.PRESETS.forEach { preset ->
                            DropdownMenuItem(
                                text = { Text(preset.label) },
                                onClick = {
                                    providerMenuExpanded = false
                                    providerId = preset.id
                                    protocol = preset.protocol
                                    if (preset.baseUrl.isNotEmpty()) baseUrl = preset.baseUrl
                                    if (preset.defaultModel.isNotEmpty()) modelName = preset.defaultModel
                                },
                            )
                        }
                    }
                }

                OutlinedTextField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("API Base URL") },
                )

                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("API Key") },
                    visualTransformation = PasswordVisualTransformation(),
                )

                OutlinedTextField(
                    value = modelName,
                    onValueChange = { modelName = it },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("模型名稱") },
                )

                Box {
                    val langLabel = SyncStore.TARGET_LANGUAGES.firstOrNull { it.first == targetLang }?.second ?: targetLang
                    OutlinedButton(onClick = { langMenuExpanded = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("目標翻譯語言：$langLabel")
                    }
                    DropdownMenu(expanded = langMenuExpanded, onDismissRequest = { langMenuExpanded = false }) {
                        SyncStore.TARGET_LANGUAGES.forEach { (id, label) ->
                            DropdownMenuItem(
                                text = { Text(label) },
                                onClick = {
                                    langMenuExpanded = false
                                    targetLang = id
                                },
                            )
                        }
                    }
                }

                Button(
                    onClick = {
                        syncStore.saveManual(providerId, protocol, baseUrl, apiKey, modelName, targetLang)
                            .onSuccess { onSettingsUpdated("✅ 設定已儲存！") }
                            .onFailure { onErrorBanner("⚠️ ${it.message}") }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("儲存設定")
                }
            }
        }
    }
}
