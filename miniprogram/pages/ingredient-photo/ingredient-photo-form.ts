import {
  planningApiRequestSchema,
  type PlanningApiRequest
} from '@fitness/contracts';

type RequestFor<TAction extends PlanningApiRequest['action']> = Extract<
  PlanningApiRequest,
  { readonly action: TAction }
>;

function parsedRequest<TAction extends PlanningApiRequest['action']>(
  action: TAction,
  request: unknown
): RequestFor<TAction> {
  const parsed = planningApiRequestSchema.parse(request);
  if (parsed.action !== action) throw new Error('照片请求类型不匹配');
  return parsed as RequestFor<TAction>;
}

export function buildCreateIngredientPhotoUploadCommand(input: {
  readonly mediaType: 'image/jpeg' | 'image/png';
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}): RequestFor<'createIngredientPhotoUpload'> {
  return parsedRequest('createIngredientPhotoUpload', {
    action: 'createIngredientPhotoUpload',
    payload: {
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: { mediaType: input.mediaType }
    }
  });
}

export function buildRegisterIngredientPhotoUploadCommand(input: {
  readonly photoId: string;
  readonly privateFileId: string;
  readonly photoRevision: number;
  readonly idempotencyKey: string;
}): RequestFor<'registerIngredientPhotoUpload'> {
  return parsedRequest('registerIngredientPhotoUpload', {
    action: 'registerIngredientPhotoUpload',
    payload: {
      expectedVersion: input.photoRevision,
      idempotencyKey: input.idempotencyKey,
      payload: { photoId: input.photoId, privateFileId: input.privateFileId }
    }
  });
}

export function buildRecognizeIngredientPhotoCommand(input: {
  readonly photoId: string;
  readonly photoRevision: number;
  readonly idempotencyKey: string;
}): RequestFor<'recognizeIngredientPhoto'> {
  return parsedRequest('recognizeIngredientPhoto', {
    action: 'recognizeIngredientPhoto',
    payload: {
      expectedVersion: input.photoRevision,
      idempotencyKey: input.idempotencyKey,
      payload: { photoId: input.photoId }
    }
  });
}

export type ConfirmIngredientCommandResult =
  | { readonly ok: false; readonly reason: 'candidate_required' | 'grams_must_be_positive_integer' }
  | { readonly ok: true; readonly request: RequestFor<'confirmIngredientCandidate'> };

export function buildConfirmIngredientCommand(input: {
  readonly photoId: string;
  readonly photoRevision: number;
  readonly selectedCandidateId: string | null;
  readonly gramsText: string;
  readonly expectedInventoryVersion: number;
  readonly idempotencyKey: string;
}): ConfirmIngredientCommandResult {
  if (input.selectedCandidateId === null) {
    return { ok: false, reason: 'candidate_required' };
  }
  const normalizedGrams = input.gramsText.trim();
  if (!/^[1-9][0-9]*$/.test(normalizedGrams)) {
    return { ok: false, reason: 'grams_must_be_positive_integer' };
  }
  const confirmedGrams = Number(normalizedGrams);
  if (!Number.isSafeInteger(confirmedGrams) || confirmedGrams > 1_000_000) {
    return { ok: false, reason: 'grams_must_be_positive_integer' };
  }
  return {
    ok: true,
    request: parsedRequest('confirmIngredientCandidate', {
      action: 'confirmIngredientCandidate',
      payload: {
        expectedVersion: input.photoRevision,
        idempotencyKey: input.idempotencyKey,
        payload: {
          photoId: input.photoId,
          candidateId: input.selectedCandidateId,
          confirmedGrams,
          expectedInventoryVersion: input.expectedInventoryVersion
        }
      }
    })
  };
}
