/**
 * Smoke spec for the WeldBooks fixed assets, payroll import, tax calendar and
 * fiscal period screens: each route loads in the auth shell with no
 * unexpected console errors. The depreciation, payroll and calendar flows
 * themselves are covered by the component tests next to the screens.
 */

import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldbooks/fixed-assets',
  '/weldbooks/fixed-assets/new',
  '/weldbooks/fixed-assets/depreciation',
  '/weldbooks/fixed-assets/tax-depreciation',
  '/weldbooks/payroll',
  '/weldbooks/payroll/import',
  '/weldbooks/payroll/connections',
  '/weldbooks/tax-calendar',
  '/weldbooks/fiscal-periods',
];

test.describe('WeldBooks assets, payroll and calendars · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
