import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// Run against a built local preview; no account or workspace is created.
const base = process.env.PLATFORM_URL || 'http://127.0.0.1:3022';
const output = process.env.ONBOARDING_QA_DIR || 'test-results/onboarding-preview';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/preview/help-docs?scene=onboarding`, { waitUntil: 'networkidle' });
    await page.locator('[data-screenshot-ready="true"]').waitFor();
    await page.getByRole('heading', { name: 'Create your workspace' }).waitFor();
    assert.equal(await page.getByLabel('Workspace name').inputValue(), 'Acme Studio');
    assert.equal(await page.getByRole('button', { name: 'Create workspace' }).isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name}: horizontal overflow`);
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    await page.locator('summary').filter({ hasText: 'Country and data storage' }).click();
    await page.getByLabel('Country', { exact: true }).selectOption('US');
    assert.equal(await page.getByLabel('Data storage region').inputValue(), 'aws-us-east-1');
    await page.getByLabel('Data storage region').selectOption('aws-eu-west-2');
    await page.getByLabel('Country', { exact: true }).selectOption('AU');
    assert.equal(await page.getByLabel('Data storage region').inputValue(), 'aws-eu-west-2');
    await page.locator('summary').filter({ hasText: 'Choose apps (optional)' }).click();
    await page.getByText('The app list is not available yet.', { exact: false }).waitFor();
    await page.getByLabel('Workspace name').fill('   ');
    assert.equal(await page.getByRole('button', { name: 'Create workspace' }).isDisabled(), true);
    await page.getByLabel('Workspace name').fill('Mobile team');
    assert.equal(await page.getByRole('button', { name: 'Create workspace' }).isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name}: expanded horizontal overflow`);
    await page.screenshot({ path: `${output}/${name}-expanded.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`${name}: name validation, location defaults/override, empty catalog, layout, and runtime checks passed`);
    await page.close();
  }
} finally {
  await browser.close();
}
