# CLAUDE.md — NativeRead Project Context & Agent Entry Point

Read **`AGENTS.md`** in this directory FIRST. It defines NativeRead's **5-Gate Engineering Operating System**, non-negotiable security/MV3 invariants, and standing auto-push release policy, along with the 5 role workflow skills under **`.agents/skills/`**:

1. **`nr-product-ux-review`** — Gate 1: Commercial UX friction critique before coding
2. **`nr-tdd-bugfix`** — Gate 2: Root-cause tracing & mandatory regression tests for every bug fix
3. **`nr-code-security-review`** — Gate 3: Independent MV3, security, lifecycle & parity audit
4. **`nr-browser-qa`** — Gate 4: Safe `chrome://extensions/` `#dev-reload-button` reload, live Chromium QA & E2E runbook
5. **`nr-release-ship`** — Gate 5: Multi-surface build, verification, Conventional Commit & direct `git push origin main`

## Quick Non-Negotiable Rules
1. **Default silent (on-demand only)**: Zero static `content_scripts` and zero `web_accessible_resources` in `manifest.json`; `autoTranslate` defaults to `false`.
2. **Zero forbidden DOM/eval sinks**: Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, or `new Function`.
3. **Secret & user-data safety**: Never print, log, or commit raw API keys; never alter live user settings or IndexedDB cache without `tests/e2e/lib/settings-guard.js`.
4. **No CAPTCHA / auth bypass**: Fail gracefully with user handoff when a site enforces login or anti-bot checks.
5. **Browser reload & cleanup**: Reload via `chrome://extensions/` `#dev-reload-button` (never `chrome.runtime.reload()`); always call `task.finish({ keep: [] })` and close HTTP servers in `finally`.
6. **Verify & Auto-Push**:
   ```bash
   node scripts/build-mobile.js && node scripts/verify.mjs
   node tests/e2e/run.js --suite invariants-docs --tier 1
   ```
   After all applicable gates pass on a clean working tree, commit and push directly to `origin/main`.
