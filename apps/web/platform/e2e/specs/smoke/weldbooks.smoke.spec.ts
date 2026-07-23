/**
 * Comprehensive smoke spec for WeldBooks — every authenticated route
 * in the module is verified to load, render the auth shell, and
 * leave no unexpected console errors.
 */

import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldbooks',
  '/weldbooks/dashboard',
  '/weldbooks/accounts',
  '/weldbooks/accounts/add',
  '/weldbooks/banking',
  '/weldbooks/banking/import',
  '/weldbooks/banking/reconciliation',
  '/weldbooks/banking/rules',
  '/weldbooks/banking/transactions',
  '/weldbooks/bills',
  '/weldbooks/bills/add',
  '/weldbooks/credit-notes',
  '/weldbooks/customers',
  '/weldbooks/customers/add',
  '/weldbooks/documents',
  '/weldbooks/entities',
  '/weldbooks/entities/add',
  '/weldbooks/invoices',
  '/weldbooks/invoices/add',
  '/weldbooks/journal',
  '/weldbooks/journal/add',
  '/weldbooks/recurring',
  '/weldbooks/recurring/add',
  '/weldbooks/reports',
  '/weldbooks/reports/aged-payables',
  '/weldbooks/reports/aged-receivables',
  '/weldbooks/reports/balance-sheet',
  '/weldbooks/reports/cash-flow',
  '/weldbooks/reports/general-ledger',
  '/weldbooks/reports/profit-loss',
  '/weldbooks/reports/trial-balance',
  '/weldbooks/settings',
  '/weldbooks/suppliers',
  '/weldbooks/vat',
];

test.describe('WeldBooks · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
