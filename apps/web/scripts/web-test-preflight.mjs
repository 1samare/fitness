/* global AbortController, URL, clearTimeout, fetch, setTimeout */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_KEYS = [
  'VITE_TEST_LLM_BASE_URL',
  'VITE_TEST_LLM_API_KEY',
  'VITE_TEST_LLM_MODEL'
];

function parseEnvFile(contents) {
  const values = {};
  for (const sourceLine of contents.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readPreflightEnvironment(cwd, processEnvironment) {
  const workspaceEnvFile = resolve(cwd, 'apps/web/.env.test.local');
  const envFile = existsSync(workspaceEnvFile)
    ? workspaceEnvFile
    : resolve(cwd, '.env.test.local');
  const fileValues = existsSync(envFile)
    ? parseEnvFile(readFileSync(envFile, 'utf8'))
    : {};
  return { ...fileValues, ...processEnvironment };
}

function safeFailureCode(status) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  return 'provider_unavailable';
}

export async function runWebTestPreflight(options = {}) {
  const {
    cwd = process.cwd(),
    fetchImpl = fetch,
    nowMs = () => Date.now(),
    timeoutMs = 20_000
  } = options;
  const processEnvironment = options.processEnvironment ?? process.env;
  const env = Object.hasOwn(options, 'processEnvironment')
    ? processEnvironment
    : readPreflightEnvironment(cwd, processEnvironment);
  const missing = REQUIRED_KEYS.filter((key) => typeof env[key] !== 'string' || env[key].trim() === '');
  if (missing.length > 0) {
    return { ok: false, status: 'not_configured', latencyMs: 0 };
  }

  let endpoint;
  try {
    const baseUrl = new URL(env.VITE_TEST_LLM_BASE_URL);
    const local = baseUrl.hostname === 'localhost' || baseUrl.hostname === '127.0.0.1';
    if (baseUrl.protocol !== 'https:' && !(local && baseUrl.protocol === 'http:')) {
      return { ok: false, status: 'invalid_endpoint', latencyMs: 0 };
    }
    endpoint = new URL(`${baseUrl.toString().replace(/\/$/u, '')}/chat/completions`);
  } catch {
    return { ok: false, status: 'invalid_endpoint', latencyMs: 0 };
  }

  const startedAt = nowMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.VITE_TEST_LLM_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: env.VITE_TEST_LLM_MODEL,
        temperature: 0,
        max_tokens: 8,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'This is a synthetic connectivity check. Return JSON only.' },
          { role: 'user', content: '{"status":"ok"}' }
        ]
      }),
      signal: controller.signal
    });
    const latencyMs = Math.max(0, nowMs() - startedAt);
    if (!response.ok) {
      return { ok: false, status: safeFailureCode(response.status), latencyMs };
    }
    const payload = await response.json();
    const record = payload !== null && typeof payload === 'object' ? payload : {};
    const requestId = typeof record.id === 'string' ? record.id : '';
    const usage = record.usage !== null && typeof record.usage === 'object' ? record.usage : {};
    const totalTokens = Number.isFinite(usage.total_tokens) ? usage.total_tokens : undefined;
    return {
      ok: true,
      status: 'available',
      latencyMs,
      requestIdPresent: requestId !== '',
      ...(totalTokens === undefined ? {} : { totalTokens })
    };
  } catch (error) {
    const latencyMs = Math.max(0, nowMs() - startedAt);
    return {
      ok: false,
      status: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_unavailable',
      latencyMs
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const result = await runWebTestPreflight();
  const output = JSON.stringify(result);
  if (result.ok) {
    process.stdout.write(`${output}\n`);
    return;
  }
  process.stderr.write(`${output}\n`);
  process.exitCode = 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await main();
}
