import { test, expect, type Page } from '@playwright/test';

async function waitForV2Shell(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.ui-v2').waitFor({ timeout: 8000 });
}

async function selectProject(page: Page) {
  const project = page.locator('text=edgeclaw-opc').first();
  await project.click();
  await page.waitForTimeout(500);
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 5000 });
}

// ── Dashboard ──────────────────────────────────────────────

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await waitForV2Shell(page);
  });

  test('D1: DashboardV2 renders with stats', async ({ page }) => {
    await selectProject(page);
    await page.getByRole('tab', { name: 'Dashboard' }).click();
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).not.toContainText('Something went wrong');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Requests')).toBeVisible();
    await expect(page.locator('text=Tokens')).toBeVisible();
    await expect(page.locator('text=Cost')).toBeVisible();
    await expect(page.locator('text=Recent routes')).toBeVisible();
  });

  test('D2: Always-On renders', async ({ page }) => {
    await page.getByRole('tab', { name: 'Always-On' }).click();
    await page.waitForTimeout(1500);
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });

  test('D3: Memory tab renders', async ({ page }) => {
    await page.getByRole('tab', { name: 'Memory' }).first().click();
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });
});

// ── Settings ───────────────────────────────────────────────

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await waitForV2Shell(page);
  });

  test('S1: Config tab shows YAML editor', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Config' }).click();
    await page.getByRole('button', { name: 'Raw YAML' }).click();
    const yamlEditor = page.locator('textarea.font-mono');
    await expect(yamlEditor).toBeVisible({ timeout: 5000 });
    await expect(yamlEditor).not.toHaveValue('', { timeout: 8000 });
    const yaml = await yamlEditor.inputValue();
    expect(yaml).toContain('router');
    expect(yaml).toContain('httpsProxy');
  });

  test('S2: Appearance tab renders', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.waitForTimeout(500);
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });

  test('S3: Config Form view has subsections', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Config' }).click();
    await page.getByRole('button', { name: 'Form' }).waitFor({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Runtime' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Models' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Router' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gateway' })).toBeVisible();
  });

  test('S4: Router subsection renders', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Config' }).click();
    await page.getByRole('button', { name: 'Router' }).click();
    await page.waitForTimeout(500);
    await expect(page.locator('body')).not.toContainText('Something went wrong');
    await expect(page.getByRole('heading', { name: 'Router' })).toBeVisible({ timeout: 3000 });
  });

  test('S5: Router tab via programmatic open', async ({ page }) => {
    await page.evaluate(() => (window as any).openSettings?.('router'));
    await page.waitForTimeout(1000);
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });

  test('S6: Config read-write-reread roundtrip', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Config' }).click();

    // Use Form view to edit apiTimeoutMs via spinbutton (reliable React change detection)
    await page.getByRole('button', { name: 'Runtime' }).click();
    const timeoutInput = page.locator('input[type="number"]').last();
    await expect(timeoutInput).toBeVisible({ timeout: 5000 });
    const origVal = await timeoutInput.inputValue();
    const sentinel = origVal === '119999' ? '120000' : '119999';

    await timeoutInput.click({ clickCount: 3 });
    await page.keyboard.type(sentinel);

    const saveBtn = page.getByRole('button', { name: /Save.*reload/i });
    await expect(saveBtn).toBeEnabled({ timeout: 5000 });
    await saveBtn.click();
    await page.waitForTimeout(3000);
    await expect(page.locator('body')).not.toContainText('Something went wrong');

    // Verify via Raw YAML
    await page.getByRole('button', { name: 'Raw YAML' }).click();
    const yamlEditor = page.locator('textarea.font-mono');
    await expect(yamlEditor).toBeVisible({ timeout: 5000 });
    await expect(yamlEditor).not.toHaveValue('', { timeout: 8000 });
    const afterSave = await yamlEditor.inputValue();
    expect(afterSave).toContain(`apiTimeoutMs: ${sentinel}`);

    // Cleanup: restore original via Form using keyboard input
    await page.getByRole('button', { name: 'Form' }).click();
    await page.getByRole('button', { name: 'Runtime' }).click();
    const restoreInput = page.locator('input[type="number"]').last();
    await restoreInput.click({ clickCount: 3 });
    await page.keyboard.type(origVal);
    const restoreBtn = page.getByRole('button', { name: /Save.*reload/i });
    await expect(restoreBtn).toBeEnabled({ timeout: 5000 });
    await restoreBtn.click();
    await page.waitForTimeout(2000);
  });
});
