import { describe, expect, test, vi } from 'vitest';
import { CloudBasePrivatePhotoStorage } from './cloudbase-private-photo-storage';

describe('CloudBasePrivatePhotoStorage', () => {
  test('sniffs JPEG bytes and treats missing deletion as success', async () => {
    const client = {
      downloadFile: vi.fn().mockResolvedValue({ fileContent: new Uint8Array([0xff, 0xd8, 0xff, 0x00]) }),
      deleteFile: vi.fn().mockResolvedValue({
        requestId: 'delete-r1',
        fileList: [{ fileID: 'cloud://env.bucket/photo.jpg', code: 'STORAGE_FILE_NONEXIST' }]
      })
    };
    const storage = new CloudBasePrivatePhotoStorage(client);

    await expect(storage.inspectPrivateFile({ privateFileId: 'cloud://env.bucket/photo.jpg' }))
      .resolves.toEqual({ mediaType: 'image/jpeg', sizeBytes: 4 });
    await expect(storage.deletePrivateFile({ privateFileId: 'cloud://env.bucket/photo.jpg' }))
      .resolves.toBe('not_found');
  });

  test('accepts a PNG signature and rejects an oversized private image', async () => {
    const client = {
      downloadFile: vi.fn()
        .mockResolvedValueOnce({ fileContent: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) })
        .mockResolvedValueOnce({ fileContent: new Uint8Array((10 * 1024 * 1024) + 1) }),
      deleteFile: vi.fn()
    };
    const storage = new CloudBasePrivatePhotoStorage(client);

    await expect(storage.inspectPrivateFile({ privateFileId: 'cloud://env.bucket/photo.png' }))
      .resolves.toEqual({ mediaType: 'image/png', sizeBytes: 8 });
    await expect(storage.inspectPrivateFile({ privateFileId: 'cloud://env.bucket/photo.jpg' }))
      .rejects.toMatchObject({ code: 'storage_unavailable' });
  });

  test('rejects invalid bytes and unexpected deletion results with stable errors', async () => {
    const client = {
      downloadFile: vi.fn().mockResolvedValue({ fileContent: 'not-bytes' }),
      deleteFile: vi.fn().mockResolvedValue({ fileList: [{ code: 'FAILED', message: 'cloud://secret/photo.jpg' }] })
    };
    const storage = new CloudBasePrivatePhotoStorage(client);

    await expect(storage.inspectPrivateFile({ privateFileId: 'cloud://env.bucket/photo.jpg' }))
      .rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(storage.deletePrivateFile({ privateFileId: 'cloud://env.bucket/photo.jpg' }))
      .rejects.toMatchObject({ code: 'storage_unavailable' });
  });
});
