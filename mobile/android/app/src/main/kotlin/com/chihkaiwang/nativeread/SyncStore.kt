package com.chihkaiwang.nativeread

import android.content.Context
import android.net.Uri
import android.util.Base64
import org.json.JSONObject
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

data class ProviderPreset(
    val id: String,
    val label: String,
    val protocol: String,
    val baseUrl: String,
    val defaultModel: String,
)

class SyncStore(context: Context) {
    companion object {
        const val PREFS_NAME = "nativeread_prefs"
        const val SETTINGS_KEY = "kct_settings_v1"

        val PRESETS = listOf(
            ProviderPreset("gemini", "Google Gemini", "gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini-3.5-flash-lite"),
            ProviderPreset("anthropic", "Anthropic Claude", "anthropic", "https://api.anthropic.com/v1", "claude-sonnet-5-5"),
            ProviderPreset("openai", "OpenAI", "openai", "https://api.openai.com/v1", ""),
            ProviderPreset("openrouter", "OpenRouter", "openai", "https://openrouter.ai/api/v1", "google/gemini-2.5-flash"),
            ProviderPreset("groq", "Groq", "openai", "https://api.groq.com/openai/v1", ""),
            ProviderPreset("deepseek", "DeepSeek", "openai", "https://api.deepseek.com/v1", "deepseek-chat"),
            ProviderPreset("qwen", "Alibaba Qwen", "openai", "https://dashscope.aliyuncs.com/compatible-mode/v1", ""),
            ProviderPreset("zhipu", "Zhipu GLM", "openai", "https://open.bigmodel.cn/api/paas/v4", ""),
            ProviderPreset("moonshot", "Moonshot Kimi", "openai", "https://api.moonshot.cn/v1", ""),
            ProviderPreset("ollama", "Ollama (本機)", "openai", "http://127.0.0.1:11434/v1", ""),
            ProviderPreset("custom", "自訂 OpenAI 相容端點", "openai", "", ""),
        )

        val TARGET_LANGUAGES = listOf(
            "zh-TW" to "繁體中文",
            "zh-CN" to "简体中文",
            "ja" to "日本語",
            "ko" to "한국어",
            "en" to "English",
        )

        fun presetFor(id: String): ProviderPreset =
            PRESETS.firstOrNull { it.id == id } ?: PRESETS.first()

        fun isLocalEndpoint(urlStr: String): Boolean {
            val host = runCatching { Uri.parse(urlStr.trim()).host?.lowercase().orEmpty() }.getOrDefault("")
            return host == "localhost" || host == "127.0.0.1" || host == "::1" || host.endsWith(".local")
        }

        fun validateApiKey(raw: String): Pair<Boolean, String> {
            val clean = raw.trim()
            if (clean.isEmpty()) return true to ""
            for (ch in clean) {
                val code = ch.code
                if (code <= 0x20 || code >= 0x7F) {
                    return false to "API 金鑰包含空白或非 ASCII 字元"
                }
            }
            return true to clean
        }

        fun extractSyncToken(rawInput: String): String? {
            val text = rawInput.trim()
            if (text.isEmpty()) return null
            val match = Regex("""(?:^|[#&])nr_sync=([A-Za-z0-9_%-]+)""").find(text)
            if (match != null) {
                val token = match.groupValues[1]
                return runCatching { URLDecoder.decode(token, "UTF-8") }.getOrDefault(token)
            }
            if (Regex("""^[A-Za-z0-9_-]{12,}={0,2}$""").matches(text)) {
                return text
            }
            return null
        }

        fun decodeBase64UrlJson(token: String): JSONObject? {
            return runCatching {
                val b64 = token.trim().replace('-', '+').replace('_', '/')
                val padded = b64 + "===".substring(0, (4 - (b64.length % 4)) % 4)
                val bytes = Base64.decode(padded, Base64.DEFAULT)
                JSONObject(String(bytes, StandardCharsets.UTF_8))
            }.getOrNull()
        }
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun loadRawJson(): String? {
        val raw = prefs.getString(SETTINGS_KEY, null)
        return if (raw.isNullOrBlank()) null else raw
    }

    fun loadSettingsJson(): JSONObject {
        val raw = loadRawJson()
        if (raw != null) {
            runCatching { return JSONObject(raw) }
        }
        val gem = presetFor("gemini")
        return JSONObject().apply {
            put("providerId", gem.id)
            put("protocol", gem.protocol)
            put("baseUrl", gem.baseUrl)
            put("apiKey", "")
            put("model", gem.defaultModel)
            put("targetLang", "zh-TW")
            put("displayMode", "replace")
            put("thinkingEffort", "fastest")
            put("typographyMatch", "native")
            put("providerProfiles", JSONObject())
        }
    }

    fun isConfigured(obj: JSONObject = loadSettingsJson()): Boolean {
        val key = obj.optString("apiKey", "").trim()
        val baseUrl = obj.optString("baseUrl", "").trim()
        val model = obj.optString("model", "").trim()
        if (key.isNotEmpty()) return true
        return isLocalEndpoint(baseUrl) && model.isNotEmpty()
    }

    fun importSyncToken(rawInput: String): Boolean {
        val token = extractSyncToken(rawInput) ?: return false
        val payload = decodeBase64UrlJson(token) ?: return false
        return applyPayload(payload)
    }

    fun saveRawValidated(rawJson: String): Boolean {
        val parsed = runCatching { JSONObject(rawJson) }.getOrNull() ?: return false
        return applyPayload(parsed)
    }

    fun saveManual(
        providerId: String,
        protocol: String,
        baseUrl: String,
        apiKey: String,
        model: String,
        targetLang: String,
    ): Result<Unit> {
        val cleanBase = baseUrl.trim()
        val uri = runCatching { Uri.parse(cleanBase) }.getOrNull()
        val scheme = uri?.scheme?.lowercase().orEmpty()
        if (scheme != "http" && scheme != "https" || uri?.host.isNullOrBlank()) {
            return Result.failure(IllegalArgumentException("Base URL 必須為有效的 http:// 或 https:// 網址"))
        }
        val (keyOk, cleanKeyOrErr) = validateApiKey(apiKey)
        if (!keyOk) {
            return Result.failure(IllegalArgumentException(cleanKeyOrErr))
        }
        val cleanModel = model.trim()
        if (cleanKeyOrErr.isEmpty() && !(isLocalEndpoint(cleanBase) && cleanModel.isNotEmpty())) {
            return Result.failure(IllegalArgumentException("請填寫有效的 API Key"))
        }
        val payload = JSONObject().apply {
            put("providerId", providerId)
            put("protocol", protocol)
            put("baseUrl", cleanBase)
            put("apiKey", cleanKeyOrErr)
            put("model", cleanModel)
            put("targetLang", targetLang)
            put("syncedAt", System.currentTimeMillis())
        }
        return if (applyPayload(payload)) {
            Result.success(Unit)
        } else {
            Result.failure(IllegalArgumentException("無法儲存設定"))
        }
    }

    fun applyPayload(payload: JSONObject): Boolean {
        val rawPid = (payload.optString("providerId").ifBlank { payload.optString("p") }).trim()
        val pid = if (rawPid.isEmpty()) "gemini" else if (PRESETS.any { it.id == rawPid }) rawPid else "custom"
        val preset = presetFor(pid)

        val proto = (payload.optString("protocol").ifBlank { payload.optString("r").ifBlank { preset.protocol } })
            .trim()
            .lowercase()
        if (proto != "openai" && proto != "gemini" && proto != "anthropic") return false

        val baseUrl = (payload.optString("baseUrl").ifBlank { payload.optString("u").ifBlank { preset.baseUrl } }).trim()
        val uri = runCatching { Uri.parse(baseUrl) }.getOrNull() ?: return false
        val scheme = uri.scheme?.lowercase().orEmpty()
        if ((scheme != "http" && scheme != "https") || uri.host.isNullOrBlank()) return false

        val rawKey = if (payload.has("apiKey")) payload.optString("apiKey", "") else payload.optString("k", "")
        val (keyOk, cleanKey) = validateApiKey(rawKey)
        if (!keyOk) return false

        val model = (payload.optString("model").ifBlank { payload.optString("m").ifBlank { preset.defaultModel } }).trim()
        if (cleanKey.isEmpty() && !(isLocalEndpoint(baseUrl) && model.isNotEmpty())) {
            return false
        }

        val targetLang = (payload.optString("targetLang").ifBlank { payload.optString("l").ifBlank { "zh-TW" } }).trim()
        val customLang = (payload.optString("customTargetLang").ifBlank { payload.optString("c") }).trim()
        val rawEffort = (payload.optString("thinkingEffort").ifBlank { payload.optString("e").ifBlank { "fastest" } }).trim()
        val effort = if (rawEffort == "balanced" || rawEffort == "deep") rawEffort else "fastest"
        val rawTypo = (payload.optString("typographyMatch").ifBlank { payload.optString("t").ifBlank { "native" } }).trim()
        val typography = if (rawTypo == "system" || rawTypo == "preserve") rawTypo else "native"
        val syncedAt = payload.optLong("syncedAt", 0L).let { if (it > 0L) it else System.currentTimeMillis() }

        val current = loadSettingsJson()
        val profiles = current.optJSONObject("providerProfiles") ?: JSONObject()
        payload.optJSONObject("providerProfiles")?.let { incoming ->
            val keys = incoming.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                incoming.optJSONObject(k)?.let { profiles.put(k, it) }
            }
        }
        profiles.put(
            pid,
            JSONObject().apply {
                put("protocol", proto)
                put("baseUrl", baseUrl)
                put("apiKey", cleanKey)
                put("model", model)
            },
        )

        current.put("providerId", pid)
        current.put("protocol", proto)
        current.put("baseUrl", baseUrl)
        current.put("apiKey", cleanKey)
        current.put("model", model)
        current.put("providerProfiles", profiles)
        current.put("targetLang", targetLang)
        if (customLang.isNotEmpty() || targetLang == "custom") {
            current.put("customTargetLang", customLang)
        }
        current.put("thinkingEffort", effort)
        current.put("typographyMatch", typography)
        if (payload.has("displayMode")) {
            val dm = payload.optString("displayMode", "replace")
            if (dm == "replace" || dm == "bilingual" || dm == "original") {
                current.put("displayMode", dm)
            }
        }
        if (payload.has("autoTranslateHosts")) {
            payload.optJSONArray("autoTranslateHosts")?.let { current.put("autoTranslateHosts", it) }
        }
        current.put("syncedAt", syncedAt)

        prefs.edit().putString(SETTINGS_KEY, current.toString()).apply()
        return true
    }

    fun redactSecrets(text: String): String {
        var out = text
        val current = loadSettingsJson()
        val mainKey = current.optString("apiKey", "").trim()
        if (mainKey.length >= 6) {
            out = out.replace(mainKey, "[REDACTED]")
        }
        val profiles = current.optJSONObject("providerProfiles")
        if (profiles != null) {
            val keys = profiles.keys()
            while (keys.hasNext()) {
                val pk = profiles.optJSONObject(keys.next())?.optString("apiKey", "")?.trim().orEmpty()
                if (pk.length >= 6) {
                    out = out.replace(pk, "[REDACTED]")
                }
            }
        }
        return out
    }
}
