import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppRouteElements } from '../../app/routes';
import type {
  IngredientPhotoPageRuntime,
  IngredientPhotoPageSnapshot
} from '../../app/pages/IngredientPhotoPage';

afterEach(() => cleanup());

describe('in-memory ingredient photo Web experience', () => {
  test('requires an explicit candidate and gram confirmation before inventory changes', async () => {
    const selected: IngredientPhotoPageSnapshot = {
      status: 'ready',
      previewUrl: 'data:image/jpeg;base64,cHJldmlldw==',
      candidates: []
    };
    const candidates: IngredientPhotoPageSnapshot = {
      ...selected,
      status: 'candidates',
      candidates: [
        { id: 'food-chicken-breast', name: '鸡胸肉', confidence: 0.94, state: '熟' }
      ]
    };
    const runtime: IngredientPhotoPageRuntime = {
      selectImage: vi.fn(async () => selected),
      recognize: vi.fn(async () => candidates),
      confirm: vi.fn(async (): Promise<IngredientPhotoPageSnapshot> => ({ status: 'confirmed', candidates: [], notice: '已确认写入测试库存。' })),
      cancel: vi.fn(async (): Promise<IngredientPhotoPageSnapshot> => ({ status: 'idle', candidates: [] }))
    };

    render(
      <MemoryRouter initialEntries={['/ingredients/photo']}>
        <AppRouteElements ingredientPhotoRuntime={runtime} />
      </MemoryRouter>
    );

    const file = new File(['image'], 'ingredient.jpg', { type: 'image/jpeg' });
    fireEvent.change(await screen.findByLabelText('选择 JPEG 或 PNG 图片'), {
      target: { files: [file] }
    });
    expect(await screen.findByAltText('待识别食材预览')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发送图片并获取候选' }));
    expect(await screen.findByText('鸡胸肉')).toBeTruthy();
    expect(runtime.confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('选择鸡胸肉'));
    fireEvent.change(screen.getByLabelText('确认克数'), { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: '确认候选并写入库存' }));

    expect(await screen.findByText('已确认写入测试库存。')).toBeTruthy();
    expect(runtime.confirm).toHaveBeenCalledWith('food-chicken-breast', 180);
  });

  test('shows manual fallback when no vision runtime is configured', async () => {
    render(
      <MemoryRouter initialEntries={['/ingredients/photo']}>
        <AppRouteElements />
      </MemoryRouter>
    );

    expect(await screen.findByText('图片识别当前不可用，请改用手动库存录入。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '前往手动录入' })).toBeTruthy();
  });
});
