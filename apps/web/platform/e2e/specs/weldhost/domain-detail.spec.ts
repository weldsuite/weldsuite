/**
 * CRUD spec for the dynamic /weldhost/domains/$id route.
 *
 * Covers:
 *   - DNS / Nameservers / Settings tabs render on the detail page
 *   - "Add Record" inline form opens and closes
 *   - Settings tab auto-renew toggle + Save button are present
 *
 * Cleanup uses scoped per-entity deleteEntity() calls instead of global reset().
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

test.describe('WeldHost · domain detail page', () => {
  let seeded: { type: SeedEntityType; id: string } | null = null;

  test.beforeAll(() => {
    test.skip(
      !isTestFixturesConfigured(),
      'test-fixtures env vars not set',
    );
  });

  test.afterEach(async ({ api }) => {
    if (seeded) {
      await api.deleteEntity(seeded.type, seeded.id);
      seeded = null;
    }
  });

  test('DNS tab renders on domain detail page', async ({ page, api }) => {
    const domain = await api.seedDomain({ name: 'e2etest', tld: 'com' });
    seeded = { type: 'domain', id: domain.id };
    await page.goto(`/weldhost/domains/${domain.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: /dns/i })).toBeVisible({ timeout: 10_000 });
  });

  test('Nameservers tab is reachable on domain detail page', async ({ page, api }) => {
    const domain = await api.seedDomain({ name: 'e2etest', tld: 'com' });
    seeded = { type: 'domain', id: domain.id };
    await page.goto(`/weldhost/domains/${domain.id}`);
    await page.getByRole('tab', { name: /nameservers/i }).click();
    await expect(page).toHaveURL(new RegExp(domain.id));
  });

  test('Settings tab is reachable and shows auto-renew toggle', async ({ page, api }) => {
    const domain = await api.seedDomain({ name: 'e2etest', tld: 'com' });
    seeded = { type: 'domain', id: domain.id };
    await page.goto(`/weldhost/domains/${domain.id}`);
    await page.getByRole('tab', { name: /settings/i }).click();
    const toggleSwitch = page.getByRole('switch');
    await expect(toggleSwitch).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /save settings/i })).toBeVisible();
  });

  test.fixme(
    'Add DNS record inline form opens and cancels',
    // The "Add Record" button only renders when canManageDns=true, which
    // requires a seeded domain that has a Cloudflare DNS zone with an
    // externalZoneId. The current seed/domain endpoint does not provision
    // a DNS zone, so this test cannot run until a seed/dns-zone endpoint
    // (or an extended seed/domain payload) is added.
    async ({ page, api }) => {
      const domain = await api.seedDomain({ name: 'e2etest', tld: 'com' });
      seeded = { type: 'domain', id: domain.id };
      await page.goto(`/weldhost/domains/${domain.id}`);
      const addBtn = page.getByRole('button', { name: /add record/i }).first();
      await expect(addBtn).toBeVisible({ timeout: 10_000 });
      await addBtn.click();
      await expect(page.getByRole('button', { name: /cancel/i })).toBeVisible();
      await page.getByRole('button', { name: /cancel/i }).click();
      await expect(page.getByRole('button', { name: /add record/i })).toBeVisible({ timeout: 5_000 });
    },
  );
});
