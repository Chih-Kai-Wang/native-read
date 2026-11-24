//
//  NativeReadAppView.swift
//  iOS (App)
//
//  1-Tap iOS NativeRead App:
//   - Tab 1: Built-in original-layout WebView translator (WKContentWorld.defaultClient + URLSession XHR bridge)
//   - Tab 2: Safari Native Extension quick-enable & readiness status
//   - Tab 3: Zero-typing QR / Clipboard #nr_sync & direct model settings (shared with Safari Extension)
//

#if os(iOS)
import Combine
import Foundation
import SwiftUI
import UIKit
import WebKit

@MainActor
final class NativeReadAppModel: ObservableObject {
    static let shared = NativeReadAppModel()

    @Published var selectedTab: Int = 0
    @Published var urlInput: String = "https://www.kaggle.com/"
    @Published var targetURL: URL = URL(string: "https://www.kaggle.com/")!
    @Published var navigationID: Int = 1
    @Published var displayMode: String = "replace"
    @Published var pendingAutoStart: Bool = false
    @Published var translateTrigger: Int = 0
    @Published var modeTrigger: Int = 0
    @Published var webGoBackTrigger: Int = 0
    @Published var webCanGoBack: Bool = false
    @Published var webStatusText: String = "就緒"
    @Published var isTranslating: Bool = false

    @Published var isConfigured: Bool = false
    @Published var providerId: String = "gemini"
    @Published var protocolType: String = "gemini"
    @Published var baseUrl: String = ""
    @Published var apiKey: String = ""
    @Published var modelName: String = ""
    @Published var targetLang: String = "zh-TW"

    @Published var syncInput: String = ""
    @Published var bannerText: String? = nil
    @Published var bannerIsError: Bool = false

    private init() {
        reloadFromStore()
    }

    func reloadFromStore() {
        let dict = NativeReadStore.loadSettingsDict()
        providerId = (dict["providerId"] as? String) ?? "gemini"
        let preset = NativeReadStore.preset(for: providerId)
        protocolType = (dict["protocol"] as? String) ?? preset.defaultProtocol
        baseUrl = (dict["baseUrl"] as? String) ?? preset.defaultBaseUrl
        apiKey = (dict["apiKey"] as? String) ?? ""
        modelName = (dict["model"] as? String) ?? preset.defaultModel
        targetLang = (dict["targetLang"] as? String) ?? "zh-TW"
        displayMode = (dict["displayMode"] as? String) ?? "replace"
        isConfigured = NativeReadStore.isConfigured(dict)
    }

    func navigateToInput(autoTranslate: Bool = false) {
        var raw = urlInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        if !raw.contains("://") {
            raw = "https://" + raw
        }
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            showBanner("請輸入有效的 http:// 或 https:// 網址", isError: true)
            return
        }
        urlInput = url.absoluteString
        targetURL = url
        pendingAutoStart = autoTranslate
        navigationID += 1
        selectedTab = 0
    }

    func triggerOneTapTranslate() {
        if !isConfigured {
            showBanner("請先掃描電腦 QR Code 或貼上設定連結，即可一鍵翻譯。", isError: true)
            selectedTab = 2
            return
        }
        translateTrigger += 1
    }

    func updateMode(_ mode: String) {
        displayMode = mode
        modeTrigger += 1
    }

    func importSyncToken(_ raw: String) {
        if NativeReadStore.importSyncInput(raw) {
            syncInput = ""
            reloadFromStore()
            showBanner("✅ 設定已同步！內建瀏覽器與 Safari 延伸功能皆已就緒。", isError: false)
        } else {
            showBanner("⚠️ 同步連結格式無效或金鑰不合法。", isError: true)
        }
    }

    func saveManualForm() {
        switch NativeReadStore.saveManual(
            providerId: providerId,
            protocolType: protocolType,
            baseUrl: baseUrl,
            apiKey: apiKey,
            model: modelName,
            targetLang: targetLang
        ) {
        case .success:
            reloadFromStore()
            showBanner("✅ 已儲存設定並同步給 Safari 延伸功能。", isError: false)
        case .failure(let err):
            showBanner("⚠️ " + err.localizedDescription, isError: true)
        }
    }

    func handleIncomingURL(_ url: URL) {
        let abs = url.absoluteString
        if abs.contains("nr_sync=") {
            if NativeReadStore.importSyncInput(abs) {
                reloadFromStore()
                showBanner("✅ 已一鍵同步電腦端 NativeRead 設定！", isError: false)
            }
        }
        if url.scheme?.lowercased() == "nativeread",
           url.host?.lowercased() == "open",
           let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let targetStr = comps.queryItems?.first(where: { $0.name == "url" })?.value,
           let nextUrl = URL(string: targetStr),
           ["http", "https"].contains(nextUrl.scheme?.lowercased() ?? "") {
            urlInput = nextUrl.absoluteString
            targetURL = nextUrl
            pendingAutoStart = true
            navigationID += 1
            selectedTab = 0
        }
    }

    func showBanner(_ text: String, isError: Bool) {
        bannerText = text
        bannerIsError = isError
    }
}

struct NativeReadRootView: View {
    @ObservedObject private var model = NativeReadAppModel.shared

    var body: some View {
        VStack(spacing: 0) {
            if let msg = model.bannerText {
                HStack(spacing: 8) {
                    Text(msg)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Button {
                        model.bannerText = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.white.opacity(0.85))
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(model.bannerIsError ? Color.orange.opacity(0.95) : Color.blue)
            }

            TabView(selection: $model.selectedTab) {
                BrowserTabView(model: model)
                    .tabItem {
                        Label("原版直譯", systemImage: "globe")
                    }
                    .tag(0)

                SafariStatusTabView(model: model)
                    .tabItem {
                        Label("Safari 外掛", systemImage: "safari")
                    }
                    .tag(1)

                SyncSettingsTabView(model: model)
                    .tabItem {
                        Label("設定同步", systemImage: "qrcode.viewfinder")
                    }
                    .tag(2)
            }
        }
    }
}

private struct BrowserTabView: View {
    @ObservedObject var model: NativeReadAppModel
    @FocusState private var urlFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    Button {
                        model.webGoBackTrigger += 1
                    } label: {
                        Image(systemName: "chevron.left")
                            .frame(width: 28, height: 32)
                    }
                    .disabled(!model.webCanGoBack)

                    TextField("輸入網址 (https://...)", text: $model.urlInput)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($urlFocused)
                        .onSubmit {
                            model.navigateToInput(autoTranslate: false)
                        }

                    Button("前往") {
                        urlFocused = false
                        model.navigateToInput(autoTranslate: false)
                    }
                    .buttonStyle(.bordered)

                    Button {
                        urlFocused = false
                        model.triggerOneTapTranslate()
                    } label: {
                        Label(model.isTranslating ? "翻譯中" : "一鍵翻譯", systemImage: "sparkles")
                            .font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                }

                HStack(spacing: 10) {
                    Picker("顯示模式", selection: Binding(
                        get: { model.displayMode },
                        set: { model.updateMode($0) }
                    )) {
                        Text("譯文").tag("replace")
                        Text("雙語").tag("bilingual")
                        Text("原文").tag("original")
                    }
                    .pickerStyle(.segmented)

                    Text(model.webStatusText)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                if !model.isConfigured {
                    HStack {
                        Text("尚未同步 API 金鑰，點右方按鈕一秒同步：")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("去同步") {
                            model.selectedTab = 2
                        }
                        .font(.caption.weight(.semibold))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)

            Divider()

            NativeReadUserscriptWebView(model: model)
                .ignoresSafeArea(edges: .bottom)
        }
    }
}

private struct SafariStatusTabView: View {
    @ObservedObject var model: NativeReadAppModel

    var body: some View {
        NavigationStack {
            List {
                Section("Safari 原生延伸功能（免裝 Stay／Userscripts）") {
                    HStack {
                        Image(systemName: model.isConfigured ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(model.isConfigured ? .green : .orange)
                            .font(.title2)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.isConfigured ? "API 設定已同步就緒" : "尚未匯入 API 設定")
                                .font(.headline)
                            Text("在 iOS Safari 中直接開啟 NativeRead 延伸功能，即可於任何網頁原位翻譯。")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)

                    Button {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    } label: {
                        Label("開啟 iOS 設定啟用 Safari 延伸功能", systemImage: "gearshape.arrow.trianglehead.2.clockwise.rotate.90")
                    }
                }

                Section("第一次啟用只需 3 步驟") {
                    Text("1. 先在右側「設定同步」掃描電腦 QR Code 或貼上同步連結。")
                    Text("2. 打開手機「設定 → App → Safari → 延伸功能 → NativeRead」。")
                    Text("3. 開啟 NativeRead，並將權限設為「允許所有網站」，之後瀏覽 Safari 點一下網址列拼圖圖示即可直接翻譯。")
                }
            }
            .navigationTitle("Safari 延伸功能")
        }
    }
}

private struct SyncSettingsTabView: View {
    @ObservedObject var model: NativeReadAppModel
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Form {
                Section("一秒同步電腦端設定（免打字）") {
                    Button {
                        showScanner = true
                    } label: {
                        Label("掃描電腦「📱 手機同步」QR Code", systemImage: "qrcode.viewfinder")
                            .font(.headline)
                    }

                    Button {
                        if let text = UIPasteboard.general.string, !text.isEmpty {
                            model.importSyncToken(text)
                        } else {
                            model.showBanner("剪貼簿是空的，請先從電腦複製同步連結。", isError: true)
                        }
                    } label: {
                        Label("從剪貼簿一鍵匯入", systemImage: "doc.on.clipboard")
                    }

                    HStack {
                        TextField("或貼上 https://...#nr_sync=...", text: $model.syncInput)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("匯入") {
                            model.importSyncToken(model.syncInput)
                        }
                        .disabled(model.syncInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }

                Section("AI 模型與偏好設定") {
                    Picker("供應商", selection: $model.providerId) {
                        ForEach(NativeReadStore.presets, id: \.id) { p in
                            Text(p.label).tag(p.id)
                        }
                    }
                    .onChange(of: model.providerId) { _, newId in
                        let info = NativeReadStore.preset(for: newId)
                        model.protocolType = info.defaultProtocol
                        if !info.defaultBaseUrl.isEmpty {
                            model.baseUrl = info.defaultBaseUrl
                        }
                        if !info.defaultModel.isEmpty {
                            model.modelName = info.defaultModel
                        }
                    }

                    TextField("API Base URL", text: $model.baseUrl)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    SecureField("API Key", text: $model.apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("模型名稱 (例如 gemini-3.5-flash-lite)", text: $model.modelName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Picker("目標語言", selection: $model.targetLang) {
                        ForEach(NativeReadStore.targetLanguages, id: \.id) { lang in
                            Text(lang.label).tag(lang.id)
                        }
                    }

                    Button("儲存設定") {
                        model.saveManualForm()
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .navigationTitle("同步與設定")
            .sheet(isPresented: $showScanner) {
                QRScannerSheet { code in
                    model.importSyncToken(code)
                }
            }
        }
    }
}

private struct NativeReadUserscriptWebView: UIViewRepresentable {
    @ObservedObject var model: NativeReadAppModel

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let controller = WKUserContentController()
        controller.add(context.coordinator, contentWorld: .defaultClient, name: Coordinator.handlerName)
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.webView = webView
        webView.load(URLRequest(url: model.targetURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.lastNavigationID != model.navigationID {
            context.coordinator.lastNavigationID = model.navigationID
            webView.load(URLRequest(url: model.targetURL))
        }
        if context.coordinator.lastTranslateTrigger != model.translateTrigger {
            context.coordinator.lastTranslateTrigger = model.translateTrigger
            context.coordinator.triggerTranslateInPage()
        }
        if context.coordinator.lastModeTrigger != model.modeTrigger {
            context.coordinator.lastModeTrigger = model.modeTrigger
            context.coordinator.setDisplayModeInPage(model.displayMode)
        }
        if context.coordinator.lastBackTrigger != model.webGoBackTrigger {
            context.coordinator.lastBackTrigger = model.webGoBackTrigger
            if webView.canGoBack {
                webView.goBack()
            }
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        static let handlerName = "nrBridge"

        let model: NativeReadAppModel
        weak var webView: WKWebView?
        var lastNavigationID: Int = 1
        var lastTranslateTrigger: Int = 0
        var lastModeTrigger: Int = 0
        var lastBackTrigger: Int = 0
        private var pollTimer: Timer?
        private var cachedUserscript: String?

        init(model: NativeReadAppModel) {
            self.model = model
        }

        private func loadUserscriptSource() -> String {
            if let cachedUserscript { return cachedUserscript }
            guard let url = Bundle.main.url(forResource: "nativeread.user", withExtension: "js"),
                  let text = try? String(contentsOf: url, encoding: .utf8) else {
                return ""
            }
            cachedUserscript = text
            return text
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            model.webCanGoBack = webView.canGoBack
            model.webStatusText = "載入網頁中..."
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.webCanGoBack = webView.canGoBack
            if let current = webView.url?.absoluteString, current != "about:blank" {
                model.urlInput = current
            }
            let autoStart = model.pendingAutoStart
            model.pendingAutoStart = false
            injectNativeReadRuntime(autoStart: autoStart)
            startStatusPolling()
        }

        private func injectNativeReadRuntime(autoStart: Bool) {
            guard let webView else { return }
            let scriptSource = loadUserscriptSource()
            guard !scriptSource.isEmpty else {
                model.webStatusText = "缺少 nativeread.user.js"
                return
            }
            let rawSettings = NativeReadStore.loadRawJson() ?? ""
            let encodedSettings = String(
                data: (try? JSONSerialization.data(withJSONObject: [rawSettings])) ?? Data("[\"\"]".utf8),
                encoding: .utf8
            ) ?? "[\"\"]"

            let prelude = """
            (() => {
              if (!globalThis.__NR_NATIVE_BRIDGE_READY__) {
                globalThis.__NR_NATIVE_BRIDGE_READY__ = true;
                const initialArr = \(encodedSettings);
                let cachedRaw = initialArr[0] || '';
                const xhrCallbacks = new Map();
                let nextReqSeq = 1;
                globalThis.__NR_NATIVE_RESOLVE_XHR__ = (reqId, payload) => {
                  const entry = xhrCallbacks.get(reqId);
                  if (!entry) return;
                  xhrCallbacks.delete(reqId);
                  if (payload && payload.kind === 'load') {
                    entry.onload && entry.onload({
                      status: payload.status || 0,
                      statusText: payload.statusText || '',
                      responseText: payload.responseText || ''
                    });
                  } else if (payload && payload.kind === 'timeout') {
                    entry.ontimeout && entry.ontimeout();
                  } else {
                    entry.onerror && entry.onerror();
                  }
                };
                globalThis.GM_getValue = (_k, def) => (cachedRaw ? cachedRaw : def);
                globalThis.GM_setValue = (_k, v) => {
                  cachedRaw = typeof v === 'string' ? v : JSON.stringify(v);
                  window.webkit?.messageHandlers?.nrBridge?.postMessage({ type: 'saveSettings', value: cachedRaw });
                };
                globalThis.GM_xmlhttpRequest = (opts) => {
                  const id = 'nr_' + (nextReqSeq++);
                  xhrCallbacks.set(id, opts || {});
                  window.webkit?.messageHandlers?.nrBridge?.postMessage({
                    type: 'xhr',
                    reqId: id,
                    method: opts?.method || 'POST',
                    url: String(opts?.url || ''),
                    headers: opts?.headers || {},
                    data: typeof opts?.data === 'string' ? opts.data : '',
                    timeout: Number(opts?.timeout || 30000)
                  });
                  return {
                    abort() {
                      xhrCallbacks.delete(id);
                    }
                  };
                };
              }
              globalThis.__NATIVEREAD_PREFER_GM_XHR__ = true;
              globalThis.__NATIVEREAD_AUTO_START__ = \(autoStart ? "true" : "false");
            })();
            """

            let fullScript = prelude + "\n" + scriptSource
            webView.evaluateJavaScript(fullScript, in: nil, in: .defaultClient) { [weak self] res in
                if case .failure(let err) = res {
                    self?.model.webStatusText = "注入失敗: \(err.localizedDescription)"
                } else {
                    self?.model.webStatusText = autoStart ? "自動翻譯啟動中..." : "就緒（可一鍵翻譯）"
                }
            }
        }

        func triggerTranslateInPage() {
            guard let webView else { return }
            webView.evaluateJavaScript(
                "if (typeof globalThis.__NATIVEREAD_RELOAD_SETTINGS__ === 'function') { Promise.resolve(globalThis.__NATIVEREAD_RELOAD_SETTINGS__()).then(() => { if (typeof globalThis.__NATIVEREAD_TRANSLATE_NOW__ === 'function') globalThis.__NATIVEREAD_TRANSLATE_NOW__(); }); }",
                in: nil,
                in: .defaultClient,
                completionHandler: nil
            )
            startStatusPolling()
        }

        func setDisplayModeInPage(_ mode: String) {
            guard let webView else { return }
            let clean = mode == "bilingual" || mode == "original" ? mode : "replace"
            webView.evaluateJavaScript(
                "if (typeof globalThis.__NATIVEREAD_SET_MODE__ === 'function') { globalThis.__NATIVEREAD_SET_MODE__('\(clean)'); }",
                in: nil,
                in: .defaultClient,
                completionHandler: nil
            )
        }

        private func startStatusPolling() {
            pollTimer?.invalidate()
            pollTimer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    self?.refreshStateFromPage()
                }
            }
        }

        private func refreshStateFromPage() {
            guard let webView else { return }
            webView.evaluateJavaScript(
                "typeof globalThis.__NATIVEREAD_GET_STATE__ === 'function' ? JSON.stringify(globalThis.__NATIVEREAD_GET_STATE__()) : ''",
                in: nil,
                in: .defaultClient
            ) { [weak self] result in
                guard let self,
                      case .success(let val) = result,
                      let str = val as? String,
                      !str.isEmpty,
                      let data = str.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return
                }
                let translating = (obj["isTranslating"] as? Bool) ?? false
                let done = (obj["totalTranslated"] as? Int) ?? 0
                let total = (obj["totalDetected"] as? Int) ?? 0
                let err = (obj["lastErrorMsg"] as? String) ?? ""
                self.model.isTranslating = translating
                if !err.isEmpty {
                    self.model.webStatusText = err
                } else if translating {
                    self.model.webStatusText = "翻譯中 \(done)/\(total)"
                } else if done > 0 {
                    self.model.webStatusText = "已譯 \(done) 段"
                } else {
                    self.model.webStatusText = "就緒"
                }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let msgType = body["type"] as? String else {
                return
            }
            if msgType == "saveSettings", let val = body["value"] as? String {
                _ = NativeReadStore.saveValidatedRawJsonIfNewer(val)
                model.reloadFromStore()
                return
            }
            if msgType == "xhr" {
                handleNativeXhr(body)
            }
        }

        private func handleNativeXhr(_ body: [String: Any]) {
            let reqId = (body["reqId"] as? String) ?? ""
            let urlStr = (body["url"] as? String) ?? ""
            let method = (body["method"] as? String) ?? "POST"
            let headers = (body["headers"] as? [String: String]) ?? [:]
            let dataStr = (body["data"] as? String) ?? ""
            let timeoutSec = max(5.0, min(60.0, ((body["timeout"] as? Double) ?? 30000.0) / 1000.0))

            guard !reqId.isEmpty,
                  let url = URL(string: urlStr),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" else {
                emitXhrCallback(reqId: reqId, payload: ["kind": "error"])
                return
            }

            var req = URLRequest(url: url, timeoutInterval: timeoutSec)
            req.httpMethod = method
            for (k, v) in headers {
                req.setValue(v, forHTTPHeaderField: k)
            }
            if !dataStr.isEmpty {
                req.httpBody = dataStr.data(using: .utf8)
            }

            Task.detached {
                do {
                    let (data, response) = try await URLSession.shared.data(for: req)
                    let http = response as? HTTPURLResponse
                    let status = http?.statusCode ?? 200
                    let statusText = HTTPURLResponse.localizedString(forStatusCode: status)
                    let text = String(data: data, encoding: .utf8) ?? ""
                    await MainActor.run {
                        self.emitXhrCallback(reqId: reqId, payload: [
                            "kind": "load",
                            "status": status,
                            "statusText": statusText,
                            "responseText": text
                        ])
                    }
                } catch let urlErr as URLError where urlErr.code == .timedOut {
                    await MainActor.run {
                        self.emitXhrCallback(reqId: reqId, payload: ["kind": "timeout"])
                    }
                } catch {
                    await MainActor.run {
                        self.emitXhrCallback(reqId: reqId, payload: ["kind": "error"])
                    }
                }
            }
        }

        private func emitXhrCallback(reqId: String, payload: [String: Any]) {
            guard let webView,
                  let reqData = try? JSONSerialization.data(withJSONObject: [reqId]),
                  let payloadData = try? JSONSerialization.data(withJSONObject: payload),
                  let reqJson = String(data: reqData, encoding: .utf8),
                  let payloadJson = String(data: payloadData, encoding: .utf8) else {
                return
            }
            let js = "if (typeof globalThis.__NR_NATIVE_RESOLVE_XHR__ === 'function') { globalThis.__NR_NATIVE_RESOLVE_XHR__((\(reqJson))[0], \(payloadJson)); }"
            webView.evaluateJavaScript(js, in: nil, in: .defaultClient, completionHandler: nil)
        }
    }
}
#endif
