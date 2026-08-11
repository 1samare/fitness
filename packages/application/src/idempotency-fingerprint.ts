import { createHash } from 'node:crypto';

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalizeJson(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Idempotency input must contain finite numbers');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : canonicalizeJson(item));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([leftKey], [rightKey]) => compareCodeUnits(leftKey, rightKey))
        .map(([key, entryValue]) => [key, canonicalizeJson(entryValue)] as const)
    );
  }
  throw new TypeError('Idempotency input must be JSON serializable');
}

function sha256Fingerprint(value: unknown, version: 'v2' | 'v3'): string {
  const serialized = JSON.stringify(canonicalizeJson(value));
  const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
  return `${version}:sha256:${digest}`;
}

export function requestFingerprint(value: unknown): string {
  return sha256Fingerprint(value, 'v2');
}

export function requestFingerprintV3(value: unknown): string {
  return sha256Fingerprint(value, 'v3');
}
