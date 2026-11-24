//
//  NativeReadStore.swift
//  Shared across App and Safari Web Extension targets
//

import Foundation

nonisolated enum NativeReadStore {
    static let appGroupID = "group.com.chihkaiwang.nativeread"
    static let settingsKey = "kct_settings_v1"

    struct ProviderPresetInfo: Sendable {
        let id: String
        let label: String
        let defaultProtocol: String
        let defaultBaseUrl: String
        let defaultModel: String
    }

    static let presets: [ProviderPresetInfo] = [
        ProviderPresetInfo(id: "gemini", label: "Google Gemini", defaultProtocol: "gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-3.5-flash-lite"),
        ProviderPresetInfo(id: "anthropic", label: "Anthropic Claude", defaultProtocol: "anthropic", defaultBaseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-5-5"),
        ProviderPresetInfo(id: "openai", label: "OpenAI", defaultProtocol: "openai", defaultBaseUrl: "https://api.openai.com/v1", defaultModel: ""),
        ProviderPresetInfo(id: "openrouter", label: "OpenRouter", defaultProtocol: "openai", defaultBaseUrl: "https://openrouter.ai/api/v1", defaultModel: "google/gemini-2.5-flash"),
        ProviderPresetInfo(id: "groq", label: "Groq", defaultProtocol: "openai", defaultBaseUrl: "https://api.groq.com/openai/v1", defaultModel: ""),
        ProviderPresetInfo(id: "deepseek", label: "DeepSeek", defaultProtocol: "openai", defaultBaseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat"),
        ProviderPresetInfo(id: "qwen", label: "Alibaba Qwen", defaultProtocol: "openai", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: ""),
        ProviderPresetInfo(id: "zhipu", label: "Zhipu GLM", defaultProtocol: "openai", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: ""),
        ProviderPresetInfo(id: "moonshot", label: "Moonshot Kimi", defaultProtocol: "openai", defaultBaseUrl: "https://api.moonshot.cn/v1", defaultModel: ""),
        ProviderPresetInfo(id: "ollama", label: "Ollama (本機)", defaultProtocol: "openai", defaultBaseUrl: "http://127.0.0.1:11434/v1", defaultModel: ""),
        ProviderPresetInfo(id: "custom", label: "自訂 OpenAI 相容端點", defaultProtocol: "openai", defaultBaseUrl: "", defaultModel: "")
    ]

    static let targetLanguages: [(id: String, label: String)] = [
        ("zh-TW", "繁體中文"),
        ("zh-CN", "简体中文"),
        ("ja", "日本語"),
        ("ko", "한국어"),
        ("en", "English")
    ]

    private static var sharedDefaults: UserDefaults {
        UserDefaults(suiteName: appGroupID) ?? .standard
    }

    static func preset(for id: String) -> ProviderPresetInfo {
        presets.first(where: { $0.id == id }) ?? presets[0]
    }

    static func loadRawJson() -> String? {
        if let raw = sharedDefaults.string(forKey: settingsKey), !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return raw
        }
        if let fallback = UserDefaults.standard.string(forKey: settingsKey), !fallback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return fallback
        }
        return nil
    }

    static func saveRawJson(_ json: String) {
        sharedDefaults.set(json, forKey: settingsKey)
        sharedDefaults.synchronize()
        UserDefaults.standard.set(json, forKey: settingsKey)
    }

    static func loadSettingsDict() -> [String: Any] {
        guard let raw = loadRawJson(),
              let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            let gem = preset(for: "gemini")
            return [
                "providerId": gem.id,
                "protocol": gem.defaultProtocol,
                "baseUrl": gem.defaultBaseUrl,
                "apiKey": "",
                "model": gem.defaultModel,
                "targetLang": "zh-TW",
                "displayMode": "replace",
                "thinkingEffort": "fastest",
                "typographyMatch": "native"
            ]
        }
        return obj
    }

    static func isLocalEndpoint(_ urlString: String) -> Bool {
        guard let url = URL(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host?.lowercased() else {
            return false
        }
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".local")
    }

    static func sanitizeApiKey(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func validateApiKey(_ raw: String) -> (ok: Bool, clean: String, error: String?) {
        let clean = sanitizeApiKey(raw)
        if clean.isEmpty {
            return (true, "", nil)
        }
        for scalar in clean.unicodeScalars {
            if scalar.value <= 0x20 || scalar.value >= 0x7F {
                return (false, clean, "API 金鑰包含空白或非 ASCII 字元")
            }
        }
        return (true, clean, nil)
    }

    static func isConfigured(_ dict: [String: Any]? = nil) -> Bool {
        let d = dict ?? loadSettingsDict()
        let key = sanitizeApiKey(d["apiKey"] as? String ?? "")
        let baseUrl = (d["baseUrl"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let model = (d["model"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty { return true }
        return isLocalEndpoint(baseUrl) && !model.isEmpty
    }

    static func extractSyncToken(from rawInput: String) -> String? {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let range = trimmed.range(of: #"(?:^|[#&])nr_sync=([A-Za-z0-9_%-]+)"#, options: .regularExpression) {
            let matched = String(trimmed[range])
            if let eqRange = matched.range(of: "nr_sync=") {
                let rawToken = String(matched[eqRange.upperBound...])
                return rawToken.removingPercentEncoding ?? rawToken
            }
        }

        if trimmed.range(of: #"^[A-Za-z0-9_-]{12,}={0,2}$"#, options: .regularExpression) != nil {
            return trimmed
        }
        return nil
    }

    private static func decodeBase64UrlJson(_ token: String) -> [String: Any]? {
        var b64 = token
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let rem = b64.count % 4
        if rem > 0 {
            b64 += String(repeating: "=", count: 4 - rem)
        }
        guard let data = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return obj
    }

    @discardableResult
    static func importSyncInput(_ rawInput: String) -> Bool {
        guard let token = extractSyncToken(from: rawInput),
              let payload = decodeBase64UrlJson(token) else {
            return false
        }
        return applyPayload(payload)
    }

    @discardableResult
    static func saveValidatedRawJsonIfNewer(_ rawJson: String) -> Bool {
        guard let data = rawJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        return applyPayload(obj)
    }

    @discardableResult
    static func applyPayload(_ payload: [String: Any]) -> Bool {
        let rawPid = String((payload["providerId"] as? String) ?? (payload["p"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = rawPid.isEmpty ? "gemini" : (presets.contains(where: { $0.id == rawPid }) ? rawPid : "custom")
        let pInfo = preset(for: pid)

        let rawProto = String((payload["protocol"] as? String) ?? (payload["r"] as? String) ?? pInfo.defaultProtocol)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard ["openai", "gemini", "anthropic"].contains(rawProto) else { return false }

        let baseUrl = String((payload["baseUrl"] as? String) ?? (payload["u"] as? String) ?? pInfo.defaultBaseUrl)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsedUrl = URL(string: baseUrl),
              let scheme = parsedUrl.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return false
        }

        let rawKeyObj = payload["apiKey"] ?? payload["k"]
        let rawKey = (rawKeyObj as? String) ?? ""
        let keyCheck = validateApiKey(rawKey)
        guard keyCheck.ok else { return false }

        let model = String((payload["model"] as? String) ?? (payload["m"] as? String) ?? pInfo.defaultModel)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if keyCheck.clean.isEmpty && !(isLocalEndpoint(baseUrl) && !model.isEmpty) {
            return false
        }

        let rawLang = String((payload["targetLang"] as? String) ?? (payload["l"] as? String) ?? "zh-TW")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let targetLang = rawLang.isEmpty ? "zh-TW" : rawLang
        let customLang = String((payload["customTargetLang"] as? String) ?? (payload["c"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let rawEffort = String((payload["thinkingEffort"] as? String) ?? (payload["e"] as? String) ?? "fastest")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let effort = ["fastest", "balanced", "deep"].contains(rawEffort) ? rawEffort : "fastest"
        let rawTypo = String((payload["typographyMatch"] as? String) ?? (payload["t"] as? String) ?? "native")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let typography = ["native", "system", "preserve"].contains(rawTypo) ? rawTypo : "native"

        var current = loadSettingsDict()
        var profiles = (current["providerProfiles"] as? [String: [String: Any]]) ?? [:]
        if let incomingProfiles = payload["providerProfiles"] as? [String: [String: Any]] {
            for (k, v) in incomingProfiles {
                profiles[k] = v
            }
        }
        profiles[pid] = [
            "protocol": rawProto,
            "baseUrl": baseUrl,
            "apiKey": keyCheck.clean,
            "model": model
        ]

        current["providerId"] = pid
        current["protocol"] = rawProto
        current["baseUrl"] = baseUrl
        current["apiKey"] = keyCheck.clean
        current["model"] = model
        current["providerProfiles"] = profiles
        current["targetLang"] = targetLang
        if !customLang.isEmpty || targetLang == "custom" {
            current["customTargetLang"] = customLang
        }
        current["thinkingEffort"] = effort
        current["typographyMatch"] = typography

        if let incomingTs = payload["syncedAt"] as? NSNumber, incomingTs.doubleValue > 0 {
            current["syncedAt"] = incomingTs.doubleValue
        } else {
            current["syncedAt"] = Date().timeIntervalSince1970 * 1000.0
        }

        guard let encoded = try? JSONSerialization.data(withJSONObject: current),
              let jsonStr = String(data: encoded, encoding: .utf8) else {
            return false
        }
        saveRawJson(jsonStr)
        return true
    }

    static func saveManual(
        providerId: String,
        protocolType: String,
        baseUrl: String,
        apiKey: String,
        model: String,
        targetLang: String
    ) -> Result<Void, NSError> {
        let cleanBase = baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: cleanBase),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return .failure(NSError(domain: "NativeReadStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "Base URL 必須為 http:// 或 https://"]))
        }
        let keyCheck = validateApiKey(apiKey)
        guard keyCheck.ok else {
            return .failure(NSError(domain: "NativeReadStore", code: 2, userInfo: [NSLocalizedDescriptionKey: keyCheck.error ?? "金鑰格式錯誤"]))
        }
        let cleanModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if keyCheck.clean.isEmpty && !(isLocalEndpoint(cleanBase) && !cleanModel.isEmpty) {
            return .failure(NSError(domain: "NativeReadStore", code: 3, userInfo: [NSLocalizedDescriptionKey: "請填寫有效的 API Key"]))
        }

        let payload: [String: Any] = [
            "providerId": providerId,
            "protocol": protocolType,
            "baseUrl": cleanBase,
            "apiKey": keyCheck.clean,
            "model": cleanModel,
            "targetLang": targetLang,
            "syncedAt": Date().timeIntervalSince1970 * 1000.0
        ]
        _ = applyPayload(payload)
        return .success(())
    }
}
