import * as cloud from 'wx-server-sdk';
import { createDefaultCloudRuntimeAssistantHandler } from './cloud-runtime-handler';
import {
  createAssistantMain,
  type AssistantMainDependencies
} from './handler';
import { resolveRuntimeIdentity } from './runtime-identity';
import { createRuntimeAssistantHandler } from './runtime-handler';

export {
  createAssistantMain as createMain,
  type AssistantMainDependencies as MainDependencies
} from './handler';

let defaultHandler: AssistantMainDependencies['handle'] | undefined;

function runtimeMode(): 'local' | 'cloud' {
  return process.env.FITNESS_RUNTIME_MODE === 'local' ? 'local' : 'cloud';
}

export const main = createAssistantMain({
  resolveIdentity: () => resolveRuntimeIdentity({
    runtimeMode: runtimeMode(),
    getWxContext: () => cloud.getWXContext(),
    localUserId: process.env.FITNESS_LOCAL_USER_ID
  }),
  handle: (input, context) => {
    defaultHandler ??= runtimeMode() === 'local'
      ? createRuntimeAssistantHandler({ runtimeMode: 'local' })
      : createDefaultCloudRuntimeAssistantHandler();
    return defaultHandler(input, context);
  }
});
