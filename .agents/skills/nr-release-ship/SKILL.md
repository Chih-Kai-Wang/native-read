---
name: nr-release-ship
description: >-
  Gate 5 (Release & Auto-Push) for NativeRead. Handles release version parity,
  generated artifact verification, clean working-tree checks, Conventional Commits,
  and direct push to origin/main per maintainer preference.
---

# Gate 5: Release & Auto-Push (`nr-release-ship`)

Execute this final gate once Gates 1–4 are complete and passing.

## Standing Maintainer Policy
After all applicable checks pass on a clean, verified diff, **commit and push directly to `origin/main` without stopping to ask for confirmation**.

## Procedure

1. **Decide Whether to Bump Version**
   - **Runtime / UI / Feature / Bugfix / Mobile PWA / Userscript change**: Bump `manifest.json` (`MAJOR.MINOR.PATCH`, patch +1 for fixes or minor +1 for features) and update `vX.Y.Z` across all 8 `README*.md` files.
   - **Pure `chore` / `ci` / `.agents/` / `tests/` change**: Do NOT bump `manifest.json` version (leave current version intact, and ensure `docs/nativeread-android-extension.zip` excludes `.agents/`, `.github/`, `tests/`, `AGENTS.md`, `CLAUDE.md`, `HANDOFF.md`).
2. **Build & Verify Parity**
   ```bash
   node scripts/build-mobile.js && node scripts/verify.mjs
   ```
   Confirm Exit 0, zero forbidden sinks, version parity across `manifest.json` + `docs/` + 8 READMEs, and all unit/contract tests passing.
3. **Clean-Tree & Secret Audit**
   - Run `git status -s` and `git diff --stat`.
   - Ensure zero leftover scratch files, logs, test fixtures outside `tests/`, or unredacted credentials.
4. **Commit & Push Directly**
   ```bash
   git add -A
   git commit -m "<type>(<scope>): <concise summary>"
   git push origin main
   ```
   Use Conventional Commits: `feat(vX.Y.Z): ...`, `fix(vX.Y.Z): ...`, `chore(workflow): ...`.
5. **Confirm & Report**
   - Verify `git status -s` is empty and record the pushed commit SHA via `git log -n 2 --oneline`.
   - Report only directly observed files, symbols, and post-edit check results to the user with clickable `file://` links.
