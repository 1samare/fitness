const {
  existsSync,
  readFileSync,
  readdirSync
} = require('node:fs');
const { argv } = require('node:process');
const process = require('node:process');
const console = require('node:console');
const { dirname, resolve, join } = require('node:path');

const scriptPath = argv[1];
if (!scriptPath) {
  throw new Error('scan:web-secrets: unable to resolve script path');
}
const WEB_ROOT = resolve(dirname(scriptPath), '..');
const WORKSPACE_ROOT = resolve(WEB_ROOT, '..', '..');
const TEXT_FILE = /\.(?:tsx?|json|js|mjs|cjs|html|md|css|yml|yaml)$/u;
const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bAKID[A-Za-z0-9]{12,}\b/u
];
const CONFIG_KEYS = [
  'VITE_TEST_LLM_BASE_URL',
  'VITE_TEST_LLM_API_KEY',
  'VITE_TEST_LLM_MODEL'
];

function walk(directory, list = []) {
  if (!existsSync(directory)) return list;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules'
      || entry.name === '.vite'
      || entry.name === 'test-results'
      || entry.name === 'playwright-report'
      || (entry.name.startsWith('.env') && entry.name !== '.env.example')
    ) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, list);
    else if (TEXT_FILE.test(entry.name) || entry.name === '.env.example') list.push(fullPath);
  }
  return list;
}

function parseEnvironmentFile(file) {
  if (!existsSync(file)) return {};
  const values = {};
  for (const sourceLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function configuredTestValues() {
  const candidates = [
    resolve(WEB_ROOT, '.env.test.local'),
    resolve(WORKSPACE_ROOT, '.env.test.local')
  ];
  const values = {};
  for (const candidate of candidates) {
    Object.assign(values, parseEnvironmentFile(candidate));
  }
  return CONFIG_KEYS
    .map((key) => values[key])
    .filter((value) => typeof value === 'string' && value.length >= 4);
}

function scan() {
  const files = walk(WEB_ROOT);
  const configuredValues = configuredTestValues();
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.env.example')) {
      const sample = parseEnvironmentFile(file);
      if (CONFIG_KEYS.some((key) => typeof sample[key] === 'string' && sample[key] !== '')) {
        violations.push({ kind: 'nonempty_env_example', file });
      }
      continue;
    }
    if (HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
      violations.push({ kind: 'credential_pattern', file });
    }
    if (configuredValues.some((value) => text.includes(value))) {
      violations.push({ kind: 'configured_value_exposed', file });
    }
  }
  if (violations.length > 0) {
    console.error(JSON.stringify({
      ok: false,
      violations: violations.map(({ kind, file }) => ({
        kind,
        file: file.slice(WORKSPACE_ROOT.length + 1)
      }))
    }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    scannedFiles: files.length,
    configuredValuesExposed: false
  }));
}

scan();
