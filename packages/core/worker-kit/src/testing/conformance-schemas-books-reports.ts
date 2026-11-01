/**
 * WeldBooks reports and US compliance (books-api's accounting reports,
 * dashboard, payroll and fixed assets) response schemas, by route. Spread into
 * BOOKS_ROUTES by conformance-schemas-books.ts. The CSV report downloads and
 * the XAF export are files, not JSON, so they have no schema.
 */
import {
  accountingDashboardSchema,
  agedReportSchema,
  balanceSheetReportSchema,
  breakdownReportSchema,
  cashFlowReportSchema,
  deMinimisCheckSchema,
  depreciationRunSchema,
  fixedAssetDetailSchema,
  fixedAssetDisposalSchema,
  fixedAssetFromBillLineSchema,
  fixedAssetListItemSchema,
  fixedAssetRegisterSchema,
  fixedAssetScheduleSchema,
  fixedAssetWriteResultSchema,
  generalLedgerReportSchema,
  midQuarterTestSchema,
  payrollCategorySchema,
  payrollConnectionSchema,
  payrollCsvImportResultSchema,
  payrollCsvMappingSchema,
  payrollImportDetailSchema,
  payrollImportSchema,
  payrollSyncResultSchema,
  profitLossReportSchema,
  taxDepreciationReportSchema,
  taxSummaryReportSchema,
  taxWorksheetSchema,
  trialBalanceReportSchema,
} from '@weldsuite/app-api-client/schemas/books-reports-responses';
import type { RouteSchema } from './conformance-schemas';

const REPORTS = '/api/accounting-reports';
const PAYROLL = '/api/payroll';
const ASSETS = '/api/fixed-assets';

export const BOOKS_REPORTS_ROUTES: RouteSchema[] = [
  // accounting reports (json and print; csv is a file)
  { method: 'GET', route: `${REPORTS}/profit-loss`, envelope: 'single', data: profitLossReportSchema },
  { method: 'GET', route: `${REPORTS}/balance-sheet`, envelope: 'single', data: balanceSheetReportSchema },
  { method: 'GET', route: `${REPORTS}/trial-balance`, envelope: 'single', data: trialBalanceReportSchema },
  { method: 'GET', route: `${REPORTS}/aged-receivables`, envelope: 'single', data: agedReportSchema },
  { method: 'GET', route: `${REPORTS}/aged-payables`, envelope: 'single', data: agedReportSchema },
  { method: 'GET', route: `${REPORTS}/vat-summary`, envelope: 'single', data: taxSummaryReportSchema },
  { method: 'GET', route: `${REPORTS}/general-ledger`, envelope: 'single', data: generalLedgerReportSchema },
  { method: 'GET', route: `${REPORTS}/cash-flow`, envelope: 'single', data: cashFlowReportSchema },
  { method: 'GET', route: `${REPORTS}/revenue-by-customer`, envelope: 'single', data: breakdownReportSchema },
  { method: 'GET', route: `${REPORTS}/expense-by-category`, envelope: 'single', data: breakdownReportSchema },
  { method: 'GET', route: `${REPORTS}/tax-worksheet`, envelope: 'single', data: taxWorksheetSchema },
  // dashboard
  { method: 'GET', route: '/api/accounting-dashboard', envelope: 'single', data: accountingDashboardSchema },
  // payroll
  { method: 'GET', route: `${PAYROLL}/categories`, envelope: 'single', data: payrollCategorySchema.array() },
  { method: 'GET', route: `${PAYROLL}/csv-mapping`, envelope: 'single', data: payrollCsvMappingSchema },
  { method: 'PUT', route: `${PAYROLL}/csv-mapping`, envelope: 'single', data: payrollCsvMappingSchema },
  { method: 'GET', route: `${PAYROLL}/imports`, envelope: 'list', data: payrollImportSchema },
  { method: 'POST', route: `${PAYROLL}/imports/csv`, envelope: 'single', data: payrollCsvImportResultSchema },
  { method: 'GET', route: `${PAYROLL}/imports/:id`, envelope: 'single', data: payrollImportDetailSchema },
  { method: 'DELETE', route: `${PAYROLL}/imports/:id`, envelope: 'single', data: payrollImportSchema },
  { method: 'GET', route: `${PAYROLL}/connections`, envelope: 'list', data: payrollConnectionSchema },
  { method: 'POST', route: `${PAYROLL}/connections`, envelope: 'single', data: payrollConnectionSchema },
  { method: 'PUT', route: `${PAYROLL}/connections/:id/mapping`, envelope: 'single', data: payrollConnectionSchema },
  { method: 'POST', route: `${PAYROLL}/connections/:id/sync`, envelope: 'single', data: payrollSyncResultSchema },
  // fixed assets
  { method: 'GET', route: ASSETS, envelope: 'list', data: fixedAssetListItemSchema },
  { method: 'POST', route: ASSETS, envelope: 'single', data: fixedAssetWriteResultSchema },
  { method: 'GET', route: `${ASSETS}/register`, envelope: 'single', data: fixedAssetRegisterSchema },
  { method: 'GET', route: `${ASSETS}/tax-depreciation`, envelope: 'single', data: taxDepreciationReportSchema },
  { method: 'GET', route: `${ASSETS}/mid-quarter-test`, envelope: 'single', data: midQuarterTestSchema },
  { method: 'POST', route: `${ASSETS}/de-minimis-check`, envelope: 'single', data: deMinimisCheckSchema },
  { method: 'POST', route: `${ASSETS}/depreciation/run`, envelope: 'single', data: depreciationRunSchema },
  { method: 'POST', route: `${ASSETS}/from-bill-line`, envelope: 'single', data: fixedAssetFromBillLineSchema },
  { method: 'GET', route: `${ASSETS}/:id`, envelope: 'single', data: fixedAssetDetailSchema },
  { method: 'GET', route: `${ASSETS}/:id/schedule`, envelope: 'single', data: fixedAssetScheduleSchema },
  { method: 'PATCH', route: `${ASSETS}/:id`, envelope: 'single', data: fixedAssetWriteResultSchema },
  { method: 'POST', route: `${ASSETS}/:id/dispose`, envelope: 'single', data: fixedAssetDisposalSchema },
];
