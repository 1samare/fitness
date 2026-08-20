import * as cloud from 'wx-server-sdk';
import { createDefaultCloudRuntimeAssistantHandler } from './cloud-runtime-handler';
import {
  createAssistantMain,
  type AssistantMainDependencies,
  type TrustedAssistantRequestContext
} from './handler';

let defaultHandler: AssistantMainDependencies['handle'] | undefined;

function resolveCloudIdentity(): TrustedAssistantRequestContext | undefined {
  const userId = cloud.getWXContext().OPENID?.trim();
  return userId === undefined || userId.length === 0 ? undefined : { userId };
}

export const main = createAssistantMain({
  resolveIdentity: () => resolveCloudIdentity(),
  handle: (input, context) => {
    defaultHandler ??= createDefaultCloudRuntimeAssistantHandler();
    return defaultHandler(input, context);
  }
});
