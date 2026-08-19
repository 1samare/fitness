import { createDefaultCloudRuntimePlanningHandler } from './cloud-runtime-handler';
import { resolveCloudRuntimeIdentity } from './cloud-runtime-identity';
import { createMain, type MainDependencies } from './main-adapter';

let defaultHandler: MainDependencies['handle'] | undefined;

export const main = createMain({
  resolveIdentity: () => resolveCloudRuntimeIdentity(),
  handle: (input, context) => {
    defaultHandler ??= createDefaultCloudRuntimePlanningHandler();
    return defaultHandler(input, context);
  }
});
