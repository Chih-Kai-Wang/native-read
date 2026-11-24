---
name: nr-code-security-review
description: >-
  Gate 3 (Independent Code & Security Review) for NativeRead. Audits git diffs for
  MV3 security boundaries, async lifecycle leaks, DOM/key safety, translation/PDF
  invariants, and multi-surface parity before QA or shipping.
---

# Gate 3: Independent Code & Security Audit (`nr-code-security-review`)

Perform this adversarial diff review after implementation/tests and before final QA/push. Treat every diff line as suspect until verified.

## Audit Lenses

1. **MV3 Security & Sender Trust**
   - Privileged `runtime.onMessage` / `runtime.onConnect` handlers (`OPEN_PDF_VIEWER`, `CLEAR_CACHE`, `GET_SW_DEBUG`, `kct-pdf-fetch`, `kct-stream`) must validate `isExtensionSender(sender)` and disconnect untrusted senders immediately.
   - Verify `manifest.json` has zero static `content_scripts`, zero `web_accessible_resources`, and no unnecessary permission creep.
   - Verify zero forbidden DOM/eval sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`) across source and `docs/`.
   - Verify `redactAllKeys` / `sanitizeApiKey` cover primary, fallback, and `providerProfiles` keys with zero key logging.
2. **Async Lifecycles & Resource Cleanup**
   - Check `AbortController`, `port.onDisconnect`, temporary background `chrome.tabs.create`, `clearTimeout`, and `try ... finally` paths for leaked tabs, dangling listeners, or uncancelled timers.
   - Check concurrent settings updates (`enqueueSave` / `saveSettings`) and IndexedDB writes for race conditions.
3. **Translation, PDF & Compliance Invariants**
   - Verify no CAPTCHA, Turnstile, proof-of-work, or login-wall bypasses exist.
   - Verify `%PDF-` header checks, `100 MB` size caps, `fileAccess=denied` preservation, placeholder (`[[C#]]`/`[[M#]]`/`[[L#]]`) integrity, and per-provider cooldown isolation.
4. **Cross-Surface Parity & Scope Hygiene**
   - Confirm `docs/` generated artifacts match source via `node scripts/build-mobile.js`.
   - Confirm no duplicate helper logic, unrelated refactors, or stray debug artifacts in `git diff`.

## Output Format
Classify any issue by severity:
- **P0 (Critical Security/Data Loss/Invariant Break)** or **P1 (Functional Bug/Leak/Parity Drift)** -> **Block ship and fix immediately** (then re-run Gate 2 regression test + Gate 4 QA).
- **P2 (Minor Cleanup)** -> Fix if low-risk or note concisely.
