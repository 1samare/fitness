import type { PrivatePhotoStorage } from '@fitness/domain';
import { StorageUnavailableError, VISION_PROVIDER_POLICY_V1 } from './vision-provider-policy';

export interface CloudBasePrivateFileClient {
  downloadFile(input: { readonly fileID: string }): Promise<unknown>;
  deleteFile(input: { readonly fileList: readonly string[] }): Promise<unknown>;
}

export class CloudBasePrivatePhotoStorage implements PrivatePhotoStorage {
  public constructor(private readonly client: CloudBasePrivateFileClient) {}

  public async inspectPrivateFile(input: { readonly privateFileId: string }): Promise<{
    readonly mediaType: 'image/jpeg' | 'image/png';
    readonly sizeBytes: number;
  }> {
    const content = await this.downloadBytes(input.privateFileId);
    if (content.byteLength > VISION_PROVIDER_POLICY_V1.maximumFileBytes) {
      throw new StorageUnavailableError();
    }
    const mediaType = mediaTypeFromSignature(content);
    if (mediaType === null) throw new StorageUnavailableError();
    return { mediaType, sizeBytes: content.byteLength };
  }

  public async deletePrivateFile(input: { readonly privateFileId: string }): Promise<'deleted' | 'not_found'> {
    let rawResponse: unknown;
    try {
      rawResponse = await this.client.deleteFile({ fileList: [input.privateFileId] });
    } catch {
      throw new StorageUnavailableError();
    }
    const code = deletionCode(rawResponse);
    if (code === 'SUCCESS') return 'deleted';
    if (code === 'STORAGE_FILE_NONEXIST' || code === 'NOT_FOUND') return 'not_found';
    throw new StorageUnavailableError();
  }

  private async downloadBytes(privateFileId: string): Promise<Uint8Array> {
    let rawResponse: unknown;
    try {
      rawResponse = await this.client.downloadFile({ fileID: privateFileId });
    } catch {
      throw new StorageUnavailableError();
    }
    if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) {
      throw new StorageUnavailableError();
    }
    const fileContent = (rawResponse as { readonly fileContent?: unknown }).fileContent;
    if (!(fileContent instanceof Uint8Array)) throw new StorageUnavailableError();
    return fileContent;
  }
}

function mediaTypeFromSignature(content: Uint8Array): 'image/jpeg' | 'image/png' | null {
  const isJpeg = content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (isJpeg) return 'image/jpeg';
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
  const isPng = content.length >= pngSignature.length && pngSignature.every((byte, index) => content[index] === byte);
  return isPng ? 'image/png' : null;
}

function deletionCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fileList = (value as { readonly fileList?: unknown }).fileList;
  if (!Array.isArray(fileList) || fileList.length !== 1) return null;
  const entry = fileList[0];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const code = (entry as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
