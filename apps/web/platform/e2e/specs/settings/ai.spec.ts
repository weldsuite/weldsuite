/**
 * Settings > AI on a Kubernetes install (EU edition test environment).
 *
 * Runs only against a Kubernetes install that has AI configured: the page
 * and `GET /api/ai-settings` exist there and nowhere else (Global has
 * neither). The spec skips itself unless
 *   - `E2E_KUBERNETES=1` is set, and
 *   - the target's `/config.json` carries an `ai` block, and
 *   - `E2E_ANTHROPIC_API_KEY` holds a test key of the workspace's own to
 *     store (never commit one; the key is typed into a masked field and the
 *     page must only ever show its hint afterwards).
 *
 * Flow: enable Claude with an own key, set it for WeldMail, check the badge in
 * the mail account's AI dialog, then put everything back (override cleared,
 * key removed, Claude switched off) so the environment stays on Mistral.
 *
 * Written for the Kubernetes test environment; not run in the Global CI.
 */

import { test, expect } from '../../fixtures';

const OWN_KEY = process.env.E2E_ANTHROPIC_API_KEY;

test.describe('Settings · AI (Kubernetes)', () => {
  test.skip(process.env.E2E_KUBERNETES !== '1', 'Needs a Kubernetes install (E2E_KUBERNETES=1)');
  test.skip(!OWN_KEY, "Needs E2E_ANTHROPIC_API_KEY, a test key for the workspace's own account");

  test.beforeEach(async ({ page, request, baseURL }) => {
    const config = await request.get(new URL('/config.json', baseURL).toString());
    test.skip(!config.ok() || !(await config.json()).ai, 'This install has no AI configured');
    await page.goto('/settings/ai');
    await expect(page.getByRole('heading', { name: 'AI', exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test('enables Claude with an own key, sets it for mail and shows the region badge', async ({ page }) => {
    // Mistral is the default and is processed in the EU.
    const mistral = page.getByTestId('ai-provider-mistral');
    await expect(mistral).toContainText('Processed in the EU · default');

    // Switching Claude on asks for an acknowledgement first.
    await page.getByRole('switch', { name: 'Allow Claude' }).click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: 'Switch on' });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await confirm.click();
    await expect(dialog).toBeHidden();

    // Own key: only the hint comes back.
    const claude = page.getByTestId('ai-provider-anthropic');
    await claude.getByRole('radio', { name: 'Our own API key' }).click();
    const field = claude.getByLabel('API key');
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill(OWN_KEY!);
    await claude.getByRole('button', { name: 'Save and check' }).click();
    await expect(claude.getByText(/Saved key: /)).toBeVisible({
      timeout: 20_000,
    });
    await expect(claude.getByText('Key works')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(OWN_KEY!);

    // Mail runs on Claude.
    await page.getByRole('combobox', { name: 'WeldMail' }).click();
    await page.getByRole('option', { name: /^Claude \(provider default\)/ }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('AI settings saved').first()).toBeVisible();
    await expect(page.getByTestId('ai-feature-mail')).toContainText('outside the EU');

    // The mail account's AI dialog lists models with their region.
    await page.goto('/settings/apps/weldmail');
    await page.getByRole('button', { name: /AI/ }).first().click();
    await page.getByRole('combobox', { name: /model preference/i }).click();
    await expect(page.getByRole('option', { name: /Claude/ }).first()).toContainText('outside the EU');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Put the environment back on Mistral.
    await page.goto('/settings/ai');
    await page.getByRole('combobox', { name: 'WeldMail' }).click();
    await page.getByRole('option', { name: 'Default', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('AI settings saved').first()).toBeVisible();
    await claude.getByRole('button', { name: 'Remove key' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove key' }).click();
    await page.getByRole('switch', { name: 'Allow Claude' }).click();
    await expect(page.getByRole('switch', { name: 'Allow Claude' })).not.toBeChecked();
  });
});
