export interface WebTestPreflightResult {
  readonly ok: boolean;
  readonly status: string;
  readonly latencyMs: number;
  readonly requestIdPresent?: boolean;
  readonly totalTokens?: number;
}

export function runWebTestPreflight(options?: {
  readonly cwd?: string;
  readonly processEnvironment?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
}): Promise<WebTestPreflightResult>;
