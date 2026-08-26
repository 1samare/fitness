export type PreparedImageMediaType = 'image/jpeg' | 'image/png';

export interface PreparedMemoryImage {
  readonly mediaType: PreparedImageMediaType;
  readonly dataUrl: string;
  readonly sizeBytes: number;
}

export type ImageValidationFailureReason =
  | 'unsupported_type'
  | 'file_too_large'
  | 'decode_failed';

export class ImageValidationError extends Error {
  public readonly code = 'image_invalid' as const;

  public constructor(public readonly reason: ImageValidationFailureReason) {
    super('The selected image is invalid');
    this.name = 'ImageValidationError';
  }
}

export interface ImageResizeOptions {
  readonly maxDimension: number;
  readonly quality: number;
}

export interface ImagePreparationServiceOptions {
  readonly resize: (
    file: File,
    options: ImageResizeOptions
  ) => Promise<PreparedMemoryImage>;
  readonly maximumBytes?: number;
}

export function createImagePreparationService(options: ImagePreparationServiceOptions) {
  const maximumBytes = options.maximumBytes ?? 10 * 1024 * 1024;
  return {
    async prepare(file: File): Promise<PreparedMemoryImage> {
      if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
        throw new ImageValidationError('unsupported_type');
      }
      if (file.size <= 0 || file.size > maximumBytes) {
        throw new ImageValidationError('file_too_large');
      }
      try {
        return await options.resize(file, { maxDimension: 1_280, quality: 0.82 });
      } catch (error: unknown) {
        if (error instanceof ImageValidationError) throw error;
        throw new ImageValidationError('decode_failed');
      }
    }
  };
}

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new ImageValidationError('decode_failed'));
    }, { once: true });
    reader.addEventListener('error', () => {
      reject(new ImageValidationError('decode_failed'));
    }, {
      once: true
    });
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new ImageValidationError('decode_failed'));
      else resolve(blob);
    }, 'image/jpeg', quality);
  });
}

export async function resizeImageInBrowser(
  file: File,
  options: ImageResizeOptions
): Promise<PreparedMemoryImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, options.maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (context === null) throw new ImageValidationError('decode_failed');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, options.quality);
    return {
      mediaType: 'image/jpeg',
      dataUrl: await blobAsDataUrl(blob),
      sizeBytes: blob.size
    };
  } finally {
    bitmap.close();
  }
}

export const browserImagePreparationService = createImagePreparationService({
  resize: resizeImageInBrowser
});
