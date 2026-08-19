import { visionProviderResponseSchema } from '@fitness/contracts';
import { ProviderUnavailableError } from './vision-provider-policy';

export interface CloudBaseFunctionCaller {
  (input: {
    readonly name: string;
    readonly data: { readonly privateFileId: string };
  }): Promise<unknown>;
}

export class CloudBaseFunctionVisionBackend {
  public constructor(
    private readonly callFunction: CloudBaseFunctionCaller,
    private readonly functionName: string
  ) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(functionName)) {
      throw new Error('Invalid CloudBase function name');
    }
  }

  public async recognizePrivateFile(privateFileId: string): Promise<unknown> {
    let rawResponse: unknown;
    try {
      rawResponse = await this.callFunction({
        name: this.functionName,
        data: { privateFileId }
      });
    } catch {
      throw new ProviderUnavailableError('transport_unavailable');
    }
    const result = nestedResult(rawResponse);
    const parsed = visionProviderResponseSchema.safeParse(result);
    if (!parsed.success) throw new ProviderUnavailableError('invalid_response');
    return parsed.data;
  }
}

function nestedResult(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as { readonly result?: unknown }).result;
}
