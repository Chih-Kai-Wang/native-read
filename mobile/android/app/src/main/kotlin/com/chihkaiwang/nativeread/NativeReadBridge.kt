package com.chihkaiwang.nativeread

import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class NativeReadBridge(
    private val syncStore: SyncStore,
    private val webViewProvider: () -> WebView?,
    private val onSettingsSaved: () -> Unit,
) {
    companion object {
        private const val TAG = "NativeReadBridge"
    }

    private val secureRandom = SecureRandom()
    private val executor = Executors.newCachedThreadPool()
    private val activeConnections = ConcurrentHashMap<String, HttpURLConnection>()
    private val validNonces: MutableSet<String> = Collections.synchronizedSet(LinkedHashSet())

    @Volatile
    var currentNonce: String = generateAndTrackNonce()
        private set

    private fun generateAndTrackNonce(): String {
        val bytes = ByteArray(16)
        secureRandom.nextBytes(bytes)
        val next = bytes.joinToString("") { "%02x".format(it) }
        synchronized(validNonces) {
            validNonces.add(next)
            while (validNonces.size > 4) {
                val it = validNonces.iterator()
                if (it.hasNext()) {
                    it.next()
                    it.remove()
                }
            }
        }
        return next
    }

    fun rotateNonce(): String {
        val next = generateAndTrackNonce()
        currentNonce = next
        return next
    }

    private fun isValidNonce(nonce: String?): Boolean {
        if (nonce.isNullOrEmpty()) return false
        return synchronized(validNonces) { validNonces.contains(nonce) }
    }

    @JavascriptInterface
    fun getSettings(nonce: String?): String {
        if (!isValidNonce(nonce)) return ""
        return syncStore.loadRawJson().orEmpty()
    }

    @JavascriptInterface
    fun saveSettings(nonce: String?, json: String?): Boolean {
        if (!isValidNonce(nonce) || json.isNullOrBlank()) return false
        val ok = syncStore.saveRawValidated(json)
        if (ok) {
            webViewProvider()?.post { onSettingsSaved() }
        }
        return ok
    }

    @JavascriptInterface
    fun abortXhr(nonce: String?, reqId: String?) {
        if (!isValidNonce(nonce) || reqId.isNullOrBlank()) return
        activeConnections.remove(reqId)?.let { conn ->
            executor.execute { runCatching { conn.disconnect() } }
        }
    }

    @JavascriptInterface
    fun xhr(nonce: String?, reqId: String?, reqJson: String?) {
        if (nonce.isNullOrEmpty() || reqId.isNullOrBlank()) return
        if (!isValidNonce(nonce)) {
            Log.w(TAG, "Rejected XHR due to expired/invalid nonce")
            dispatchXhrEvent(
                nonce,
                reqId,
                JSONObject().apply {
                    put("kind", "error")
                    put("message", "Bridge session rotated")
                },
            )
            return
        }
        if (reqJson.isNullOrBlank()) {
            dispatchXhrEvent(nonce, reqId, JSONObject().apply { put("kind", "error") })
            return
        }

        executor.execute {
            val reqObj = runCatching { JSONObject(reqJson) }.getOrNull()
            if (reqObj == null) {
                dispatchXhrEvent(nonce, reqId, JSONObject().apply { put("kind", "error") })
                return@execute
            }

            val urlStr = reqObj.optString("url", "").trim()
            val method = reqObj.optString("method", "POST").ifBlank { "POST" }
            val data = reqObj.optString("data", "")
            val timeoutMs = reqObj.optInt("timeout", 30000).coerceIn(5000, 60000)

            val parsedUrl = runCatching { URL(urlStr) }.getOrNull()
            val protocol = parsedUrl?.protocol?.lowercase().orEmpty()
            if (parsedUrl == null || (protocol != "http" && protocol != "https")) {
                dispatchXhrEvent(nonce, reqId, JSONObject().apply { put("kind", "error") })
                return@execute
            }

            Log.i(TAG, "xhr $method ${parsedUrl.host}")

            var conn: HttpURLConnection? = null
            try {
                conn = (parsedUrl.openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = timeoutMs
                    readTimeout = timeoutMs
                    useCaches = false
                    doInput = true
                }
                activeConnections[reqId] = conn

                reqObj.optJSONObject("headers")?.let { hdrs ->
                    val keys = hdrs.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        conn.setRequestProperty(k, hdrs.optString(k, ""))
                    }
                }

                if (data.isNotEmpty() || method.equals("POST", ignoreCase = true)) {
                    conn.doOutput = true
                    OutputStreamWriter(conn.outputStream, StandardCharsets.UTF_8).use { writer ->
                        writer.write(data)
                        writer.flush()
                    }
                }

                val status = conn.responseCode
                val statusText = conn.responseMessage.orEmpty()
                val stream = if (status in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
                val responseText = if (stream != null) {
                    BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { it.readText() }
                } else {
                    ""
                }

                Log.i(TAG, "xhr $method ${parsedUrl.host} -> HTTP $status (${responseText.length} chars)")
                dispatchXhrEvent(
                    nonce,
                    reqId,
                    JSONObject().apply {
                        put("kind", "load")
                        put("status", status)
                        put("statusText", statusText)
                        put("responseText", responseText)
                    },
                )
            } catch (_: SocketTimeoutException) {
                Log.w(TAG, "xhr timeout ${parsedUrl.host}")
                dispatchXhrEvent(nonce, reqId, JSONObject().apply { put("kind", "timeout") })
            } catch (t: Throwable) {
                val safeMsg = syncStore.redactSecrets(t.message.orEmpty())
                Log.w(TAG, "xhr error ${parsedUrl.host}: $safeMsg")
                dispatchXhrEvent(
                    nonce,
                    reqId,
                    JSONObject().apply {
                        put("kind", "error")
                        put("message", safeMsg)
                    },
                )
            } finally {
                activeConnections.remove(reqId)
                runCatching { conn?.disconnect() }
            }
        }
    }

    private fun dispatchXhrEvent(nonce: String, reqId: String, payload: JSONObject) {
        val wv = webViewProvider() ?: return
        val dispatchKey = "__nrDisp_$nonce"
        val js = "try{globalThis[${JSONObject.quote(dispatchKey)}]?.(${JSONObject.quote(reqId)},$payload);}catch(_){}"
        wv.post {
            if (isValidNonce(nonce)) {
                wv.evaluateJavascript(js, null)
            }
        }
    }

    fun buildInjectionScript(autoStart: Boolean, userscriptBody: String): String {
        val nonce = currentNonce
        val dispatchKey = "__nrDisp_$nonce"
        return buildString {
            append("(function(){\n")
            append("if(globalThis.__NATIVEREAD_USERSCRIPT_BOOTED__){\n")
            append("  globalThis.__NATIVEREAD_PREFER_GM_XHR__=true;\n")
            append("  globalThis.__NATIVEREAD_AUTO_START__=").append(if (autoStart) "true" else "false").append(";\n")
            append("  Promise.resolve(globalThis.__NATIVEREAD_RELOAD_SETTINGS__?.()).then(function(){\n")
            if (autoStart) {
                append("    globalThis.__NATIVEREAD_TRANSLATE_NOW__?.();\n")
            }
            append("  });\n")
            append("  return;\n")
            append("}\n")
            append("const _NR_NONCE=").append(JSONObject.quote(nonce)).append(";\n")
            append("const _nrXhrs=new Map();let _nrSeq=1;\n")
            append("Object.defineProperty(globalThis,").append(JSONObject.quote(dispatchKey)).append(",{\n")
            append("  value:function(id,p){\n")
            append("    const h=_nrXhrs.get(id);if(!h)return;_nrXhrs.delete(id);\n")
            append("    if(p&&p.kind==='load'){h.onload&&h.onload({status:p.status||0,statusText:p.statusText||'',responseText:p.responseText||''});}\n")
            append("    else if(p&&p.kind==='timeout'){h.ontimeout&&h.ontimeout();}\n")
            append("    else{h.onerror&&h.onerror();}\n")
            append("  },enumerable:false,configurable:true\n")
            append("});\n")
            append("const GM_getValue=function(_k,def){try{const r=globalThis.NRAndroidBridge?globalThis.NRAndroidBridge.getSettings(_NR_NONCE):'';return r?r:def;}catch(_){return def;}};\n")
            append("const GM_setValue=function(_k,v){try{const s=typeof v==='string'?v:JSON.stringify(v);if(globalThis.NRAndroidBridge)globalThis.NRAndroidBridge.saveSettings(_NR_NONCE,s);}catch(_){}};\n")
            append("const GM_xmlhttpRequest=function(opts){\n")
            append("  const id='nr_'+(_nrSeq++);\n")
            append("  _nrXhrs.set(id,opts||{});\n")
            append("  try{globalThis.NRAndroidBridge.xhr(_NR_NONCE,id,JSON.stringify({\n")
            append("    url:String(opts?.url||''),method:opts?.method||'POST',headers:opts?.headers||{},\n")
            append("    data:typeof opts?.data==='string'?opts.data:'',timeout:Number(opts?.timeout||30000)\n")
            append("  }));}catch(_){}\n")
            append("  return{abort:function(){_nrXhrs.delete(id);try{globalThis.NRAndroidBridge.abortXhr(_NR_NONCE,id);}catch(_){}}};\n")
            append("};\n")
            append("globalThis.__NATIVEREAD_PREFER_GM_XHR__=true;\n")
            append("globalThis.__NATIVEREAD_AUTO_START__=").append(if (autoStart) "true" else "false").append(";\n")
            append(userscriptBody).append("\n")
            append("})();")
        }
    }
}
