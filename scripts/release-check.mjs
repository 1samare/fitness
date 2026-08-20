import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_CHECK_COMMAND_NAMES = [
  'release:preflight',
  'lint',
  'typecheck',
  'test',
  'build',
  'dry-run:api',
  'dry-run:photo-cleanup',
  'dry-run:assistant',
  'smoke:api',
  'smoke:assistant',
  'release:dataset',
  'release:capacity',
  'release:scan',
  'git diff --check',
  'git status --short'
];

function commandDefinitions() {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return RELEASE_CHECK_COMMAND_NAMES.map((name) => {
    if (name === 'git diff --check') return { name, executable: 'git', args: ['diff', '--check'] };
    if (name === 'git status --short') return { name, executable: 'git', args: ['status', '--short'] };
    return { name, executable: pnpm, args: [name] };
  });
}

function cleanStatusOutput(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return lines.every((line) => line === '?? .pnpm-store/');
}

export async function runReleaseCheck({ runCommand, writeEvidence }) {
  const results = [];
  for (const command of commandDefinitions()) {
    const startedAt = new Date().toISOString();
    const execution = await runCommand(command);
    const endedAt = new Date().toISOString();
    const cleanStatus = command.name !== 'git status --short'
      || cleanStatusOutput(execution.output ?? '');
    const passed = execution.exitCode === 0 && cleanStatus;
    results.push({
      name: command.name,
      exitCode: passed ? 0 : execution.exitCode === 0 ? 1 : execution.exitCode,
      startedAt,
      endedAt,
      status: passed ? 'passed' : 'failed'
    });
    if (!passed) {
      return { status: 'failed', failedCommand: command.name, results };
    }
  }
  const report = { status: 'passed', failedCommand: null, results };
  await writeEvidence(report);
  return report;
}

async function spawnCommand(command, repositoryRoot) {
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      process.stderr.write(text);
    });
    child.on('error', () => resolve({ exitCode: 1, output: '' }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function miniProgramManifest(repositoryRoot) {
  const root = path.join(repositoryRoot, '.build', 'miniprogram');
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) entries.push({
        path: path.relative(root, absolutePath).replaceAll('\\', '/'),
        checksumSha256: await sha256File(absolutePath)
      });
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function baselineCommit(repositoryRoot) {
  const result = await spawnCommand({
    executable: 'git', args: ['rev-parse', 'HEAD']
  }, repositoryRoot);
  if (result.exitCode !== 0) throw new Error('Baseline commit unavailable');
  return result.output.trim();
}

async function writeReleaseEvidence(repositoryRoot, report) {
  const evidenceDirectory = path.join(repositoryRoot, '.build', 'release-evidence');
  await mkdir(evidenceDirectory, { recursive: true });
  const functionChecksums = {};
  for (const functionName of ['planning-api', 'assistant-api', 'photo-cleanup']) {
    functionChecksums[functionName] = await sha256File(path.join(
      repositoryRoot,
      '.build',
      'cloudfunctions',
      functionName,
      'index.js'
    ));
  }
  const evidence = {
    schemaVersion: 'phase-7-release-check-evidence-v1',
    baselineCommit: await baselineCommit(repositoryRoot),
    functionEntryChecksumsSha256: functionChecksums,
    miniProgramArtifactManifest: await miniProgramManifest(repositoryRoot),
    commands: report.results
  };
  const target = path.join(evidenceDirectory, 'release-check.json');
  const temporary = path.join(evidenceDirectory, `.release-check.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = await runReleaseCheck({
    runCommand: (command) => spawnCommand(command, repositoryRoot),
    writeEvidence: (passing) => writeReleaseEvidence(repositoryRoot, passing)
  });
  process.stdout.write(`Release check: ${report.status}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

const isDirectExecution = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch(() => {
    process.stderr.write('Release check: failed (internal_error)\n');
    process.exitCode = 1;
  });
}
