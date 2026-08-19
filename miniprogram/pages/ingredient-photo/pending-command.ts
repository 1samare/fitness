export type IngredientPhotoAction =
  | 'createIngredientPhotoUpload'
  | 'registerIngredientPhotoUpload'
  | 'recognizeIngredientPhoto'
  | 'confirmIngredientCandidate';

export interface PendingIngredientPhotoCommand {
  readonly action: IngredientPhotoAction;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly photoId: string | null;
  readonly candidateId: string | null;
  readonly expectedInventoryVersion: number | null;
  readonly confirmedGrams: number | null;
}

export type PendingIngredientPhotoDraft = Omit<
  PendingIngredientPhotoCommand,
  'idempotencyKey'
>;

const exactKeys = [
  'action', 'idempotencyKey', 'expectedVersion', 'photoId', 'candidateId',
  'expectedInventoryVersion', 'confirmedGrams'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 200);
}

function validShape(value: PendingIngredientPhotoCommand): boolean {
  if (value.action === 'createIngredientPhotoUpload') {
    return value.photoId === null
      && value.candidateId === null
      && value.expectedInventoryVersion === null
      && value.confirmedGrams === null;
  }
  if (value.action === 'registerIngredientPhotoUpload' || value.action === 'recognizeIngredientPhoto') {
    return value.photoId !== null
      && value.candidateId === null
      && value.expectedInventoryVersion === null
      && value.confirmedGrams === null;
  }
  return value.photoId !== null
    && value.candidateId !== null
    && value.expectedInventoryVersion !== null
    && value.confirmedGrams !== null;
}

export function parsePendingIngredientPhotoCommand(
  value: unknown
): PendingIngredientPhotoCommand | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length !== exactKeys.length || exactKeys.some((key) => !keys.includes(key))) {
    return undefined;
  }
  if (
    value.action !== 'createIngredientPhotoUpload'
    && value.action !== 'registerIngredientPhotoUpload'
    && value.action !== 'recognizeIngredientPhoto'
    && value.action !== 'confirmIngredientCandidate'
  ) return undefined;
  if (
    typeof value.idempotencyKey !== 'string'
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(value.idempotencyKey)
    || !Number.isSafeInteger(value.expectedVersion)
    || (value.expectedVersion as number) < 0
    || !isNullableIdentifier(value.photoId)
    || !isNullableIdentifier(value.candidateId)
    || !(value.expectedInventoryVersion === null || (
      Number.isSafeInteger(value.expectedInventoryVersion)
      && (value.expectedInventoryVersion as number) >= 0
    ))
    || !(value.confirmedGrams === null || (
      Number.isSafeInteger(value.confirmedGrams)
      && (value.confirmedGrams as number) > 0
      && (value.confirmedGrams as number) <= 1_000_000
    ))
  ) return undefined;

  const parsed: PendingIngredientPhotoCommand = {
    action: value.action,
    idempotencyKey: value.idempotencyKey,
    expectedVersion: value.expectedVersion as number,
    photoId: value.photoId,
    candidateId: value.candidateId,
    expectedInventoryVersion: value.expectedInventoryVersion as number | null,
    confirmedGrams: value.confirmedGrams as number | null
  };
  return validShape(parsed) ? parsed : undefined;
}

export function createPendingIngredientPhotoCommand(
  value: PendingIngredientPhotoCommand
): PendingIngredientPhotoCommand {
  const parsed = parsePendingIngredientPhotoCommand(value);
  if (parsed === undefined) throw new Error('照片恢复命令无效');
  return parsed;
}

function sameLogicalCommand(
  pending: PendingIngredientPhotoCommand,
  command: PendingIngredientPhotoDraft
): boolean {
  return pending.action === command.action
    && pending.photoId === command.photoId
    && pending.candidateId === command.candidateId
    && pending.confirmedGrams === command.confirmedGrams;
}

export function selectPendingIngredientPhotoCommand(input: {
  readonly command: PendingIngredientPhotoDraft;
  readonly pending: PendingIngredientPhotoCommand | undefined;
  readonly nextKey: () => string;
}): { readonly pending: PendingIngredientPhotoCommand; readonly reused: boolean } {
  if (input.pending !== undefined && sameLogicalCommand(input.pending, input.command)) {
    return { pending: input.pending, reused: true };
  }
  return {
    pending: createPendingIngredientPhotoCommand({
      ...input.command,
      idempotencyKey: input.nextKey()
    }),
    reused: false
  };
}

export function pendingIngredientPhotoCommandStorageKey(action: IngredientPhotoAction): string {
  return `fitness.pendingIngredientPhotoCommand.v1.${action}`;
}
