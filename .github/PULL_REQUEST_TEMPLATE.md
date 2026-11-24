## 1. Summary & UX Impact (`nr-product-ux-review`)
- What user friction, bug, or capability does this change solve?
- Are error states actionable with clear next steps (no dead-end alerts, no CAPTCHA/login bypass)?

## 2. Root Cause & Regression Test (`nr-tdd-bugfix`)
- Root cause:
- Regression test(s) added or updated in `tests/*.test.mjs` or `tests/e2e/`:

## 3. Security & Cross-Surface Parity (`nr-code-security-review`)
- [ ] Zero static `content_scripts` / `web_accessible_resources`; privileged senders verified via `isExtensionSender`
- [ ] Zero forbidden DOM/eval sinks and zero raw API key logging
- [ ] Rebuilt `docs/` via `node scripts/build-mobile.js` and synced `vX.Y.Z` across `manifest.json`, `docs/`, and 8 `README*.md` (if release)

## 4. Verification Evidence (`nr-browser-qa`)
- [ ] `node scripts/verify.mjs` passed
- [ ] `node tests/e2e/run.js --suite invariants-docs --tier 1` passed
- [ ] Live Chromium QA (if runtime/UI/PDF/SW changed) passed with zero console errors or leaked tabs
