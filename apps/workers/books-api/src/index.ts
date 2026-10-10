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

import { WorkerEntrypoint } from 'cloudflare:workers';
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
import { accountingDimensionsRoutes } from './routes/accounting-dimensions';
import { bankConnectionsRoutes } from './routes/bank-connections';
import { bankDepositsRoutes } from './routes/bank-deposits';
import { bankReconciliationsRoutes } from './routes/bank-reconciliations';
import { exemptionCertificatesRoutes } from './routes/exemption-certificates';
import { fixedAssetsRoutes } from './routes/fixed-assets';
import { form1099Routes } from './routes/form-1099';
import { paymentRunsRoutes } from './routes/payment-runs';
import { payrollRoutes } from './routes/payroll';
import { salesTaxRoutes } from './routes/sales-tax';
import { salesTaxAgenciesRoutes } from './routes/sales-tax-agencies';
import { salesTaxJurisdictionsRoutes } from './routes/sales-tax-jurisdictions';
import { salesTaxRulesRoutes } from './routes/sales-tax-rules';
import { salesTaxZonesRoutes } from './routes/sales-tax-zones';
import { taxCalendarRoutes } from './routes/tax-calendar';
import { taxReturnsRoutes } from './routes/tax-returns';
import { w9RequestsRoutes } from './routes/w9-requests';
import { bankConnectionsInternalRoutes } from './routes/bank-connections/internal';
import { payrollInternalRoutes } from './routes/payroll/internal';
import { publicW9Routes } from './routes/public-w9';
import type { Env, Variables } from './types';
import { registerBooksWorkspace, runBooksDailySweep } from './cron/books-sweep';

const app = createModuleApi<Env, Variables>({ service: 'books-api' });

// Public W-9 form for vendors: no Clerk auth, the random token in the path is the credential.
app.route('/public/w9', publicW9Routes);

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

// US accounting (docs/plans/weldbooks-us.md).
app.route('/api/accounting-dimensions', accountingDimensionsRoutes);
app.route('/api/bank-connections', bankConnectionsRoutes);
app.route('/api/bank-deposits', bankDepositsRoutes);
app.route('/api/bank-reconciliations', bankReconciliationsRoutes);
app.route('/api/exemption-certificates', exemptionCertificatesRoutes);
app.route('/api/fixed-assets', fixedAssetsRoutes);
app.route('/api/form-1099', form1099Routes);
app.route('/api/payment-runs', paymentRunsRoutes);
app.route('/api/payroll', payrollRoutes);
app.route('/api/sales-tax', salesTaxRoutes);
app.route('/api/sales-tax-agencies', salesTaxAgenciesRoutes);
app.route('/api/sales-tax-jurisdictions', salesTaxJurisdictionsRoutes);
app.route('/api/sales-tax-rules', salesTaxRulesRoutes);
app.route('/api/sales-tax-zones', salesTaxZonesRoutes);
app.route('/api/tax-calendar', taxCalendarRoutes);
app.route('/api/tax-returns', taxReturnsRoutes);
app.route('/api/w9-requests', w9RequestsRoutes);

// Internal entrypoint, bound as BOOKS_INTERNAL (entrypoint = "BooksInternal") by
// integration-webhook-worker, integration-sync-worker and hr-api. A named entrypoint is
// only reachable over a service binding, so it is trusted by topology.
const internalApp = createModuleApi<Env, Variables>({ service: 'books-api' });
internalApp.use('*', async (c, next) => {
  c.set('internalTrusted', true);
  await next();
});
internalApp.route('/internal/bank-connections', bankConnectionsInternalRoutes);
// hr-api posts the journal of an approved WeldHR pay run here (source `weldhr`).
internalApp.route('/internal/payroll', payrollInternalRoutes);

export class BooksInternal extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    return internalApp.fetch(request, this.env, this.ctx);
  }
}

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
