import { createDefaultCloudRuntimePlanningHandler } from './cloud-runtime-handler';
import { createMain, type MainDependencies } from './main-adapter';
import { resolveDefaultRuntimeIdentity } from './runtime-identity';

let defaultHandler: MainDependencies['handle'] | undefined;

export const main = createMain({
  resolveIdentity: () => resolveDefaultRuntimeIdentity(),
  handle: (input, context) => {
    defaultHandler ??= createDefaultCloudRuntimePlanningHandler();
    return defaultHandler(input, context);
  }
});
