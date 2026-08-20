import { describe, expect, test, vi } from 'vitest';
import type {
  CloudBaseDatabase,
  CloudBaseDocumentReference,
  CloudBaseTransaction
} from '@fitness/persistence';
import type { PrivatePhotoStorage } from '@fitness/domain';
import { CloudBasePlanningRepository } from '@fitness/persistence';
import {
  createProviderObservationSink,
  createRuntimePlanningHandler,
  type ProviderObservationLogger
} from './runtime-handler';

class FakeDocumentReference implements CloudBaseDocumentReference {
  public constructor(
    private readonly documents: Map<string, unknown>,
    private readonly key: string
  ) {}
  public get(): Promise<{ readonly data?: unknown }> {
    const data = this.documents.get(this.key);
    return Promise.resolve(data === undefined ? {} : { data });
  }
  public set(input: { readonly data: unknown }): Promise<unknown> {
    this.documents.set(this.key, structuredClone(input.data));
    return Promise.resolve({ updated: 1 });
  }
  public remove(): Promise<unknown> {
    this.documents.delete(this.key);
    return Promise.resolve({ deleted: 1 });
  }
}

class FakeDatabase implements CloudBaseDatabase, CloudBaseTransaction {
  private readonly documents = new Map<string, unknown>();
  public seed(key: string, value: unknown): void {
    this.documents.set(key, structuredClone(value));
  }
  public readSeed(key: string): unknown {
    return structuredClone(this.documents.get(key));
  }
  public collection(name: string) {
    return {
      doc: (id: string) => new FakeDocumentReference(this.documents, `${name}/${id}`)
    };
  }
  public runTransaction<TResult>(
    operation: (transaction: CloudBaseTransaction) => Promise<TResult>
  ): Promise<TResult> {
    return operation(this);
  }
}

const writeProfile = {
  action: 'saveBodyProfile',
  payload: {
    expectedVersion: 0,
    idempotencyKey: 'profile-create-001',
    payload: {
      ageYears: 30,
      sexCode: 0,
      heightCm: 175,
      weightKg: 70,
      healthScopeConfirmed: true,
      nonTrainingActivity: 'light',
      allergens: [],
      avoidFoods: [],
      dietPreferences: [],
      businessTimezone: 'Asia/Shanghai'
    }
  }
} as const;

const completeSetup = {
  action: 'completePlanningSetup',
  payload: {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: 'planning-setup-001',
    bodyProfile: writeProfile.payload.payload,
    goal: {
      goal: 'maintain',
      effectiveDate: '2026-08-07',
      targetDate: '2026-10-30'
    },
    trainingPlan: {
      weekStartDate: '2026-08-10',
      businessTimezone: 'Asia/Shanghai',
      sessions: []
    }
  }
} as const;

const PHOTO_PREFIX = 'cloud://runtime-photo.bucket/';
const CLOUD_DATASET_ENVIRONMENT = {
  FITNESS_REVIEWED_DATASET_ID: 'missing-reviewed-dataset'
} as const;

const fakeLocalPhotoStorage: PrivatePhotoStorage = {
  inspectPrivateFile: () => Promise.resolve({ mediaType: 'image/jpeg', sizeBytes: 3 }),
  deletePrivateFile: () => Promise.resolve('deleted')
};

async function runPhotoToRecognition(
  runtime: ReturnType<typeof createRuntimePlanningHandler>,
  prefix = PHOTO_PREFIX,
  userId = 'runtime-photo-user'
) {
  const context = { userId } as const;
  const created = await runtime({
    action: 'createIngredientPhotoUpload',
    payload: {
      expectedVersion: 0,
      idempotencyKey: `${userId}-create`,
      payload: { mediaType: 'image/jpeg' }
    }
  }, context);
  if (!created.success || created.data.kind !== 'ingredient_photo_upload_created') return created;
  const registered = await runtime({
    action: 'registerIngredientPhotoUpload',
    payload: {
      expectedVersion: 1,
      idempotencyKey: `${userId}-register`,
      payload: {
        photoId: created.data.photo.photoId,
        privateFileId: `${prefix}${created.data.cloudPath}`
      }
    }
  }, context);
  if (!registered.success) return registered;
  return runtime({
    action: 'recognizeIngredientPhoto',
    payload: {
      expectedVersion: 2,
      idempotencyKey: `${userId}-recognize`,
      payload: { photoId: created.data.photo.photoId }
    }
  }, context);
}

describe('runtime planning handler', () => {
  test('uses CloudBase persistence in cloud mode across cold starts', async () => {
    const database = new FakeDatabase();
    const first = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      environment: CLOUD_DATASET_ENVIRONMENT,
      now: () => '2026-08-03T08:00:00.000Z',
      nextId: () => 'profile-1'
    });
    await first(writeProfile, { userId: 'wx-openid-a' });

    const afterColdStart = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      environment: CLOUD_DATASET_ENVIRONMENT,
      now: () => '2026-08-03T08:00:00.000Z',
      nextId: () => 'unused'
    });
    const result = await afterColdStart(
      { action: 'getCurrentContext' },
      { userId: 'wx-openid-a' }
    );

    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'current_context') {
      expect(result.data.bodyProfile?.id).toBe('profile-1');
    }
  });

  test('persists one atomic setup across cloud handler cold starts', async () => {
    const database = new FakeDatabase();
    let sequence = 0;
    const first = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      environment: CLOUD_DATASET_ENVIRONMENT,
      now: () => '2026-08-07T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++sequence)}`
    });
    const saved = await first(completeSetup, { userId: 'wx-openid-setup' });
    expect(saved.success).toBe(true);

    const afterColdStart = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      environment: CLOUD_DATASET_ENVIRONMENT,
      now: () => '2026-08-07T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-unused`
    });
    const current = await afterColdStart(
      { action: 'getCurrentContext' },
      { userId: 'wx-openid-setup' }
    );
    expect(current.success).toBe(true);
    if (current.success && current.data.kind === 'current_context') {
      expect(current.data.latestVersions).toEqual({
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 0,
        recalculationJob: 0,
        ingredientPhoto: 0
      });
      expect(current.data.dailyEnergyTargets).toHaveLength(7);
    }
  });

  test('loads fixture providers only in local mode and fails closed in cloud mode', async () => {
    const local = createRuntimePlanningHandler({ runtimeMode: 'local' });
    const localResolution = await local({
      action: 'resolveFoodName',
      payload: { name: '测试米饭' }
    }, { userId: 'local-user' });
    expect(localResolution.success).toBe(true);
    if (localResolution.success && localResolution.data.kind === 'food_name_resolved') {
      expect(localResolution.data.resolution?.foodId).toBe('fixture-rice');
      expect(localResolution.data.resolution?.nutritionSnapshotId)
        .toBe('snapshot-fixture-balanced-meal-rice-v1');
    }

    const cloud = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      environment: { FITNESS_REVIEWED_DATASET_ID: 'missing-reviewed-dataset' }
    });
    const cloudResolution = await cloud({
      action: 'resolveFoodName',
      payload: { name: '测试米饭' }
    }, { userId: 'cloud-user' });
    expect(cloudResolution).toEqual({
      success: false,
      error: {
        code: 'provider_unavailable',
        message: '营养数据暂时不可用。'
      }
    });
  });

  test('constructs and calls cloud providers without loading either fixture graph', async () => {
    vi.resetModules();
    vi.doMock('@fitness/nutrition-fixtures', () => {
      throw new Error('cloud mode attempted to load test fixtures');
    });
    try {
      const runtime = await import('./runtime-handler');
      const cloudProviders = runtime.createRuntimeMealPlanningProviders({
        runtimeMode: 'cloud',
        database: new FakeDatabase(),
        environment: { FITNESS_REVIEWED_DATASET_ID: 'missing-reviewed-dataset' }
      });
      expect(cloudProviders.allowTestFixtures).toBe(false);
      await expect(cloudProviders.nutrition.resolveCanonicalName('fixture'))
        .rejects.toMatchObject({ code: 'reviewed_dataset_unavailable' });
      await expect(cloudProviders.nutrition.getSnapshot('snapshot-fixture-rice-v1'))
        .rejects.toMatchObject({ code: 'reviewed_dataset_unavailable' });
      await expect(cloudProviders.recipes.getByVersionId('recipe-version-fixture-day-1-breakfast-v1'))
        .rejects.toMatchObject({ code: 'reviewed_dataset_unavailable' });
      await expect(cloudProviders.menus.getActiveCatalog())
        .rejects.toMatchObject({ code: 'reviewed_dataset_unavailable' });
      await expect(cloudProviders.menus.getMenuByVersionId('daily-menu-version-fixture-day-1-v1'))
        .rejects.toMatchObject({ code: 'reviewed_dataset_unavailable' });
    } finally {
      vi.doUnmock('@fitness/nutrition-fixtures');
      vi.resetModules();
    }
  });

  test.each([2, 3] as const)(
    'reads schema-v%s through the public handler without provider backfill or storage mutation',
    async (schemaVersion) => {
      const database = new FakeDatabase();
      const userId = `wx-openid-schema-v${String(schemaVersion)}`;
      const repository = new CloudBasePlanningRepository(database);
      const documentKey = `planning_user_states/${repository.documentIdForUser(userId)}`;
      const stored = {
        schemaVersion,
        state: {
          bodyProfiles: [],
          goals: [],
          trainingPlans: [],
          dailyEnergyTargets: [],
          ...(schemaVersion === 3 ? { dailyNutritionTargets: [] } : {}),
          outboxEvents: [],
          idempotencyRecords: [],
          activeBodyProfileVersionId: null,
          activeGoalVersionId: null,
          activeTrainingPlanVersionId: null
        }
      };
      database.seed(documentKey, stored);
      const handler = createRuntimePlanningHandler({
        runtimeMode: 'cloud',
        database,
        environment: CLOUD_DATASET_ENVIRONMENT
      });

      const response = await handler({ action: 'getCurrentContext' }, { userId });

      expect(response).toMatchObject({
        success: true,
        data: {
          kind: 'current_context',
          mealPlan: null,
          pendingMealPlanCandidate: null,
          selectableRecipes: [],
          selectableRecipesStatus: 'no_options'
        }
      });
      expect(database.readSeed(documentKey)).toEqual(stored);
    }
  );

  test('records a past completion fact through the CloudBase runtime without requiring providers', async () => {
    const database = new FakeDatabase();
    let sequence = 0;
    let instant = '2026-08-07T00:00:00.000Z';
    const handler = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      environment: CLOUD_DATASET_ENVIRONMENT,
      now: () => instant,
      nextId: (prefix) => `${prefix}-${String(++sequence)}`
    });
    await handler({
      ...completeSetup,
      payload: {
        ...completeSetup.payload,
        trainingPlan: {
          ...completeSetup.payload.trainingPlan,
          sessions: [{
            businessDate: '2026-08-11',
            sessionCode: '02054',
            durationMinutes: 60
          }]
        }
      }
    }, { userId: 'wx-openid-completion' });
    instant = '2026-08-12T04:00:00.000Z';

    const recorded = await handler({
      action: 'recordTrainingCompletion',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'completion-runtime-001',
        payload: { businessDate: '2026-08-11', completedDurationMinutes: 0 }
      }
    }, { userId: 'wx-openid-completion' });

    expect(recorded).toMatchObject({
      success: true,
      data: {
        kind: 'training_completion_recorded',
        event: { completedDurationMinutes: 0 },
        dailyEnergyTargets: [],
        dailyNutritionTargets: [],
        recalculationJob: null,
        recalculationStatus: 'not_required'
      }
    });
    expect(JSON.stringify(recorded)).not.toContain('userId');
    expect(JSON.stringify(recorded)).not.toContain('wx-openid-completion');
  });

  test('fixture vision is available only in explicit local mode', async () => {
    const runtime = createRuntimePlanningHandler({
      runtimeMode: 'local',
      environment: {
        ...CLOUD_DATASET_ENVIRONMENT,
        CLOUDBASE_STORAGE_FILE_ID_PREFIX: PHOTO_PREFIX
      },
      storage: fakeLocalPhotoStorage,
      now: () => '2026-08-19T00:00:00.000Z'
    });

    const response = await runPhotoToRecognition(runtime);

    expect(response).toMatchObject({
      success: true,
      data: {
        kind: 'ingredient_photo_recognized',
        photo: {
          workflowStatus: 'recognized',
          candidates: [{ canonicalNameZh: '测试米饭', confidence: 0.97 }]
        }
      }
    });
  });

  test('cloud mode fails closed without a configured vision function', async () => {
    const callFunction = vi.fn();
    const runtime = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      cloud: {
        callFunction,
        downloadFile: () => Promise.resolve({
          fileContent: Uint8Array.from([0xff, 0xd8, 0xff])
        }),
        deleteFile: () => Promise.resolve({ fileList: [{ code: 'SUCCESS' }] })
      },
      environment: {
        ...CLOUD_DATASET_ENVIRONMENT,
        CLOUDBASE_STORAGE_FILE_ID_PREFIX: PHOTO_PREFIX
      },
      now: () => '2026-08-19T00:00:00.000Z'
    });

    const response = await runPhotoToRecognition(runtime, PHOTO_PREFIX, 'cloud-no-vision');

    expect(response).toEqual({
      success: false,
      error: {
        code: 'provider_unavailable',
        message: '图片识别暂时不可用，请手动录入。'
      }
    });
    expect(callFunction).not.toHaveBeenCalled();
  });

  test('cloud mode uses only validated server vision and private-storage configuration', async () => {
    const observations: unknown[] = [];
    const callFunction = vi.fn((input: {
      readonly name: string;
      readonly data: { readonly privateFileId: string };
    }) => {
      void input;
      return Promise.resolve({
        result: { requestId: 'cloud-vision-request-1', candidates: [] }
      });
    });
    const downloadFile = vi.fn(() => Promise.resolve({
      fileContent: Uint8Array.from([0xff, 0xd8, 0xff])
    }));
    const runtime = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      cloud: {
        callFunction,
        downloadFile,
        deleteFile: () => Promise.resolve({ fileList: [{ code: 'SUCCESS' }] })
      },
      environment: {
        ...CLOUD_DATASET_ENVIRONMENT,
        CLOUDBASE_STORAGE_FILE_ID_PREFIX: PHOTO_PREFIX,
        FITNESS_VISION_FUNCTION_NAME: 'fitness-vision'
      },
      observeProvider: (event) => observations.push(event),
      now: () => '2026-08-19T00:00:00.000Z',
      nextId: (() => {
        let sequence = 0;
        return (prefix: string) => `${prefix}-${String(++sequence)}`;
      })()
    });

    const response = await runPhotoToRecognition(runtime, PHOTO_PREFIX, 'cloud-configured');

    expect(response).toMatchObject({
      success: true,
      data: {
        kind: 'ingredient_photo_recognized',
        photo: { workflowStatus: 'recognition_failed', candidates: [] }
      }
    });
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(callFunction).toHaveBeenCalledTimes(1);
    const cloudCall = callFunction.mock.calls[0]?.[0];
    if (cloudCall === undefined) throw new Error('Expected one configured cloud vision call');
    expect(cloudCall.name).toBe('fitness-vision');
    expect(cloudCall.data.privateFileId).toMatch(
      /^cloud:\/\/runtime-photo\.bucket\/ingredient-photos\/ingredient-photo-\d+\/ingredient-photo-upload-\d+\.jpg$/
    );
    expect(observations).toEqual([
      expect.objectContaining({
        provider: 'cloudbase-ai-vision',
        attempt: 1,
        status: 'succeeded'
      })
    ]);
    expect(JSON.stringify(observations)).not.toMatch(
      /cloud:\/\/|ingredient-photos\/|cloud-vision-request-1|privateFileId/
    );
  });

  test('Provider observation sink preserves available cost and stable failure semantics', () => {
    const entries: unknown[] = [];
    const sink = createProviderObservationSink({
      info: (entry) => entries.push(entry)
    });

    sink({
      provider: 'cloudbase-ai-vision',
      requestId: 'application-request-success',
      attempt: 1,
      latencyMs: 21,
      status: 'succeeded',
      estimatedCostUnits: 2.5
    });
    sink({
      provider: 'cloudbase-ai-vision',
      requestId: 'application-request-failure',
      attempt: 2,
      latencyMs: 8000,
      status: 'failed',
      stableErrorCode: 'provider_unavailable'
    });

    expect(entries).toEqual([
      {
        event: 'vision_provider_observation',
        provider: 'cloudbase-ai-vision',
        requestId: 'application-request-success',
        attempt: 1,
        latencyMs: 21,
        status: 'succeeded',
        stableErrorCode: null,
        estimatedCostUnits: 2.5
      },
      {
        event: 'vision_provider_observation',
        provider: 'cloudbase-ai-vision',
        requestId: 'application-request-failure',
        attempt: 2,
        latencyMs: 8000,
        status: 'failed',
        stableErrorCode: 'provider_unavailable',
        estimatedCostUnits: null
      }
    ]);
  });

  test('default cloud entry records a sanitized structured Provider observation', async () => {
    const database = new FakeDatabase();
    const loggedEntries: Parameters<ProviderObservationLogger['info']>[0][] = [];
    const info = vi.fn((entry: Parameters<ProviderObservationLogger['info']>[0]) => {
      loggedEntries.push(entry);
    });
    const callFunction = vi.fn((input: unknown) => {
      void input;
      return Promise.resolve({
        result: { requestId: 'provider-request-secret', candidates: [] }
      });
    });
    const previousRuntimeMode = process.env.FITNESS_RUNTIME_MODE;
    const previousStoragePrefix = process.env.CLOUDBASE_STORAGE_FILE_ID_PREFIX;
    const previousVisionFunction = process.env.FITNESS_VISION_FUNCTION_NAME;
    const previousDatasetId = process.env.FITNESS_REVIEWED_DATASET_ID;
    process.env.FITNESS_RUNTIME_MODE = 'cloud';
    process.env.CLOUDBASE_STORAGE_FILE_ID_PREFIX = PHOTO_PREFIX;
    process.env.FITNESS_VISION_FUNCTION_NAME = 'fitness-vision';
    process.env.FITNESS_REVIEWED_DATASET_ID = 'missing-reviewed-dataset';
    vi.resetModules();
    vi.doMock('wx-server-sdk', () => ({
      init: vi.fn(),
      database: () => database,
      logger: () => ({ info }),
      callFunction,
      downloadFile: () => Promise.resolve({
        fileContent: Uint8Array.from([0xff, 0xd8, 0xff])
      }),
      deleteFile: () => Promise.resolve({ fileList: [{ code: 'SUCCESS' }] })
    }));
    try {
      const runtime = await import('./runtime-handler');
      const defaultHandler = runtime.createDefaultRuntimePlanningHandler();

      const response = await runPhotoToRecognition(
        defaultHandler,
        PHOTO_PREFIX,
        'default-cloud-observation-user'
      );

      expect(response).toMatchObject({
        success: true,
        data: { kind: 'ingredient_photo_recognized' }
      });
      expect(loggedEntries).toHaveLength(1);
      const loggedEntry = loggedEntries[0];
      if (loggedEntry === undefined) throw new Error('Expected one Provider observation');
      expect(loggedEntries[0]).toEqual({
        event: 'vision_provider_observation',
        provider: 'cloudbase-ai-vision',
        requestId: loggedEntry.requestId,
        attempt: 1,
        latencyMs: loggedEntry.latencyMs,
        status: 'succeeded',
        stableErrorCode: null,
        estimatedCostUnits: null
      });
      expect(loggedEntry.requestId).toMatch(/^ingredient-photo-recognition-request-/);
      expect(Number.isFinite(loggedEntry.latencyMs)).toBe(true);
      const serialized = JSON.stringify(loggedEntries);
      expect(serialized).not.toMatch(
        /default-cloud-observation-user|provider-request-secret|cloud:\/\/|ingredient-photos\/|privateFileId|cloudPath|photoId|raw|prompt|body/
      );
    } finally {
      if (previousRuntimeMode === undefined) delete process.env.FITNESS_RUNTIME_MODE;
      else process.env.FITNESS_RUNTIME_MODE = previousRuntimeMode;
      if (previousStoragePrefix === undefined) delete process.env.CLOUDBASE_STORAGE_FILE_ID_PREFIX;
      else process.env.CLOUDBASE_STORAGE_FILE_ID_PREFIX = previousStoragePrefix;
      if (previousVisionFunction === undefined) delete process.env.FITNESS_VISION_FUNCTION_NAME;
      else process.env.FITNESS_VISION_FUNCTION_NAME = previousVisionFunction;
      if (previousDatasetId === undefined) delete process.env.FITNESS_REVIEWED_DATASET_ID;
      else process.env.FITNESS_REVIEWED_DATASET_ID = previousDatasetId;
      vi.doUnmock('wx-server-sdk');
      vi.resetModules();
    }
  });

  test.each([undefined, '', 'https://attacker.example/', 'cloud:///missing-bucket'])((
    'create upload fails closed for missing or invalid storage prefix %s'
  ), async (prefix) => {
    const runtime = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      cloud: {
        callFunction: vi.fn(),
        downloadFile: vi.fn(),
        deleteFile: vi.fn()
      },
      environment: prefix === undefined
        ? CLOUD_DATASET_ENVIRONMENT
        : {
            ...CLOUD_DATASET_ENVIRONMENT,
            CLOUDBASE_STORAGE_FILE_ID_PREFIX: prefix
          }
    });

    const response = await runtime({
      action: 'createIngredientPhotoUpload',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'invalid-prefix-config',
        payload: { mediaType: 'image/jpeg' }
      }
    }, { userId: 'cloud-invalid-prefix' });

    expect(response).toEqual({
      success: false,
      error: { code: 'storage_unavailable', message: '图片存储暂时不可用，请重新选择图片。' }
    });
  });

  test('invalid cloud photo configuration never bypasses authentication or strict parsing', async () => {
    const runtime = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      cloud: {
        callFunction: vi.fn(),
        downloadFile: vi.fn(),
        deleteFile: vi.fn()
      },
      environment: CLOUD_DATASET_ENVIRONMENT
    });
    const request = {
      action: 'createIngredientPhotoUpload',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'invalid-config-auth-order',
        payload: { mediaType: 'image/jpeg' }
      }
    } as const;

    await expect(runtime(request)).resolves.toMatchObject({
      success: false,
      error: { code: 'unauthenticated' }
    });
    await expect(runtime({ ...request, userId: 'attacker' }, { userId: 'trusted-user' }))
      .resolves.toMatchObject({
        success: false,
        error: { code: 'invalid_request' }
      });
  });

  test('an invalid cloud vision function name fails closed without invoking arbitrary functions', async () => {
    const callFunction = vi.fn();
    const runtime = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      cloud: {
        callFunction,
        downloadFile: () => Promise.resolve({
          fileContent: Uint8Array.from([0xff, 0xd8, 0xff])
        }),
        deleteFile: () => Promise.resolve({ fileList: [{ code: 'SUCCESS' }] })
      },
      environment: {
        ...CLOUD_DATASET_ENVIRONMENT,
        CLOUDBASE_STORAGE_FILE_ID_PREFIX: PHOTO_PREFIX,
        FITNESS_VISION_FUNCTION_NAME: 'attacker/function/name'
      }
    });

    const response = await runPhotoToRecognition(runtime, PHOTO_PREFIX, 'cloud-invalid-vision');

    expect(response).toMatchObject({
      success: false,
      error: { code: 'provider_unavailable' }
    });
    expect(callFunction).not.toHaveBeenCalled();
  });

  test('local composition gives raw storage only to deletion and guards normal planning while pending', async () => {
    const deletePrivateFile = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('storage temporarily unavailable'), {
        code: 'storage_unavailable'
      }))
      .mockResolvedValue('not_found');
    const storage: PrivatePhotoStorage = {
      inspectPrivateFile: () => Promise.resolve({ mediaType: 'image/jpeg', sizeBytes: 3 }),
      deletePrivateFile
    };
    let sequence = 0;
    const runtime = createRuntimePlanningHandler({
      runtimeMode: 'local',
      storage,
      now: () => '2026-08-20T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++sequence)}`
    });
    const context = { userId: 'local-personal-user' } as const;
    await runtime(writeProfile, context);
    const created = await runtime({
      action: 'createIngredientPhotoUpload',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'personal-local-photo-create-001',
        payload: { mediaType: 'image/jpeg' }
      }
    }, context);
    if (!created.success || created.data.kind !== 'ingredient_photo_upload_created') {
      throw new Error('Expected local personal photo upload');
    }
    await runtime({
      action: 'registerIngredientPhotoUpload',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'personal-local-photo-register-001',
        payload: {
          photoId: created.data.photo.photoId,
          privateFileId: `cloud://local-fixture.bucket/${created.data.cloudPath}`
        }
      }
    }, context);
    const summary = await runtime({ action: 'getPersonalDataSummary' }, context);
    if (
      !summary.success
      || summary.data.kind !== 'personal_data_summary'
      || summary.data.snapshotToken === null
    ) throw new Error('Expected local personal-data summary');
    const command = {
      action: 'deleteAccount',
      payload: {
        snapshotToken: summary.data.snapshotToken,
        idempotencyKey: 'delete-account-local-runtime-001',
        confirmation: 'DELETE_MY_ACCOUNT'
      }
    } as const;

    await expect(runtime(command, context)).resolves.toMatchObject({
      success: false,
      error: {
        code: 'storage_unavailable',
        message: '账户删除暂未完成，请使用同一删除请求重试。'
      }
    });
    await expect(runtime({ action: 'getCurrentContext' }, context)).resolves.toEqual({
      success: false,
      error: {
        code: 'account_deletion_pending',
        message: '账户正在删除，请重试删除操作或联系隐私支持。'
      }
    });
    await expect(runtime(command, context)).resolves.toMatchObject({
      success: true,
      data: { kind: 'account_deleted' }
    });
  });
});
