---
name: nr-product-ux-review
description: >-
  Gate 1 (Product & UX Review) for NativeRead. Audits commercial product polish,
  zero-friction user flows, actionable error states, and responsive multi-surface
  UI before writing feature or UX code.
---

# Gate 1: Product & UX Critique (`nr-product-ux-review`)

Run this gate before implementing any user-facing feature, flow change, UI tweak, or friction fix in NativeRead. Think like a demanding commercial-product designer rejecting "works on my happy path" shortcuts.

## Checklist

1. **Zero-Friction / Click-Budget Audit**
   - Count how many clicks, downloads, or context switches the user must perform.
   - Eliminate manual workarounds whenever safe and browser-native (for example: fetch/stream same-origin PDFs instead of telling the user to download first; offer 1-click provider switching in Popup instead of forcing a detour to Options).
2. **Actionable Error & Empty States**
   - Every failure state must tell the user *why* it failed in plain Traditional Chinese and render a direct next-action button (e.g., `重試載入`, `前往設定`, `前往原網頁開啟／登入`, `切換備援供應商`), never a dead-end raw error dump.
   - Never guess or silently switch a user's model; when a model or key is missing/retired, guide them cleanly to `取得模型清單` or profile settings.
   - Never bypass CAPTCHAs, Turnstile, or paywalls — show an honest handoff action back to the origin tab.
3. **Cross-Surface & Viewport Parity**
   - Check whether the behavior belongs across **Extension Popup (`380px`)**, **Options Page**, **PDF Viewer (`viewer/`)**, and **Mobile PWA (`docs/`, `390px`)** / **Userscript**.
   - Check both **Dark** and **Light** schemes (`prefers-color-scheme`), zero horizontal overflow, legible contrast, and concise controls (use `clamp()` / `100dvh` where appropriate on mobile/popup).
4. **Silent & Unobtrusive Preservation**
   - New features must keep `autoTranslate` off by default and preserve original page typography/layout (`overlay`, `split`, `original` modes).

## Gate Output
Produce a brief **Acceptance Checklist** (3–6 concrete bullets covering happy path, error recovery, and viewports/surfaces) before writing implementation code.
