export interface PendingAssistantCommand {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly message: string;
}

export const pendingAssistantCommandStorageKey = 'fitness.pendingAssistantCommand.v1';

const exactKeys = ['expectedVersion', 'idempotencyKey', 'message'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePendingAssistantCommand(
  value: unknown
): PendingAssistantCommand | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length !== exactKeys.length || exactKeys.some((key) => !keys.includes(key))) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value.expectedVersion)
    || (value.expectedVersion as number) < 0
    || typeof value.idempotencyKey !== 'string'
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(value.idempotencyKey)
    || typeof value.message !== 'string'
    || value.message !== value.message.trim()
    || value.message.length < 1
    || value.message.length > 2_000
  ) return undefined;
  return {
    expectedVersion: value.expectedVersion as number,
    idempotencyKey: value.idempotencyKey,
    message: value.message
  };
}

export function createPendingAssistantCommand(
  value: PendingAssistantCommand
): PendingAssistantCommand {
  const parsed = parsePendingAssistantCommand(value);
  if (parsed === undefined) throw new Error('助手恢复请求无效');
  return parsed;
}

export function pendingAssistantCommandMatches(
  local: PendingAssistantCommand,
  server: PendingAssistantCommand
): boolean {
  return local.expectedVersion === server.expectedVersion
    && local.idempotencyKey === server.idempotencyKey
    && local.message === server.message;
}

export function selectPendingAssistantCommand(input: {
  readonly expectedVersion: number;
  readonly message: string;
  readonly pending: PendingAssistantCommand | undefined;
  readonly nextKey: () => string;
}): { readonly pending: PendingAssistantCommand; readonly reused: boolean } {
  const message = input.message.trim();
  if (
    input.pending !== undefined
    && input.pending.expectedVersion === input.expectedVersion
    && input.pending.message === message
  ) return { pending: input.pending, reused: true };
  return {
    pending: createPendingAssistantCommand({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.nextKey(),
      message
    }),
    reused: false
  };
}
