---
name: nr-browser-qa
description: >-
  Gate 4 (Real-Browser & E2E QA) for NativeRead. Defines the safe chrome://extensions
  reload sequence, Chromium live verification with ego-browser nodejs, settings/cache
  protection, and E2E test execution before release.
---

# Gate 4: Real-Browser & E2E QA (`nr-browser-qa`)

Run this gate after Gates 2–3 whenever extension runtime, UI (`popup/`, `options/`, `viewer/`), `content/`, `background/`, `shared/`, or `docs/` files change.

## Mandatory Guardrails
- **Live Extension Reload**: ALWAYS click `#dev-reload-button` inside `chrome://extensions/` shadow DOM for extension ID `ckeknfhpandgmippabbfkndmndainpff`, wait ~1.2s, and verify `chrome.runtime.getManifest().version` + `chrome.runtime.sendMessage({ type: 'GET_SW_DEBUG' })`. **NEVER** use `chrome.runtime.reload()` (it leaves the MV3 Service Worker unregistered in Chromium automation).
- **Preserve Real User State**: Never read, print, or overwrite the user's real API key or clear their IndexedDB cache (`kct_cache_db_v2`). Any browser test that touches `kct_settings_v1` must run through `tests/e2e/run.js` (`armSettingsGuard` / `finalizeSettingsGuard`).
- **Always Clean Up**: Wrap every `ego-browser nodejs` run in `try { ... } finally { await task.finish({ keep: [] }); server?.closeAllConnections?.(); server?.close(); }`. If writing probe JSON to `<appDataDir>/brain/<id>/scratch/*.json`, `cat` and `rm -f` it in the same shell command so no temp files remain.
- **Live Tab Cross-Talk Awareness**: Never close a user's open tabs or reload the extension while the user has an active `viewer/pdf-viewer.html` tab they are reading; note that open `pdf-viewer.html` tabs listen to `chrome.storage.onChanged` and can send requests to local mock LLM servers during `kct_settings_v1` E2E tests.

## Verification Sequence

1. **Build & Static/Unit Suite**:
   ```bash
   node scripts/build-mobile.js && node scripts/verify.mjs
   ```
2. **Live Chromium Flow Checks (when runtime/UI/PDF/SW changed)**:
   - Exercise real flows with a local test server (e.g., Popup `380x600`, Mobile PWA `390x844`, `pdf-viewer.html`, Tier 1/3 PDF bridge, login-wall fallback).
   - For PDF viewer assertions, allow at least `20000ms` because cold `vendor/pdfjs/pdf.worker.min.mjs` initialization in the extension origin takes ~3.7–6.2s.
   - Assert rendered output (`!pagesContainer.hidden && canvases >= 1`), zero console/page errors, and zero leaked tabs (`task.tabs()`).
3. **E2E Suite**:
   ```bash
   node tests/e2e/run.js --suite invariants-docs --tier 1
   ```
   Confirm `failed=0`, `infra=0`, and `[GUARD] Settings restored and verified`.
4. **Final Post-Edit Re-Verification**:
   If any code was touched during QA, re-run `node scripts/verify.mjs` after the final edit.
