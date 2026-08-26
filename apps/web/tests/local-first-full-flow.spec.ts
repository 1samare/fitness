import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function installModelStub(page: Page, mode: 'available' | 'invalid' = 'available') {
  await page.route('**/__playwright__/v1/chat/completions', async (route) => {
    if (mode === 'invalid') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'playwright-invalid',
          choices: [{ message: { content: '{}' } }]
        })
      });
      return;
    }
    const body = route.request().postData() ?? '';
    const content = body.includes('image_url')
      ? JSON.stringify({
          candidates: [{ name: '测试米饭', confidence: 0.97, foodState: 'cooked' }]
        })
      : JSON.stringify({ kind: 'reject', reason: 'unsupported_request' });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'playwright-request',
        choices: [{ message: { content } }],
        usage: { total_tokens: 9 }
      })
    });
  });
}

async function completeStructuredSetup(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '尚未确认内部测试边界' })).toBeVisible();
  await page.getByRole('button', { name: '确认边界并继续' }).click();
  await page.getByRole('link', { name: '开始结构化建档' }).click();
  await page.getByLabel('健身目标').selectOption('muscle_gain');
  const trainingDays = page.locator('.training-day');
  for (const index of [0, 2]) {
    const day = trainingDays.nth(index);
    await day.locator('input[type="checkbox"]').check();
    await day.locator('select').selectOption('02054');
    await day.locator('input[placeholder="分钟"]').fill('60');
  }
  await page.getByRole('button', { name: '保存并计算七日目标' }).click();
  await expect(page.getByRole('heading', { name: '每日能量与营养目标' })).toBeVisible();
  await expect(page.getByText('估算目标')).toHaveCount(7);
}

test('completes the local-first flow, backup restore and final deletion', async ({ page }, testInfo) => {
  await installModelStub(page);
  await completeStructuredSetup(page);

  await page.getByRole('link', { name: '七日餐单' }).click();
  await page.getByRole('button', { name: '保存测试库存' }).click();
  await expect(page.getByText('库存版本 v1')).toBeVisible();
  await page.getByRole('button', { name: '生成确定性七日餐单' }).click();
  await expect(page.getByText(/全天营养估算/)).toHaveCount(7, { timeout: 20_000 });
  await page.getByRole('button', { name: '按计划完成训练并重算' }).first().click();
  await expect(page.getByRole('heading', { name: /餐单版本 v2/ })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('link', { name: '图片识别' }).click();
  await page.getByLabel('选择 JPEG 或 PNG 图片').setInputFiles({
    name: 'synthetic-ingredient.png',
    mimeType: 'image/png',
    buffer: ONE_PIXEL_PNG
  });
  await page.getByRole('button', { name: '发送图片并获取候选' }).click();
  await expect(page.getByText('测试米饭', { exact: true })).toBeVisible();
  await page.getByLabel('选择测试米饭').check();
  await page.getByLabel('确认克数').fill('180');
  await page.getByRole('button', { name: '确认候选并写入库存' }).click();
  await expect(page.getByText('已确认写入测试库存。')).toBeVisible();

  await page.getByRole('link', { name: '数据与导出' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整本地备份' }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath('fitness-local-backup.json');
  await download.saveAs(backupPath);
  const backupText = await readFile(backupPath, 'utf8');
  expect(backupText).toContain('fitness-local-backup-v1');
  expect(backupText).not.toContain('playwright-synthetic-key-not-real');
  expect(backupText).not.toContain('data:image');

  await page.getByLabel('删除确认短语').fill('DELETE LOCAL DATA');
  await page.getByRole('button', { name: '永久删除本地账户' }).dispatchEvent('click');
  await expect(page.getByText('档案 v0 / 目标 v0 / 训练 v0', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '数据与导出' }).click();
  await page.getByLabel('选择本地备份文件').setInputFiles(backupPath);
  await page.getByLabel('确认覆盖当前本地数据').check();
  await page.getByRole('button', { name: '覆盖并恢复' }).dispatchEvent('click');
  await expect(page.getByText('档案 v1 / 目标 v1 / 训练 v1', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '七日餐单' }).click();
  await expect(page.getByRole('heading', { name: /餐单版本 v2/ })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('link', { name: '数据与导出' }).click();
  await page.getByLabel('删除确认短语').fill('DELETE LOCAL DATA');
  await page.getByRole('button', { name: '永久删除本地账户' }).dispatchEvent('click');
  await expect(page.getByText('档案 v0 / 目标 v0 / 训练 v0', { exact: true })).toBeVisible();
});

test('keeps manual recovery available and rejects a stale second-tab write', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await installModelStub(first, 'invalid');
  await completeStructuredSetup(first);

  const second = await context.newPage();
  await installModelStub(second, 'invalid');
  await second.goto('/setup');
  await expect(second.getByRole('heading', { name: '身体档案与一周计划' })).toBeVisible();
  await first.goto('/setup');
  await first.getByRole('button', { name: '保存并计算七日目标' }).click();
  await expect(first.getByRole('heading', { name: '每日能量与营养目标' })).toBeVisible();
  await second.getByRole('button', { name: '保存并计算七日目标' }).click();
  await expect(second.getByRole('alert')).toContainText('planning_version_changed');

  await second.getByRole('link', { name: '图片识别' }).click();
  await second.getByLabel('选择 JPEG 或 PNG 图片').setInputFiles({
    name: 'synthetic-ingredient.png',
    mimeType: 'image/png',
    buffer: ONE_PIXEL_PNG
  });
  await second.getByRole('button', { name: '发送图片并获取候选' }).click();
  await expect(second.getByText('图片识别当前不可用，请改用手动库存录入。')).toBeVisible();
  await expect(second.getByRole('link', { name: '前往手动录入' })).toBeVisible();
  await context.close();
});
