import { randomUUID } from 'node:crypto';
import * as cloud from 'wx-server-sdk';
import { createVersionedPlanningService } from '@fitness/application';
import type { PlanningApiResponse } from '@fitness/contracts';
import {
  CloudBasePlanningRepository,
  InMemoryPlanningRepository,
  type CloudBaseDatabase
} from '@fitness/persistence';
import {
  createPlanningApiHandler,
  type TrustedRequestContext
} from './handler';
import { adaptWxCloudBaseDatabase } from './wx-database-adapter';

interface CommonRuntimeOptions {
  readonly now?: (() => string) | undefined;
  readonly nextId?: ((prefix: string) => string) | undefined;
}

export type RuntimePlanningHandlerOptions = CommonRuntimeOptions & (
  | {
      readonly runtimeMode: 'cloud';
      readonly database: CloudBaseDatabase;
    }
  | {
      readonly runtimeMode: 'local';
    }
);

export function createRuntimePlanningHandler(options: RuntimePlanningHandlerOptions): (
  input: unknown,
  context?: TrustedRequestContext
) => Promise<PlanningApiResponse> {
  const repository = options.runtimeMode === 'cloud'
    ? new CloudBasePlanningRepository(options.database)
    : new InMemoryPlanningRepository();
  const service = createVersionedPlanningService({
    repository,
    now: options.now ?? (() => new Date().toISOString()),
    nextId: options.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`)
  });
  return createPlanningApiHandler(service);
}

export function createDefaultRuntimePlanningHandler() {
  if (process.env.FITNESS_RUNTIME_MODE === 'local') {
    return createRuntimePlanningHandler({ runtimeMode: 'local' });
  }
  cloud.init();
  return createRuntimePlanningHandler({
    runtimeMode: 'cloud',
    database: adaptWxCloudBaseDatabase(cloud.database())
  });
}
