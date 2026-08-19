import { describe, expect, test, vi } from 'vitest';
import { CloudBaseFunctionVisionBackend } from './cloudbase-function-vision-backend';

describe('CloudBaseFunctionVisionBackend', () => {
  test('calls only the configured CloudBase function with a private fileID', async () => {
    const callFunction = vi.fn().mockResolvedValue({ result: { requestId: 'r1', candidates: [] } });
    const backend = new CloudBaseFunctionVisionBackend(callFunction, 'fitness-vision');

    await expect(backend.recognizePrivateFile('cloud://env.bucket/photo.jpg'))
      .resolves.toEqual({ requestId: 'r1', candidates: [] });
    expect(callFunction).toHaveBeenCalledWith({
      name: 'fitness-vision',
      data: { privateFileId: 'cloud://env.bucket/photo.jpg' }
    });
  });

  test('rejects invalid configured function names before an external call', async () => {
    const callFunction = vi.fn();

    expect(() => new CloudBaseFunctionVisionBackend(callFunction, 'fitness/vision')).toThrow();
    expect(callFunction).not.toHaveBeenCalled();
  });

  test('rejects a malformed nested function response without exposing it', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: { requestId: 'r1', candidates: [], privateFileId: 'cloud://secret/photo.jpg' }
    });
    const backend = new CloudBaseFunctionVisionBackend(callFunction, 'fitness-vision');

    await expect(backend.recognizePrivateFile('cloud://env.bucket/photo.jpg'))
      .rejects.toMatchObject({ code: 'provider_unavailable', reason: 'invalid_response' });
  });
});
