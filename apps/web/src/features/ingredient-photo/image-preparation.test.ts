import { describe, expect, test, vi } from 'vitest';
import {
  ImageValidationError,
  createImagePreparationService
} from './image-preparation';

describe('browser image preparation', () => {
  test.each([
    { file: new File(['gif'], 'food.gif', { type: 'image/gif' }), reason: 'unsupported_type' },
    {
      file: new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' }),
      reason: 'file_too_large'
    }
  ])('rejects invalid image input before decoding', async ({ file, reason }) => {
    const resize = vi.fn();
    const service = createImagePreparationService({ resize });

    const failure = await service.prepare(file).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImageValidationError);
    expect(failure).toMatchObject({ code: 'image_invalid', reason });
    expect(resize).not.toHaveBeenCalled();
  });

  test('always delegates an accepted JPEG/PNG to the memory-only resize boundary', async () => {
    const prepared = {
      mediaType: 'image/jpeg' as const,
      dataUrl: 'data:image/jpeg;base64,cmVzaXplZA==',
      sizeBytes: 7
    };
    const resize = vi.fn(() => Promise.resolve(prepared));
    const service = createImagePreparationService({ resize });
    const file = new File(['fixture'], 'food.png', { type: 'image/png' });

    await expect(service.prepare(file)).resolves.toEqual(prepared);
    expect(resize).toHaveBeenCalledWith(file, { maxDimension: 1_280, quality: 0.82 });
  });
});
