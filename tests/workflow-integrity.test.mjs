import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const WORKFLOW_SKILLS = [
  'nr-product-ux-review',
  'nr-tdd-bugfix',
  'nr-code-security-review',
  'nr-browser-qa',
  'nr-release-ship'
];

test('AGENTS.md and CLAUDE.md follow NativeRead workflow and rule constraints', () => {
  const agentsPath = path.join(REPO_ROOT, 'AGENTS.md');
  assert.equal(fs.existsSync(agentsPath), true, 'AGENTS.md must exist at repo root');
  const agentsMd = fs.readFileSync(agentsPath, 'utf8');
  assert.equal(agentsMd.trimStart().startsWith('---'), false, 'AGENTS.md must not contain YAML frontmatter');
  assert.ok(Buffer.byteLength(agentsMd, 'utf8') < 24000, 'AGENTS.md must stay under 24 KB rule size limit');

  for (const skillName of WORKFLOW_SKILLS) {
    assert.ok(agentsMd.includes(skillName), `AGENTS.md must reference ${skillName}`);
  }
  assert.match(agentsMd, /git push origin main/i, 'AGENTS.md must document standing auto-push policy');

  const claudePath = path.join(REPO_ROOT, 'CLAUDE.md');
  assert.equal(fs.existsSync(claudePath), true, 'CLAUDE.md must exist at repo root');
  const claudeMd = fs.readFileSync(claudePath, 'utf8');
  assert.ok(claudeMd.includes('AGENTS.md'), 'CLAUDE.md must point agents to AGENTS.md');
  assert.equal(claudeMd.includes('HANDOFF.md'), false, 'CLAUDE.md must not redirect agents to stale HANDOFF.md');
});

test('all 5 NativeRead workflow skills exist with valid frontmatter name and description', () => {
  for (const skillName of WORKFLOW_SKILLS) {
    assert.match(skillName, /^[a-z0-9-]+$/, `Skill name must be lowercase hyphenated: ${skillName}`);
    const skillPath = path.join(REPO_ROOT, '.agents', 'skills', skillName, 'SKILL.md');
    assert.equal(fs.existsSync(skillPath), true, `Missing skill file: ${skillPath}`);

    const raw = fs.readFileSync(skillPath, 'utf8');
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, `${skillName}/SKILL.md must start with YAML frontmatter`);
    const fm = fmMatch[1];

    const nameMatch = fm.match(/^name:\s*(.+?)\s*$/m);
    assert.ok(nameMatch, `${skillName}/SKILL.md frontmatter must declare name`);
    assert.equal(nameMatch[1].replace(/^['"]|['"]$/g, ''), skillName, 'Frontmatter name must match folder name');

    const descMatch = fm.match(/^description:\s*(.*)$/m);
    assert.ok(descMatch, `${skillName}/SKILL.md frontmatter must declare description`);
    const inlineDesc = descMatch[1].trim();
    const hasFoldedBlock = /^description:\s*[>|]-?\s*\r?\n(?:\s+.+\r?\n?)+/m.test(fm);
    assert.ok(
      (inlineDesc && inlineDesc !== '>-' && inlineDesc !== '|' && inlineDesc !== '>') || hasFoldedBlock,
      `${skillName}/SKILL.md frontmatter description must be non-empty`
    );
  }
});

test('GitHub Actions verify workflow and PR template enforce checks safely', () => {
  const workflowPath = path.join(REPO_ROOT, '.github', 'workflows', 'verify.yml');
  assert.equal(fs.existsSync(workflowPath), true, '.github/workflows/verify.yml must exist');
  const yml = fs.readFileSync(workflowPath, 'utf8');
  assert.match(yml, /permissions:\s*\r?\n\s+contents:\s*read\b/, 'CI workflow must restrict permissions to contents: read');
  assert.ok(yml.includes('node scripts/verify.mjs'), 'CI workflow must execute scripts/verify.mjs');
  assert.ok(yml.includes('node scripts/build-mobile.js'), 'CI workflow must execute scripts/build-mobile.js');

  const prTplPath = path.join(REPO_ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md');
  assert.equal(fs.existsSync(prTplPath), true, '.github/PULL_REQUEST_TEMPLATE.md must exist');
});

test('docs/nativeread-android-extension.zip excludes workflow, CI, test, and agent docs', () => {
  const zipPath = path.join(REPO_ROOT, 'docs', 'nativeread-android-extension.zip');
  assert.equal(fs.existsSync(zipPath), true, 'docs/nativeread-android-extension.zip must exist');
  const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);

  for (const e of entries) {
    assert.equal(e.startsWith('.agents/'), false, `ZIP must exclude .agents/: ${e}`);
    assert.equal(e.startsWith('.github/'), false, `ZIP must exclude .github/: ${e}`);
    assert.equal(e.startsWith('tests/'), false, `ZIP must exclude tests/: ${e}`);
    assert.notEqual(e, 'AGENTS.md', 'ZIP must exclude AGENTS.md');
    assert.notEqual(e, 'CLAUDE.md', 'ZIP must exclude CLAUDE.md');
    assert.notEqual(e, 'HANDOFF.md', 'ZIP must exclude HANDOFF.md');
  }
});
