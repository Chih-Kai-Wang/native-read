---
name: nr-tdd-bugfix
description: >-
  Gate 2 (Engineering & TDD Bugfix) for NativeRead. Enforces systematic root-cause
  tracing, recurring failure-mode cross-checks, and a mandatory failing-then-passing
  regression test for every bug fix.
---

# Gate 2: Engineering & TDD Bugfix (`nr-tdd-bugfix`)

Follow this discipline whenever fixing a bug or changing core NativeRead logic.

## Procedure

1. **Reproduce & Trace Root Cause First**
   - Read the exact code paths across `shared/`, `background/`, `content/`, `viewer/`, `popup/`, `options/`, and `docs/` before proposing edits. Never guess from memory or symptoms.
2. **Cross-Check NativeRead's Recurring Failure Catalog**
   - **MV3 SW & Messaging**: Does `sender?.tab` shadow an explicit `message.tabId` when sent from an extension tab (`popup.html`, E2E harness)? Can Service Worker hibernation wipe in-memory state? Do ports/tabs leak on disconnect or timeout?
   - **Storage & IndexedDB Races**: Are `saveSettings` writes serialized? Does `CacheDB` handle hung `openDB` timeouts and `QuotaExceededError` eviction cleanly?
   - **Streaming & Provider Failover**: Are `kct-stream` / multi-object / pretty-printed SSE JSON responses parsed once without duplicate emission or double-billing? Does HTTP `401`/`403` trip the circuit breaker cleanly and redact raw keys across `providerProfiles`?
   - **PDF & Layout Extraction**: Are `SameSite=Strict/Lax`, `Referer`, `Sec-Fetch-Site`, and `%PDF-` magic headers handled? Are layout rows preserved without merging distinct blocks or hallucinating/echoing untranslatable segments? Are `[[C#]]`/`[[M#]]`/`[[L#]]` placeholders intact?
   - **Cross-Surface Drift**: If editing `shared/config.js`, `content/`, or `shared/pdf-layout.mjs`, remember `scripts/build-mobile.js` regenerates `docs/providers.js`, `docs/nativeread.user.js`, and `docs/nativeread-android-extension.zip`.
3. **Mandatory Regression Test (Red -> Green)**
   - **Every bug fix MUST add a regression test** in `tests/*.test.mjs` (registered in `scripts/verify.mjs`) and/or `tests/e2e/` that reproduces the failure condition first.
   - Run the new test to confirm it fails (or verifies exact contract if testing live DOM wiring), then apply the minimal, cohesive fix (sharing helpers instead of duplicating blocks).
4. **Verify Locally Before Gate 3**
   - Run `node scripts/build-mobile.js && node scripts/verify.mjs` and confirm all unit/contract tests pass.
