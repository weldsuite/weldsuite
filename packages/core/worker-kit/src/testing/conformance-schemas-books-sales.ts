/**
 * WeldBooks sales (books-api's invoices, payments, recurring invoices and
 * invoice templates) response schemas, by route. Spread into BOOKS_ROUTES by
 * conformance-schemas-books.ts. The PDF route answers HTML and the attachment
 * route a file: neither has a JSON schema.
 */
import {
  creditAppliedSchema,
  generatedRecurringInvoiceSchema,
  invoiceCreatedSchema,
  invoiceDeletedSchema,
  invoiceDetailSchema,
  invoiceFinalizedSchema,
  invoiceFromOrderSchema,
  invoiceListItemSchema,
  invoicePaymentRecordedSchema,
  invoiceSchema,
  invoiceSentSchema,
  invoiceTemplateSchema,
  invoiceWithItemsSchema,
  paymentCreatedSchema,
  paymentDetailSchema,
  paymentSchema,
  providerSyncSchema,
  recurringInvoiceSchema,
  recurringStatusSchema,
} from '@weldsuite/app-api-client/schemas/books-sales-responses';
import type { RouteSchema } from './conformance-schemas';

export const BOOKS_SALES_ROUTES: RouteSchema[] = [
  // invoices
  { method: 'GET', route: '/api/invoices', envelope: 'list', data: invoiceListItemSchema },
  { method: 'GET', route: '/api/invoices/:id', envelope: 'single', data: invoiceDetailSchema },
  { method: 'POST', route: '/api/invoices', envelope: 'single', data: invoiceWithItemsSchema },
  { method: 'PUT', route: '/api/invoices/:id', envelope: 'single', data: invoiceWithItemsSchema },
  { method: 'PATCH', route: '/api/invoices/:id', envelope: 'single', data: invoiceWithItemsSchema },
  { method: 'DELETE', route: '/api/invoices/:id', envelope: 'single', data: invoiceDeletedSchema },
  { method: 'PATCH', route: '/api/invoices/:id/send', envelope: 'single', data: invoiceSentSchema },
  { method: 'PATCH', route: '/api/invoices/:id/status', envelope: 'single', data: invoiceSchema },
  { method: 'POST', route: '/api/invoices/:id/finalize', envelope: 'single', data: invoiceFinalizedSchema },
  { method: 'POST', route: '/api/invoices/:id/commit-tax', envelope: 'single', data: providerSyncSchema },
  { method: 'POST', route: '/api/invoices/:id/duplicate', envelope: 'single', data: invoiceCreatedSchema },
  { method: 'POST', route: '/api/invoices/:id/credit-note', envelope: 'single', data: invoiceCreatedSchema },
  { method: 'POST', route: '/api/invoices/:id/record-payment', envelope: 'single', data: invoicePaymentRecordedSchema },
  { method: 'POST', route: '/api/invoices/:id/apply-credit', envelope: 'single', data: creditAppliedSchema },
  { method: 'POST', route: '/api/invoices/from-order/:orderId', envelope: 'single', data: invoiceFromOrderSchema },
  // payments
  { method: 'GET', route: '/api/payments', envelope: 'list', data: paymentSchema },
  { method: 'GET', route: '/api/payments/:id', envelope: 'single', data: paymentDetailSchema },
  { method: 'POST', route: '/api/payments', envelope: 'single', data: paymentCreatedSchema },
  // recurring-invoices
  { method: 'GET', route: '/api/recurring-invoices', envelope: 'array', data: recurringInvoiceSchema },
  { method: 'GET', route: '/api/recurring-invoices/:id', envelope: 'single', data: recurringInvoiceSchema },
  { method: 'POST', route: '/api/recurring-invoices', envelope: 'single', data: recurringInvoiceSchema },
  { method: 'PUT', route: '/api/recurring-invoices/:id', envelope: 'single', data: recurringInvoiceSchema },
  { method: 'PATCH', route: '/api/recurring-invoices/:id', envelope: 'single', data: recurringInvoiceSchema },
  { method: 'PATCH', route: '/api/recurring-invoices/:id/pause', envelope: 'single', data: recurringStatusSchema },
  { method: 'PATCH', route: '/api/recurring-invoices/:id/resume', envelope: 'single', data: recurringStatusSchema },
  { method: 'POST', route: '/api/recurring-invoices/:id/generate', envelope: 'single', data: generatedRecurringInvoiceSchema },
  // invoice-templates
  { method: 'GET', route: '/api/invoice-templates', envelope: 'list', data: invoiceTemplateSchema },
  { method: 'GET', route: '/api/invoice-templates/:id', envelope: 'single', data: invoiceTemplateSchema },
  { method: 'POST', route: '/api/invoice-templates', envelope: 'single', data: invoiceTemplateSchema },
  { method: 'PATCH', route: '/api/invoice-templates/:id', envelope: 'single', data: invoiceTemplateSchema },
  { method: 'POST', route: '/api/invoice-templates/:id/duplicate', envelope: 'single', data: invoiceTemplateSchema },
];
