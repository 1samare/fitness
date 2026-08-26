export interface BrowserEnvironmentShape {
  readonly indexedDB?: unknown;
  readonly crypto?: {
    readonly subtle?: unknown;
  };
  readonly BroadcastChannel?: unknown;
  readonly structuredClone?: unknown;
  readonly URL?: {
    readonly createObjectURL?: unknown;
  };
}

export interface BrowserCapabilityReport {
  readonly supported: boolean;
  readonly unsupported: readonly string[];
}

function hasOwnKey<T extends object>(value: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function detectBrowserCapabilities(scope: BrowserEnvironmentShape = globalThis): BrowserCapabilityReport {
  const unsupported: string[] = [];

  if (!scope.indexedDB || typeof (scope as { indexedDB?: { open: unknown } }).indexedDB?.open !== 'function') {
    unsupported.push('indexedDb');
  }
  if (!scope.crypto || typeof scope.crypto.subtle !== 'object') {
    unsupported.push('web_crypto_subtle');
  }
  if (!hasOwnKey(scope, 'BroadcastChannel') || typeof scope.BroadcastChannel !== 'function') {
    unsupported.push('broadcast_channel');
  }
  if (typeof scope.structuredClone !== 'function') {
    unsupported.push('structured_clone');
  }
  if (
    !scope.URL ||
    typeof scope.URL.createObjectURL !== 'function'
  ) {
    unsupported.push('object_url');
  }

  return {
    supported: unsupported.length === 0,
    unsupported
  };
}
