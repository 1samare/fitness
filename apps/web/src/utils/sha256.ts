type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

function normalizeJsonValue(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('SHA helper input must contain finite numbers');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : normalizeJsonValue(entry)));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJsonValue(entry)] as const)
    );
  }
  throw new TypeError('SHA helper input must be JSON-serializable');
}

export function stableSha256Input(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const sourceBytes = new TextEncoder().encode(value);
  const digestBuffer = await globalThis.crypto.subtle.digest('SHA-256', sourceBytes);
  const digestBytes = new Uint8Array(digestBuffer);
  return [...digestBytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256HexOfJson(value: unknown): Promise<string> {
  return sha256Hex(stableSha256Input(value));
}
