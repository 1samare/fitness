import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import {
  ProviderUnavailableError,
  createAccountDeletionGuardedRepository,
  createMealPlanRecalculationService,
  createPersonalDataService,
  planningAggregateUtf8Bytes,
  PLANNING_AGGREGATE_MAX_UTF8_BYTES
} from '../../packages/application/src/index';
import type { PlanningApiRequest } from '../../packages/contracts/src/index';
import type { PlanningAggregateState, PrivatePhotoStorage } from '../../packages/domain/src/index';
import {
  TEST_MEAL_PLANNING_DAILY_MENU_CATALOG,
  TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES,
  TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS,
  TEST_MEAL_PLANNING_RECIPE_TEMPLATES
} from '../../data/nutrition-fixtures/src/index';
import { InMemoryPlanningRepository } from '../../packages/persistence/src/index';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '../../packages/providers/src/index';
import { createPlanningApiHandler } from '../../cloudfunctions/planning-api/src/handler';

interface RequestScope {
  readonly identity: string;
  readonly injectProviderFailure: boolean;
}

const requestScope = new AsyncLocalStorage<RequestScope>();
const repository = new InMemoryPlanningRepository();
const guardedRepository = createAccountDeletionGuardedRepository(repository);
const clocks = new Map<string, string>();
const injectedFailures = new Set<string>();
let idSequence = 0;

const nutrition = new ReviewedNutritionCache({
  mode: 'test',
  snapshots: TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS
});
const recipes = new StaticRecipeTemplateProvider({
  mode: 'test',
  templates: TEST_MEAL_PLANNING_RECIPE_TEMPLATES
});
const menus = new StaticDailyMenuCatalogProvider({
  mode: 'test',
  catalog: TEST_MEAL_PLANNING_DAILY_MENU_CATALOG,
  menus: TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES
});

function failOnceIfRequested(): void {
  const scope = requestScope.getStore();
  if (
    scope?.injectProviderFailure === true
    && !injectedFailures.has(scope.identity)
  ) {
    injectedFailures.add(scope.identity);
    throw new ProviderUnavailableError('meal_catalog_unavailable');
  }
}

const providers = {
  nutrition: {
    getSnapshot: (id: string) => {
      failOnceIfRequested();
      return nutrition.getSnapshot(id);
    },
    resolveCanonicalName: (name: string) => {
      failOnceIfRequested();
      return nutrition.resolveCanonicalName(name);
    }
  },
  recipes: {
    getByVersionId: (id: string) => {
      failOnceIfRequested();
      return recipes.getByVersionId(id);
    }
  },
  menus: {
    getActiveCatalog: () => {
      failOnceIfRequested();
      return menus.getActiveCatalog();
    },
    getMenuByVersionId: (id: string) => {
      failOnceIfRequested();
      return menus.getMenuByVersionId(id);
    }
  },
  allowTestFixtures: true
} as const;

const storage: PrivatePhotoStorage = {
  inspectPrivateFile: () => Promise.reject(new Error('capacity storage is seed-only')),
  deletePrivateFile: () => Promise.resolve('not_found')
};

function now(): string {
  const identity = requestScope.getStore()?.identity;
  return identity === undefined
    ? '2026-08-20T08:00:00.000Z'
    : clocks.get(identity) ?? '2026-08-20T08:00:00.000Z';
}

const planning = createMealPlanRecalculationService({
  repository: guardedRepository,
  providers,
  now,
  nextId: (prefix) => `${prefix}-capacity-${String(++idSequence)}`
});
const personalData = createPersonalDataService({ repository, storage, now });
const handler = createPlanningApiHandler(Object.assign(planning, personalData));

const allowedIdentities = new Set(Array.from({ length: 10 }, (_, index) => (
  `tester-${String(index + 1).padStart(2, '0')}`
)));

function requiredIdentity(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers['x-fitness-capacity-identity'];
  const identity = Array.isArray(raw) ? raw[0] : raw;
  if (identity === undefined || !allowedIdentities.has(identity)) {
    throw new Error('capacity_identity_invalid');
  }
  return identity;
}

function setupRequest(identity: string) {
  return {
    action: 'completePlanningSetup',
    payload: {
      expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
      idempotencyKey: `capacity-setup-${identity}`,
      bodyProfile: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 175,
        weightKg: 60,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        allergens: [],
        avoidFoods: [],
        dietPreferences: [],
        businessTimezone: 'Asia/Shanghai'
      },
      goal: {
        goal: 'muscle_gain',
        effectiveDate: '2026-08-17',
        targetDate: '2026-10-30'
      },
      trainingPlan: {
        weekStartDate: '2026-08-17',
        businessTimezone: 'Asia/Shanghai',
        sessions: Array.from({ length: 7 }, (_, index) => ({
          businessDate: `2026-08-${String(17 + index).padStart(2, '0')}`,
          sessionCode: '02054',
          durationMinutes: 60
        }))
      }
    }
  } as const;
}

async function call(identity: string, request: PlanningApiRequest, injectProviderFailure = false) {
  return requestScope.run({ identity, injectProviderFailure }, () => (
    handler(request, { userId: identity })
  ));
}

async function seed(identity: string) {
  clocks.set(identity, '2026-08-16T08:00:00.000Z');
  const setup = setupRequest(identity);
  const setupResponse = await call(identity, setup);
  if (!setupResponse.success) throw new Error(`seed_setup_${setupResponse.error.code}`);
  const inventory = await call(identity, {
    action: 'saveInventory',
    payload: {
      expectedVersion: 0,
      idempotencyKey: `capacity-inventory-${identity}`,
      payload: {
        items: TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS.map((snapshot) => ({
          name: snapshot.canonicalNameZh,
          availableGrams: 50_000
        }))
      }
    }
  });
  if (!inventory.success) throw new Error(`seed_inventory_${inventory.error.code}`);
  const meal = await call(identity, {
    action: 'generateWeeklyMealPlan',
    payload: {
      expectedVersion: 0,
      idempotencyKey: `capacity-meal-${identity}`,
      payload: { weekStartDate: '2026-08-17' }
    }
  });
  if (!meal.success) throw new Error(`seed_meal_${meal.error.code}`);
  const summary = await call(identity, { action: 'getPersonalDataSummary' });
  if (
    !summary.success
    || summary.data.kind !== 'personal_data_summary'
    || summary.data.snapshotToken === null
  ) throw new Error('seed_summary_unavailable');
  clocks.set(identity, '2026-08-20T08:00:00.000Z');
  return { setupRequest: setup, staleSnapshotToken: summary.data.snapshotToken };
}

function duplicateVersionCount(state: PlanningAggregateState): number {
  const versionArrays = [
    state.bodyProfiles,
    state.goals,
    state.trainingPlans,
    state.inventories,
    state.mealPlans,
    state.mealPlanDecisions,
    state.trainingCompletionEvents
  ];
  return versionArrays.reduce((count, records) => {
    const versions = records.map((record) => record.version);
    return count + (new Set(versions).size === versions.length ? 0 : 1);
  }, 0);
}

async function inspect(identity: string) {
  const state = await repository.readExisting(identity);
  if (state === null) throw new Error('capacity_state_missing');
  const retryable = [...state.recalculationJobs]
    .reverse()
    .find((job) => job.status === 'failed_retryable');
  return {
    mealPlanVersion: state.mealPlans.length,
    recalculationJobVersion: state.recalculationJobs.length,
    retryableRecalculationJobId: retryable?.id ?? '',
    partialTransactionCount: state.recalculationJobs.some(
      (job) => job.status === 'pending' || job.status === 'failed_retryable'
    ) ? 1 : 0,
    duplicateEffectiveVersionCount: duplicateVersionCount(state),
    lostCleanupCount: state.ingredientPhotoVersions.some((photo) => (
      photo.storageStatus === 'retained' && photo.nextCleanupAt === null
    )) ? 1 : 0
  };
}

type MutableProfile = {
  kind: 'body_profile_version';
  id: string;
  userId: string;
  version: number;
  createdAt: string;
  payload: {
    ageYears: number;
    sexCode: 0;
    heightCm: number;
    weightKg: number;
    healthScopeConfirmed: boolean;
    nonTrainingActivity: 'light';
    allergens: string[];
    avoidFoods: string[];
    dietPreferences: string[];
    businessTimezone: string;
  };
};

function fullProfile(userId: string, version: number): MutableProfile {
  const values = () => Array.from({ length: 50 }, () => 'x'.repeat(80));
  return {
    kind: 'body_profile_version',
    id: `maximum-profile-${String(version)}`,
    userId,
    version,
    createdAt: '2026-08-20T08:00:00.000Z',
    payload: {
      ageYears: 30,
      sexCode: 0,
      heightCm: 175,
      weightKg: 60,
      healthScopeConfirmed: true,
      nonTrainingActivity: 'light',
      allergens: values(),
      avoidFoods: values(),
      dietPreferences: values(),
      businessTimezone: 'Asia/Shanghai'
    }
  };
}

function stateWithProfiles(
  empty: PlanningAggregateState,
  profiles: MutableProfile[]
): PlanningAggregateState {
  return {
    ...empty,
    bodyProfiles: profiles,
    activeBodyProfileVersionId: profiles.at(-1)?.id ?? null
  };
}

async function seedMaximumAggregate() {
  const userId = 'capacity-maximum-internal';
  const empty = await repository.read(userId);
  const profiles: MutableProfile[] = [];
  let candidate = stateWithProfiles(empty, profiles);
  while (planningAggregateUtf8Bytes(candidate) <= PLANNING_AGGREGATE_MAX_UTF8_BYTES) {
    profiles.push(fullProfile(userId, profiles.length + 1));
    candidate = stateWithProfiles(empty, profiles);
  }
  let excess = planningAggregateUtf8Bytes(candidate) - PLANNING_AGGREGATE_MAX_UTF8_BYTES;
  for (let profileIndex = profiles.length - 1; profileIndex >= 0 && excess > 0; profileIndex -= 1) {
    const profile = profiles[profileIndex]!;
    for (const collection of [
      profile.payload.allergens,
      profile.payload.avoidFoods,
      profile.payload.dietPreferences
    ]) {
      for (let index = collection.length - 1; index >= 0 && excess > 0; index -= 1) {
        const current = collection[index]!;
        const shrinkBy = Math.min(excess, current.length - 1);
        collection[index] = current.slice(0, current.length - shrinkBy);
        excess -= shrinkBy;
      }
    }
  }
  candidate = stateWithProfiles(empty, profiles);
  if (excess !== 0 || planningAggregateUtf8Bytes(candidate) !== PLANNING_AGGREGATE_MAX_UTF8_BYTES) {
    throw new Error('maximum_capacity_construction_failed');
  }
  await repository.transact(userId, () => ({ nextState: candidate, result: undefined }));
  return { aggregateBytes: planningAggregateUtf8Bytes(candidate) };
}

async function maximumExport() {
  const identity = 'capacity-maximum-internal';
  return requestScope.run({ identity, injectProviderFailure: false }, async () => {
    const summary = await handler({ action: 'getPersonalDataSummary' }, { userId: identity });
    if (
      !summary.success
      || summary.data.kind !== 'personal_data_summary'
      || summary.data.snapshotToken === null
    ) throw new Error('maximum_summary_unavailable');
    return handler({
      action: 'exportPersonalData',
      snapshotToken: summary.data.snapshotToken
    }, { userId: identity });
  });
}

async function maximumOverflow() {
  const userId = 'capacity-maximum-internal';
  const before = await repository.readExisting(userId);
  if (before === null) throw new Error('maximum_state_missing');
  const attempted = structuredClone(before) as PlanningAggregateState & {
    bodyProfiles: MutableProfile[];
  };
  const first = attempted.bodyProfiles[0]?.payload.avoidFoods[0];
  if (first === undefined) throw new Error('maximum_visible_value_missing');
  attempted.bodyProfiles[0]!.payload.avoidFoods[0] = `${first}x`;
  let errorCode = '';
  try {
    await repository.transact(userId, () => ({ nextState: attempted, result: undefined }));
  } catch (error: unknown) {
    errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'unknown';
  }
  const after = await repository.readExisting(userId);
  if (after === null) throw new Error('maximum_state_lost');
  return {
    errorCode,
    beforeBytes: planningAggregateUtf8Bytes(before),
    afterBytes: planningAggregateUtf8Bytes(after),
    attemptedBytes: planningAggregateUtf8Bytes(attempted)
  };
}

async function readBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 10 * 1024 * 1024) throw new Error('request_too_large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error('PORT is required');

const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    if (request.method !== 'POST') throw new Error('method_not_allowed');
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const body = await readBody(request);
    let result: unknown;
    if (pathname === '/seed-maximum') result = await seedMaximumAggregate();
    else if (pathname === '/maximum-export') result = await maximumExport();
    else if (pathname === '/maximum-overflow') result = await maximumOverflow();
    else {
      const identity = requiredIdentity(request.headers);
      if (pathname === '/seed') result = await requestScope.run(
        { identity, injectProviderFailure: false },
        () => seed(identity)
      );
      else if (pathname === '/inspect') result = await inspect(identity);
      else if (pathname === '/api') {
        const injectProviderFailure = request.headers[
          'x-fitness-capacity-inject-provider-failure'
        ] === '1';
        result = await requestScope.run({ identity, injectProviderFailure }, () => (
          handler(body, { userId: identity })
        ));
      } else throw new Error('route_not_found');
    }
    response.statusCode = 200;
    response.end(JSON.stringify(result));
  } catch (error: unknown) {
    response.statusCode = 400;
    response.end(JSON.stringify({
      error: error instanceof Error ? error.message : 'unknown_error'
    }));
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`CAPACITY_SERVER_READY:${String(port)}\n`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
