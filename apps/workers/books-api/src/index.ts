/**
 * WeldSuite books-api — the WeldBooks (accounting contacts, entities,
 * documents, settings, reports, dashboard and exports, GL accounts, journal
 * entries, invoices, recurring invoices, bills, payments, bank accounts and
 * transactions, reconciliation rules, tax rates, VAT returns, ICP
 * declarations, fiscal periods, FX rates) module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { accountingContactsRoutes } from './routes/accounting-contacts';
import { accountingDashboardRoutes } from './routes/accounting-dashboard';
import { accountingDocumentsRoutes } from './routes/accounting-documents';
import { accountingEntitiesRoutes } from './routes/accounting-entities';
import { accountingExportsRoutes } from './routes/accounting-exports';
import { accountingReportsRoutes } from './routes/accounting-reports';
import { accountingSettingsRoutes } from './routes/accounting-settings';
import { bankAccountsRoutes } from './routes/bank-accounts';
import { bankTransactionsRoutes } from './routes/bank-transactions';
import { billsRoutes } from './routes/bills';
import { fiscalPeriodsRoutes } from './routes/fiscal-periods';
import { fxRatesRoutes } from './routes/fx-rates';
import { glAccountsRoutes } from './routes/gl-accounts';
import { icpDeclarationsRoutes } from './routes/icp-declarations';
import { invoicesRoutes } from './routes/invoices';
import { journalEntriesRoutes } from './routes/journal-entries';
import { paymentsRoutes } from './routes/payments';
import { reconciliationRulesRoutes } from './routes/reconciliation-rules';
import { recurringInvoicesRoutes } from './routes/recurring-invoices';
import { taxRatesRoutes } from './routes/tax-rates';
import { vatReturnsRoutes } from './routes/vat-returns';
import type { Env, Variables } from './types';
import { registerBooksWorkspace, runBooksDailySweep } from './cron/books-sweep';

const app = createModuleApi<Env, Variables>({ service: 'books-api' });

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Remember which workspaces use WeldBooks, so the daily sweep only opens those tenants.
app.use('/api/*', async (c, next) => {
  await next();
  const orgId = c.get('orgId');
  if (orgId) c.executionCtx.waitUntil(registerBooksWorkspace(c.env, orgId));
});

// Object-based routes, in app-api's mount order.
app.route('/api/accounting-contacts', accountingContactsRoutes);
app.route('/api/accounting-dashboard', accountingDashboardRoutes);
app.route('/api/accounting-documents', accountingDocumentsRoutes);
app.route('/api/accounting-entities', accountingEntitiesRoutes);
app.route('/api/accounting-exports', accountingExportsRoutes);
app.route('/api/icp-declarations', icpDeclarationsRoutes);
app.route('/api/accounting-reports', accountingReportsRoutes);
app.route('/api/accounting-settings', accountingSettingsRoutes);
app.route('/api/bank-accounts', bankAccountsRoutes);
app.route('/api/bank-transactions', bankTransactionsRoutes);
app.route('/api/bills', billsRoutes);
app.route('/api/fiscal-periods', fiscalPeriodsRoutes);
app.route('/api/fx-rates', fxRatesRoutes);
app.route('/api/gl-accounts', glAccountsRoutes);
app.route('/api/invoices', invoicesRoutes);
app.route('/api/journal-entries', journalEntriesRoutes);
app.route('/api/payments', paymentsRoutes);
app.route('/api/reconciliation-rules', reconciliationRulesRoutes);
app.route('/api/recurring-invoices', recurringInvoicesRoutes);
app.route('/api/tax-rates', taxRatesRoutes);
app.route('/api/vat-returns', vatReturnsRoutes);

export default {
  fetch: app.fetch,
  // Daily at 03:00 UTC: overdue invoices, due recurring invoices, ECB rates.
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      runBooksDailySweep(env).catch((err) => {
        console.error('[books-sweep] failed:', err);
      }),
    );
  },
};
