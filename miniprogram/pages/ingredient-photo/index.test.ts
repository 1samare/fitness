import {
  planningApiResponseSchema,
  type PlanningApiRequest,
  type PlanningApiResponse,
  type PublicIngredientPhoto
} from '@fitness/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

interface PageOptions {
  readonly data: Record<string, unknown>;
  onLoad(): Promise<void>;
  onUnload(): void;
  onChoosePhoto(): Promise<void>;
  onUploadPhoto(): Promise<void>;
  onRecognizePhoto(): Promise<void>;
  onCandidateChange(event: { readonly detail: { readonly value: string } }): void;
  onGramsInput(event: { readonly detail: { readonly value: string } }): void;
  onConfirmCandidate(): Promise<void>;
  onManualEntry(): void;
}

interface PageInstance extends PageOptions {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
}

const calls: PlanningApiRequest[] = [];
const responses: (
  | PlanningApiResponse
  | Promise<PlanningApiResponse>
  | (() => Promise<PlanningApiResponse>)
)[] = [];
const storage = new Map<string, unknown>();
const uploads: { readonly cloudPath: string; readonly filePath: string }[] = [];
const redirects: string[] = [];
let chosenFile = {
  tempFilePath: 'local-private-photo.jpg',
  size: 512_000,
  fileType: 'image' as const
};
let registeredPage: PageOptions | undefined;

vi.mock('../../services/planning-api', () => ({
  planningApiClient: {
    call(request: PlanningApiRequest) {
      calls.push(request);
      const response = responses.shift();
      if (response === undefined) {
        return Promise.reject(new Error(`Missing response for ${request.action}`));
      }
      const outcome: Promise<PlanningApiResponse> = typeof response === 'function'
        ? response()
        : response instanceof Promise ? response : Promise.resolve(response);
      return outcome
        .then((value) => planningApiResponseSchema.parse(value));
    }
  }
}));

function publicPhoto(
  workflowStatus:
    | 'awaiting_upload'
    | 'uploaded'
    | 'recognized'
    | 'recognition_failed'
    | 'confirmed',
  revision: number
): PublicIngredientPhoto {
  return {
    photoId: 'photo-a', revision, workflowStatus,
    storageStatus: workflowStatus === 'confirmed' ? 'cleanup_pending' : 'retained',
    deleteDueAt: '2026-08-20T10:00:00.000Z',
    candidates: workflowStatus === 'recognized' || workflowStatus === 'confirmed' ? [{
      id: 'candidate-a', foodId: 'food-chicken', canonicalNameZh: '审核鸡胸肉',
      confidence: 0.91, foodState: 'cooked'
    }] : [],
    confirmedCandidateId: workflowStatus === 'confirmed' ? 'candidate-a' : null,
    inventoryVersionId: workflowStatus === 'confirmed' ? 'inventory-5' : null
  };
}

function pageInstance(): PageInstance {
  if (registeredPage === undefined) throw new Error('Page was not registered');
  return {
    ...registeredPage,
    data: { ...registeredPage.data },
    setData(patch) { Object.assign(this.data, patch); }
  };
}

function currentContextResponse(ingredientPhoto: PublicIngredientPhoto): PlanningApiResponse {
  return {
    success: true,
    data: {
      kind: 'current_context',
      bodyProfile: null,
      goal: null,
      trainingPlan: null,
      dailyEnergyTargets: [],
      dailyNutritionTargets: [],
      inventory: null,
      mealPlan: null,
      mealPlanStale: false,
      pendingMealPlanCandidate: null,
      pendingMealPlanTargetDiffs: [],
      selectableRecipes: [],
      selectableRecipesStatus: 'no_options',
      retryableRecalculationJob: null,
      ingredientPhoto,
      latestVersions: {
        bodyProfile: 0,
        goal: 0,
        trainingPlan: 0,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 0,
        recalculationJob: 0,
        ingredientPhoto: 1
      }
    }
  };
}

beforeEach(async () => {
  calls.length = 0;
  responses.length = 0;
  storage.clear();
  uploads.length = 0;
  redirects.length = 0;
  chosenFile = { tempFilePath: 'local-private-photo.jpg', size: 512_000, fileType: 'image' };
  registeredPage = undefined;
  vi.resetModules();
  vi.stubGlobal('Page', (options: PageOptions) => { registeredPage = options; });
  vi.stubGlobal('wx', {
    chooseMedia: ({ success }: { readonly success: (value: unknown) => void }) => {
      success({ tempFiles: [chosenFile], type: 'image' });
    },
    cloud: {
      uploadFile: ({
        cloudPath, filePath, success
      }: {
        readonly cloudPath: string;
        readonly filePath: string;
        readonly success: (value: { readonly fileID: string }) => void;
      }) => {
        uploads.push({ cloudPath, filePath });
        success({ fileID: 'cloud://sensitive/private-photo-a.jpg' });
      }
    },
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => { storage.set(key, value); },
    removeStorageSync: (key: string) => { storage.delete(key); },
    redirectTo: ({ url }: { readonly url: string }) => { redirects.push(url); }
  });
  await import('./index');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ingredient photo page controller', () => {
  test('keeps choosing, uploading/registering, and recognizing as explicit steps', async () => {
    const page = pageInstance();

    await page.onChoosePhoto.call(page);

    expect(calls).toEqual([]);
    expect(page.data.localPreviewPath).toBe('local-private-photo.jpg');

    responses.push(
      { success: true, data: {
        kind: 'ingredient_photo_upload_created',
        photo: publicPhoto('awaiting_upload', 1),
        cloudPath: 'ingredient-photos/random/photo.jpg'
      } },
      { success: true, data: {
        kind: 'ingredient_photo_upload_registered', photo: publicPhoto('uploaded', 2)
      } }
    );

    await page.onUploadPhoto.call(page);

    expect(calls.map((request) => request.action)).toEqual([
      'createIngredientPhotoUpload', 'registerIngredientPhotoUpload'
    ]);
    expect(uploads).toEqual([{
      cloudPath: 'ingredient-photos/random/photo.jpg',
      filePath: 'local-private-photo.jpg'
    }]);
    expect(page.data.localPreviewPath).toBe('');
    expect(JSON.stringify([...storage.values()])).not.toContain('local-private-photo.jpg');
    expect(JSON.stringify([...storage.values()])).not.toContain('cloud://sensitive');
    expect(JSON.stringify([...storage.values()])).not.toContain('ingredient-photos/random');

    responses.push({ success: true, data: {
      kind: 'ingredient_photo_recognized', photo: publicPhoto('recognized', 3)
    } });

    await page.onRecognizePhoto.call(page);

    expect(calls.at(-1)?.action).toBe('recognizeIngredientPhoto');
    expect(page.data.selectedCandidateId).toBeNull();
    expect(page.data.showGramsInput).toBe(false);

    await page.onChoosePhoto.call(page);
    responses.push({
      success: false,
      error: { code: 'version_conflict', message: 'controlled stop after create request' }
    });
    await page.onUploadPhoto.call(page);

    expect(calls.at(-1)).toMatchObject({
      action: 'createIngredientPhotoUpload',
      payload: { expectedVersion: 1 }
    });
  });

  test('retains exact confirmation grams and key after response loss', async () => {
    const page = pageInstance();
    page.setData({
      photoId: 'photo-a', photoRevision: 3, expectedInventoryVersion: 4,
      candidates: [{
        id: 'candidate-a', canonicalNameZh: '审核鸡胸肉', foodStateText: '熟制',
        confidenceText: '约 91%', confirmationLabel: '估算识别结果，请确认'
      }]
    });
    page.onCandidateChange.call(page, { detail: { value: 'candidate-a' } });
    page.onGramsInput.call(page, { detail: { value: '125' } });
    responses.push(() => Promise.reject(new Error('response lost')));

    await page.onConfirmCandidate.call(page);

    const firstRequest = calls.at(-1);
    const serialized = JSON.stringify([...storage.values()]);
    expect(firstRequest).toMatchObject({
      action: 'confirmIngredientCandidate',
      payload: { payload: { candidateId: 'candidate-a', confirmedGrams: 125 } }
    });
    expect(serialized).toContain('"confirmedGrams":125');
    expect(serialized).not.toContain('审核鸡胸肉');
    expect(serialized).not.toContain('confidence');

    responses.push({ success: true, data: {
      kind: 'ingredient_candidate_confirmed',
      photo: publicPhoto('confirmed', 4),
      inventory: {
        kind: 'inventory_version', id: 'inventory-5', version: 5,
        createdAt: '2026-08-19T10:00:00.000Z',
        items: [{
          foodId: 'food-chicken', nutritionSnapshotId: 'snapshot-chicken', availableGrams: 125
        }]
      }
    } });

    await page.onConfirmCandidate.call(page);

    expect(calls.at(-1)).toEqual(firstRequest);
    expect(storage.size).toBe(0);
    expect(page.data.successMessage).toContain('库存');
    expect(page.data.successMessage).toContain('餐单与营养目标尚未自动变更');
  });

  test('replays a response-lost create once with the exact redacted pending key', async () => {
    const page = pageInstance();
    await page.onChoosePhoto.call(page);
    responses.push(
      () => {
        expect(JSON.stringify([...storage.values()])).not.toMatch(
          /local-private-photo|cloud:\/\/sensitive|ingredient-photos\/random|审核鸡胸肉|confidence/
        );
        return Promise.reject(new Error('create response lost'));
      },
      { success: true, data: {
        kind: 'ingredient_photo_upload_created',
        photo: publicPhoto('awaiting_upload', 1),
        cloudPath: 'ingredient-photos/random/photo.jpg'
      } },
      { success: true, data: {
        kind: 'ingredient_photo_upload_registered', photo: publicPhoto('uploaded', 2)
      } }
    );

    await page.onUploadPhoto.call(page);

    const createCalls = calls.filter((request) => request.action === 'createIngredientPhotoUpload');
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]).toEqual(createCalls[0]);
    expect(page.data.canRecognize).toBe(true);
    const serialized = JSON.stringify([...storage.values()]);
    expect(serialized).not.toMatch(/local-private-photo|cloud:\/\/sensitive|ingredient-photos\/random/);
  });

  test('replays a response-lost register once while the fileID remains local', async () => {
    const page = pageInstance();
    await page.onChoosePhoto.call(page);
    responses.push(
      { success: true, data: {
        kind: 'ingredient_photo_upload_created',
        photo: publicPhoto('awaiting_upload', 1),
        cloudPath: 'ingredient-photos/random/photo.jpg'
      } },
      () => {
        expect(JSON.stringify([...storage.values()])).not.toMatch(
          /local-private-photo|cloud:\/\/sensitive|ingredient-photos\/random|审核鸡胸肉|confidence/
        );
        return Promise.reject(new Error('register response lost'));
      },
      { success: true, data: {
        kind: 'ingredient_photo_upload_registered', photo: publicPhoto('uploaded', 2)
      } }
    );

    await page.onUploadPhoto.call(page);

    const registerCalls = calls.filter(
      (request) => request.action === 'registerIngredientPhotoUpload'
    );
    expect(registerCalls).toHaveLength(2);
    expect(registerCalls[1]).toEqual(registerCalls[0]);
    expect(page.data.canRecognize).toBe(true);
    expect(JSON.stringify([...storage.values()])).not.toContain('cloud://sensitive');
  });

  test('refreshes logical photo count after bounded create recovery fails', async () => {
    const page = pageInstance();
    await page.onChoosePhoto.call(page);
    responses.push(
      () => Promise.reject(new Error('first create response lost')),
      () => Promise.reject(new Error('create replay response lost'))
    );

    await page.onUploadPhoto.call(page);

    expect(calls.map((request) => request.action)).toEqual([
      'createIngredientPhotoUpload', 'createIngredientPhotoUpload'
    ]);
    expect(calls[1]).toEqual(calls[0]);
    expect(page.data.localPreviewPath).toBe('');
    expect(JSON.stringify([...storage.values()])).not.toMatch(
      /local-private-photo|cloud:\/\/sensitive|ingredient-photos\/random/
    );

    responses.push(currentContextResponse(publicPhoto('awaiting_upload', 1)));
    await page.onChoosePhoto.call(page);
    responses.push(
      { success: true, data: {
        kind: 'ingredient_photo_upload_created',
        photo: publicPhoto('awaiting_upload', 1),
        cloudPath: 'ingredient-photos/random/second.jpg'
      } },
      { success: true, data: {
        kind: 'ingredient_photo_upload_registered', photo: publicPhoto('uploaded', 2)
      } }
    );
    await page.onUploadPhoto.call(page);

    expect(calls.map((request) => request.action)).toEqual([
      'createIngredientPhotoUpload', 'createIngredientPhotoUpload',
      'getCurrentContext', 'createIngredientPhotoUpload',
      'registerIngredientPhotoUpload'
    ]);
    expect(calls[3]).toMatchObject({
      action: 'createIngredientPhotoUpload',
      payload: { expectedVersion: 1 }
    });
  });

  test('does not allow another private selection until failed recovery can refresh context', async () => {
    const page = pageInstance();
    await page.onChoosePhoto.call(page);
    responses.push(
      () => Promise.reject(new Error('first create response lost')),
      () => Promise.reject(new Error('create replay response lost'))
    );
    await page.onUploadPhoto.call(page);

    responses.push(() => Promise.reject(new Error('context unavailable')));
    await page.onChoosePhoto.call(page);

    expect(calls.map((request) => request.action)).toEqual([
      'createIngredientPhotoUpload', 'createIngredientPhotoUpload', 'getCurrentContext'
    ]);
    expect(page.data.localPreviewPath).toBe('');
    expect(page.data.errorMessage).toContain('context unavailable');
    expect(JSON.stringify([...storage.values()])).not.toMatch(
      /local-private-photo|cloud:\/\/sensitive|ingredient-photos\/random/
    );
  });

  test('keeps recognition retry available when no supported candidate is returned', async () => {
    const page = pageInstance();
    page.setData({ photoId: 'photo-a', photoRevision: 2, canRecognize: true });
    responses.push({ success: true, data: {
      kind: 'ingredient_photo_recognized',
      photo: publicPhoto('recognition_failed', 3)
    } });

    await page.onRecognizePhoto.call(page);

    expect(page.data.photoRevision).toBe(3);
    expect(page.data.canRecognize).toBe(true);
    expect(page.data.errorMessage).toContain('手动录入');

    responses.push(currentContextResponse(publicPhoto('recognition_failed', 3)));
    await page.onLoad.call(page);

    expect(page.data.canRecognize).toBe(true);
  });

  test('rejects oversized local files early while keeping manual entry available', async () => {
    chosenFile = { ...chosenFile, size: 10 * 1024 * 1024 + 1 };
    const page = pageInstance();

    await page.onChoosePhoto.call(page);

    expect(calls).toEqual([]);
    expect(page.data.errorMessage).toContain('10 MiB');
    page.onManualEntry.call(page);
    expect(redirects).toEqual(['/pages/meal-execution/index']);
  });

  test('clears an unuploaded local selection when the page unloads', async () => {
    const page = pageInstance();
    await page.onChoosePhoto.call(page);

    page.onUnload.call(page);
    await page.onUploadPhoto.call(page);

    expect(calls).toEqual([]);
    expect(page.data.localPreviewPath).toBe('');
    expect(page.data.errorMessage).toBe('请先选择一张图片。');
  });
});
