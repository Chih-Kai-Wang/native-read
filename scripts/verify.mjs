#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function walkFiles(dir, filterFn, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'vendor' ||
      entry.name === '.git' ||
      entry.name === '.gradle' ||
      entry.name === 'build' ||
      entry.name === 'DerivedData'
    ) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, filterFn, acc);
    } else if (filterFn(full, entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function checkSyntax() {
  const jsFiles = walkFiles(ROOT, (_full, name) => name.endsWith('.js') || name.endsWith('.mjs'));
  for (const file of jsFiles) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
  console.log(`[verify] node --check passed (${jsFiles.length} JS/MJS files)`);
}

function checkForbiddenSinks() {
  const bannedTokens = [
    ['inner', 'HTML'].join(''),
    ['outer', 'HTML'].join(''),
    ['insertAdjacent', 'HTML'].join(''),
    ['document.', 'write'].join(''),
    ['ev', 'al('].join(''),
    ['new ', 'Function'].join('')
  ];
  const sinkRegex = new RegExp(
    bannedTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g'
  );
  const dirs = ['shared', 'background', 'content', 'viewer', 'popup', 'options', 'docs', 'scripts'];
  const violations = [];
  for (const dir of dirs) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) continue;
    const files = walkFiles(absDir, (_full, name) => /\.(js|mjs|html)$/i.test(name));
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const m = content.match(sinkRegex);
      if (m) {
        violations.push(`${path.relative(ROOT, file)}: matched ${Array.from(new Set(m)).join(', ')}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Forbidden DOM/eval sinks found:\n${violations.join('\n')}`);
  }
  console.log('[verify] Zero forbidden DOM/eval sinks across source & docs');
}

function checkVersionParity() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid manifest version: ${version}`);
  }

  const versionJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/version.json'), 'utf8'));
  if (versionJson.version !== version) {
    throw new Error(`docs/version.json (${versionJson.version}) != manifest.json (${version})`);
  }

  const metaJs = fs.readFileSync(path.join(ROOT, 'docs/nativeread.meta.js'), 'utf8');
  if (!new RegExp(`// @version\\s+${version.replace(/\./g, '\\.')}\\b`).test(metaJs)) {
    throw new Error(`docs/nativeread.meta.js missing @version ${version}`);
  }

  const swJs = fs.readFileSync(path.join(ROOT, 'docs/sw.js'), 'utf8');
  if (!swJs.includes(`nativeread-pwa-v${version}`)) {
    throw new Error(`docs/sw.js missing cache version nativeread-pwa-v${version}`);
  }

  const indexHtml = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  if (!indexHtml.includes(`v${version} Mobile &amp; PWA`)) {
    throw new Error(`docs/index.html missing v${version} Mobile & PWA tag`);
  }

  const readmes = fs.readdirSync(ROOT).filter((name) => /^README(\.[A-Za-z0-9_-]+)?\.md$/.test(name));
  if (readmes.length < 8) {
    throw new Error(`Expected >= 8 README files, found ${readmes.length}`);
  }
  for (const readme of readmes) {
    const content = fs.readFileSync(path.join(ROOT, readme), 'utf8');
    if (!content.includes(`v${version}`)) {
      throw new Error(`${readme} does not mention v${version}`);
    }
  }
  console.log(`[verify] Version parity v${version} verified across manifest, docs, and ${readmes.length} READMEs`);
}

function runContractTests() {
  const suites = [
    'tests/provider-profiles.test.mjs',
    'tests/config-endpoints.test.mjs',
    'tests/service-worker-transport.test.mjs',
    'tests/content-queue.test.mjs',
    'tests/userscript-runtime.test.mjs',
    'tests/pwa-sw.test.mjs',
    'tests/pwa-sync.test.mjs',
    'tests/native-mobile.test.mjs',
    'tests/workflow-integrity.test.mjs'
  ];
  execFileSync(process.execPath, ['--test', ...suites.map((s) => path.join(ROOT, s))], {
    stdio: 'inherit'
  });
}

function main() {
  checkSyntax();
  checkForbiddenSinks();
  checkVersionParity();
  runContractTests();
  console.log('[verify] ALL CHECKS PASSED');
}

main();
