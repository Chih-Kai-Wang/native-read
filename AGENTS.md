# NativeRead Engineering Operating System

NativeRead is a commercial-grade, privacy-first MV3 Chromium Extension, PDF.js Reader, Mobile PWA, and Universal Userscript (`v2.8.1`+; source of truth in `manifest.json`). All AI agents operating in this repository follow this lightweight **5-Gate Software Company Workflow** so bugs are prevented systematically and never recur.

> For trivial typo fixes or 1-line copy adjustments, run Gate 4 static verification (`node scripts/verify.mjs`) + Gate 5 auto-push without heavy ceremony. For any feature, bug fix, UX improvement, or refactor, follow all 5 gates in order.

---

## Operating Model — 5 Quality Gates

| Gate | Role | Skill (`.agents/skills/`) | When It Runs & Exit Criteria |
| :--- | :--- | :--- | :--- |
| **1. Product & UX Gate** | PM / Designer | `nr-product-ux-review` | **Before coding** any feature, UI, or flow change. Eliminates manual workarounds (e.g., manual downloads, burying frequent switches), ensures actionable error states, and checks Popup (`380px`), Options, PDF Viewer, Mobile PWA (`390px`), and Dark/Light themes. |
| **2. Engineering & TDD Gate** | Tech Lead / Dev | `nr-tdd-bugfix` | **During implementation & bug fixes.** Trace root cause first, inspect all affected surfaces, check recurring failure patterns, and **add a failing-then-passing regression test** in `tests/*.test.mjs` or `tests/e2e/` for every bug fix. |
| **3. Code & Security Audit Gate** | Reviewer / Security | `nr-code-security-review` | **Before verification/release.** Independent `git diff` audit for MV3 pitfalls (`sender.tab` shadowing `message.tabId`, SW hibernation, leaked background tabs/ports, `storage.local` races), Forbidden Sinks, key redaction, and cross-surface parity. Blocks ship on any P0/P1. |
| **4. Real-Browser QA Gate** | QA Engineer | `nr-browser-qa` | **Before commit/push.** Run `node scripts/build-mobile.js && node scripts/verify.mjs`. For runtime/UI/PDF/SW edits: reload extension `ckeknfhpandgmippabbfkndmndainpff` via `chrome://extensions/` `#dev-reload-button` (NEVER `chrome.runtime.reload()`), verify live Chromium flows + zero console errors + settings guard, and run `node tests/e2e/run.js --suite invariants-docs --tier 1`. |
| **5. Release & Auto-Push Gate** | Release Engineer | `nr-release-ship` | **After all checks pass.** Confirm clean `git status -s` (no stray files or secrets), commit with Conventional Commits (`feat(vX.Y.Z):`, `fix(vX.Y.Z):`, `chore(...):`), and **directly `git push origin main` without asking for confirmation**. |

---

## Non-Negotiable Invariants

1. **Zero Static Injection & Minimal Permissions**
   - Never add static `content_scripts` or `web_accessible_resources` to `manifest.json`.
   - `autoTranslate` defaults to `false`; injection happens on-demand via `chrome.scripting`.
2. **DOM & Code Execution Safety (Zero Forbidden Sinks)**
   - Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, or `new Function` in non-vendor source or `docs/`. Always build DOM nodes with `document.createElement`, `textContent`, or `replaceChildren`.
3. **Secret & Live User-Data Protection**
   - Never log, print, expose, or commit raw API keys (`sanitizeApiKey` + `redactAllKeys` must cover `providerProfiles`).
   - Never read/log the user's real key or wipe live `kct_settings_v1` / IndexedDB cache (`kct_cache_db_v2`) without `tests/e2e/lib/settings-guard.js` protection.
4. **No Auth / Anti-Bot Bypass**
   - Never solve, compute, or bypass CAPTCHAs, Turnstile, proof-of-work gates, or website login walls. Fail gracefully with a direct user action button (`前往原網頁開啟／登入`) and clean up any temporary tabs.
5. **Single Source of Truth & Multi-Surface Parity**
   - `manifest.json` (`version`) -> run `node scripts/build-mobile.js` to sync `docs/providers.js`, `docs/nativeread.user.js`, `docs/nativeread.meta.js`, `docs/version.json`, `docs/sw.js`, `docs/index.html`, `docs/pdf-layout.mjs`, and `docs/nativeread-android-extension.zip`.
   - User-facing extension/PWA releases bump `manifest.json` and update all 8 `README*.md` files (`README.md`, `README.zh-TW.md`, `README.zh-CN.md`, `README.ja.md`, `README.ko.md`, `README.es.md`, `README.fr.md`, `README.de.md`). Workflow/CI/test-only `chore` commits keep the current version intact.
6. **Standing Git Policy (Auto-Push After Verification)**
   - Once all applicable checks in Gates 3–4 pass cleanly, commit and push directly to `origin/main` without stopping to ask permission.

---

## Architecture & Key Commands

- **Core Surfaces**:
  - MV3 Extension: `shared/config.js`, `shared/cache-db.js`, `shared/pdf-layout.mjs`, `background/service-worker.js`, `content/`, `popup/`, `options/`, `viewer/`
  - Web & Mobile Distribution (`docs/`): PWA (`docs/app.js`, `docs/index.html`, `docs/sw.js`), Userscript (`docs/nativeread.user.js`), Android ZIP (`docs/nativeread-android-extension.zip`)
  - Verification & CI: `scripts/build-mobile.js`, `scripts/verify.mjs`, `tests/*.test.mjs`, `tests/e2e/run.js`, `.github/workflows/verify.yml`
- **Routine Verification Commands**:
  ```bash
  node scripts/build-mobile.js && node scripts/verify.mjs
  node tests/e2e/run.js --suite invariants-docs --tier 1
  ```

---

## Workspace Skills Index

- [`nr-product-ux-review`](.agents/skills/nr-product-ux-review/SKILL.md) — Gate 1: UX friction, error recovery & cross-viewport design critique
- [`nr-tdd-bugfix`](.agents/skills/nr-tdd-bugfix/SKILL.md) — Gate 2: Root-cause debugging, failure catalog & mandatory regression test workflow
- [`nr-code-security-review`](.agents/skills/nr-code-security-review/SKILL.md) — Gate 3: Independent diff review for MV3 bugs, security & surface parity
- [`nr-browser-qa`](.agents/skills/nr-browser-qa/SKILL.md) — Gate 4: Safe `#dev-reload-button` reload, live Chromium QA & E2E harness protocol
- [`nr-release-ship`](.agents/skills/nr-release-ship/SKILL.md) — Gate 5: Version parity, build, Conventional Commit & direct `origin/main` push
