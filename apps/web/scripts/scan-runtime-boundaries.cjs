/* global __dirname, __filename */
const fs = require('node:fs');
const path = require('node:path');
const console = require('node:console');
const process = require('node:process');

const root = path.resolve(__dirname, '..', '..', '..');
const scannerPath = path.relative(root, __filename).replaceAll('\\', '/');
const forbiddenPaths = [
  'miniprogram',
  'cloudfunctions',
  'cloudbase',
  'cloudbaserc.json',
  'cloudbaserc.photo-cleanup-timer.json',
  'project.config.json',
  'project.private.config.json',
  'project.private.config.example.json'
];
const scanRoots = ['apps/web/src', 'apps/web/scripts', 'packages', 'data'];
const rootFiles = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'vitest.config.ts'];
const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml']);
const ignoredDirectories = new Set(['dist', 'node_modules', 'test-results', 'playwright-report']);
const forbiddenPatterns = [
  { id: 'wechat_runtime', pattern: /\bwx\s*\./ },
  { id: 'wechat_server_sdk', pattern: /wx-server-sdk/i },
  { id: 'cloudbase_runtime', pattern: /@cloudbase\//i },
  { id: 'cloudbase_symbol', pattern: /cloudbase/i },
  { id: 'cloudfunction_entry', pattern: /cloudfunctions?/i }
];

function collectFiles(target, files) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    files.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) collectFiles(child, files);
    else if (allowedExtensions.has(path.extname(entry.name))) files.push(child);
  }
}

const violations = [];
for (const relativePath of forbiddenPaths) {
  if (fs.existsSync(path.join(root, relativePath))) {
    violations.push({ id: 'legacy_path', file: relativePath });
  }
}

const files = [];
for (const relativePath of scanRoots) collectFiles(path.join(root, relativePath), files);
for (const relativePath of rootFiles) collectFiles(path.join(root, relativePath), files);
for (const file of files) {
  const relativePath = path.relative(root, file).replaceAll('\\', '/');
  if (relativePath === scannerPath) continue;
  const content = fs.readFileSync(file, 'utf8');
  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(content)) violations.push({ id: rule.id, file: relativePath });
  }
}

if (violations.length > 0) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, scannedFiles: files.length, legacyPaths: 'absent' }));
