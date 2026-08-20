import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FUNCTION_ALLOWLIST = new Set(['planning-api', 'assistant-api', 'photo-cleanup']);
const FUNCTION_FILE_ALLOWLIST = new Set(['index.js', 'package.json']);
const TEXT_FILE_MAX_BYTES = 10 * 1024 * 1024;

function relative(repositoryRoot, absolutePath) {
  return path.relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
}

function finding(repositoryRoot, absolutePath, ruleId) {
  return { path: relative(repositoryRoot, absolutePath), ruleId };
}

async function walk(repositoryRoot, root, findings, optional = false) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    if (!optional) findings.push(finding(repositoryRoot, root, 'required_artifact_root_missing'));
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      findings.push(finding(repositoryRoot, absolutePath, 'symbolic_link'));
      continue;
    }
    if (stats.isDirectory()) {
      files.push(...await walk(repositoryRoot, absolutePath, findings));
    } else if (stats.isFile()) {
      files.push({ absolutePath, size: stats.size });
    }
  }
  return files;
}

function pathRule(relativePath) {
  const parts = relativePath.split('/');
  if (relativePath.startsWith('.build/cloudfunctions/')) {
    const functionName = parts[2];
    const fileName = parts.slice(3).join('/');
    if (!FUNCTION_ALLOWLIST.has(functionName)) return 'unapproved_cloudfunction';
    if (!FUNCTION_FILE_ALLOWLIST.has(fileName)) return 'unapproved_cloudfunction_file';
  }
  if (/\.map$/i.test(relativePath)) return 'source_map';
  if (/(^|\/)(?:node_modules)(\/|$)/i.test(relativePath)) return 'node_modules';
  if (/(?:^|[._-])test(?:[._-]|$)/i.test(path.basename(relativePath))) return 'test_file';
  if (/(^|\/)(?:\.env(?:\..*)?|project\.private\.config\.json)$/i.test(relativePath)) {
    return 'private_configuration';
  }
  return null;
}

function contentRules(content, evidenceOrLog) {
  const rules = [];
  if (/TEST_INGREDIENT_VISION_RESPONSE|TEST_MEAL_PLANNING_|FITNESS-TEST-FIXTURE|fixture-2026|FITNESS_RUNTIME_MODE|FITNESS_LOCAL_USER_ID|local-private-photo/i.test(content)) {
    rules.push('fixture_marker');
  }
  const credentialAssignments = content.matchAll(
    /(?:secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']([A-Za-z0-9_+/=-]{24,})["']/ig
  );
  if ([...credentialAssignments].some((match) => !/^[A-Z][A-Z0-9_]+$/.test(match[1]))) {
    rules.push('secret_value');
  }
  if (/["']?(?:openid|openId)["']?\s*[:=]\s*["']o[A-Za-z0-9_-]{27,}["']/i.test(content)) {
    rules.push('openid_value');
  }
  if (/data:image\/[A-Za-z0-9.+-]+;base64,/i.test(content)) rules.push('base64_image');
  if (evidenceOrLog && /cloud:\/\/[^/"'\s]+\/[^"'\s]+/i.test(content)) {
    rules.push('cloud_file_id');
  }
  return rules;
}

export async function scanReleaseArtifacts({ repositoryRoot }) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const findings = [];
  const roots = [
    { path: path.join(resolvedRoot, '.build', 'cloudfunctions'), optional: false },
    { path: path.join(resolvedRoot, '.build', 'miniprogram'), optional: false },
    { path: path.join(resolvedRoot, '.build', 'release-evidence'), optional: true }
  ];
  const files = [];
  for (const root of roots) {
    files.push(...await walk(resolvedRoot, root.path, findings, root.optional));
  }
  for (const file of files) {
    const relativePath = relative(resolvedRoot, file.absolutePath);
    const rule = pathRule(relativePath);
    if (rule !== null) findings.push({ path: relativePath, ruleId: rule });
    if (file.size > TEXT_FILE_MAX_BYTES) {
      findings.push({ path: relativePath, ruleId: 'text_file_too_large' });
      continue;
    }
    const content = await readFile(file.absolutePath, 'utf8');
    const evidenceOrLog = relativePath.startsWith('.build/release-evidence/')
      || /(?:^|\/)(?:logs?)(?:\/|\.)/i.test(relativePath);
    for (const ruleId of contentRules(content, evidenceOrLog)) {
      findings.push({ path: relativePath, ruleId });
    }
  }
  findings.sort((left, right) => (
    left.path.localeCompare(right.path) || left.ruleId.localeCompare(right.ruleId)
  ));
  return {
    status: findings.length === 0 ? 'passed' : 'failed',
    findings
  };
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = await scanReleaseArtifacts({ repositoryRoot });
  for (const item of report.findings) {
    process.stderr.write(`${item.path}: ${item.ruleId}\n`);
  }
  process.stdout.write(`Release artifact scan: ${report.status}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

const isDirectExecution = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch(() => {
    process.stderr.write('Release artifact scan: failed (internal_error)\n');
    process.exitCode = 1;
  });
}
