/**
 * WeldBooks VAT, GST and Brazil (books-api's VAT returns, ICP declarations,
 * GST worksheet, br-tax, fiscal documents and received NF-e) response
 * schemas, by route. Spread into BOOKS_ROUTES by conformance-schemas-books.ts.
 * The XBRL downloads answer XML and the SPED ECD a Latin-1 text file:
 * neither has a JSON schema.
 */
import {
  brApuracaoBookedSchema,
  brApuracaoSchema,
  brWithholdingSuggestionSchema,
  fiscalCorrectionSchema,
  fiscalDocumentSchema,
  fiscalSettingsSchema,
  gstWorksheetSchema,
  icpCalculatedSchema,
  icpDeclarationDetailSchema,
  icpDeclarationSchema,
  icpFiledSchema,
  receivedBillCreatedSchema,
  receivedFiscalDocumentSchema,
  receivedFiscalDocumentSummarySchema,
  receivedSyncSchema,
  vatFilingStatusSchema,
  vatReturnCalculatedSchema,
  vatReturnFiledSchema,
  vatReturnSchema,
  vatSuppletieSchema,
} from '@weldsuite/app-api-client/schemas/books-tax-responses';
import type { RouteSchema } from './conformance-schemas';

export const BOOKS_TAX_ROUTES: RouteSchema[] = [
  // vat-returns
  { method: 'GET', route: '/api/vat-returns', envelope: 'array', data: vatReturnSchema },
  { method: 'GET', route: '/api/vat-returns/gst-worksheet', envelope: 'single', data: gstWorksheetSchema },
  { method: 'GET', route: '/api/vat-returns/:id', envelope: 'single', data: vatReturnSchema },
  { method: 'POST', route: '/api/vat-returns/calculate', envelope: 'single', data: vatReturnCalculatedSchema },
  { method: 'PATCH', route: '/api/vat-returns/:id', envelope: 'single', data: vatReturnSchema },
  { method: 'POST', route: '/api/vat-returns/:id/file', envelope: 'single', data: vatReturnFiledSchema },
  { method: 'POST', route: '/api/vat-returns/:id/suppletie', envelope: 'single', data: vatSuppletieSchema },
  { method: 'GET', route: '/api/vat-returns/:id/filing-status', envelope: 'single', data: vatFilingStatusSchema },
  // icp-declarations
  { method: 'GET', route: '/api/icp-declarations', envelope: 'array', data: icpDeclarationSchema },
  { method: 'GET', route: '/api/icp-declarations/:id', envelope: 'single', data: icpDeclarationDetailSchema },
  { method: 'POST', route: '/api/icp-declarations/calculate', envelope: 'single', data: icpCalculatedSchema },
  { method: 'POST', route: '/api/icp-declarations/:id/file', envelope: 'single', data: icpFiledSchema },
  // br-tax
  { method: 'GET', route: '/api/br-tax/apuracao', envelope: 'single', data: brApuracaoSchema },
  { method: 'POST', route: '/api/br-tax/apuracao/book', envelope: 'single', data: brApuracaoBookedSchema },
  { method: 'GET', route: '/api/br-tax/withholdings/suggest', envelope: 'single', data: brWithholdingSuggestionSchema },
  // fiscal-documents
  { method: 'GET', route: '/api/fiscal-documents/settings', envelope: 'single', data: fiscalSettingsSchema },
  { method: 'PUT', route: '/api/fiscal-documents/settings', envelope: 'single', data: fiscalSettingsSchema },
  { method: 'GET', route: '/api/fiscal-documents', envelope: 'list', data: fiscalDocumentSchema },
  { method: 'GET', route: '/api/fiscal-documents/:id', envelope: 'single', data: fiscalDocumentSchema },
  { method: 'POST', route: '/api/fiscal-documents/issue', envelope: 'single', data: fiscalDocumentSchema },
  { method: 'POST', route: '/api/fiscal-documents/:id/refresh', envelope: 'single', data: fiscalDocumentSchema },
  { method: 'POST', route: '/api/fiscal-documents/:id/cancel', envelope: 'single', data: fiscalDocumentSchema },
  { method: 'POST', route: '/api/fiscal-documents/:id/correction', envelope: 'single', data: fiscalCorrectionSchema },
  // received-fiscal-documents
  { method: 'GET', route: '/api/received-fiscal-documents', envelope: 'list', data: receivedFiscalDocumentSummarySchema },
  { method: 'GET', route: '/api/received-fiscal-documents/:id', envelope: 'single', data: receivedFiscalDocumentSchema },
  { method: 'POST', route: '/api/received-fiscal-documents/sync', envelope: 'single', data: receivedSyncSchema },
  { method: 'POST', route: '/api/received-fiscal-documents/upload', envelope: 'single', data: receivedFiscalDocumentSummarySchema },
  { method: 'POST', route: '/api/received-fiscal-documents/:id/manifest', envelope: 'single', data: receivedFiscalDocumentSummarySchema },
  { method: 'POST', route: '/api/received-fiscal-documents/:id/create-bill', envelope: 'single', data: receivedBillCreatedSchema },
  { method: 'POST', route: '/api/received-fiscal-documents/:id/ignore', envelope: 'single', data: receivedFiscalDocumentSummarySchema },
];
