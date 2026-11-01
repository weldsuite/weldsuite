/**
 * WeldBooks purchases (books-api) response schemas, by route: accounting
 * contacts, the document inbox, bills and W-9 requests. Spread into
 * BOOKS_ROUTES by conformance-schemas-books.ts (plan:
 * rust/modules/books/PORTING.md).
 */
import {
  accountingContactSchema,
  accountingDocumentSchema,
  billDetailSchema,
  billPrefillSchema,
  billSchema,
  contactBalanceSchema,
  contactImportSchema,
  createdW9RequestSchema,
  documentLinkedSchema,
  documentRejectedSchema,
  documentRematchSchema,
  documentStatusCountSchema,
  promotedRoleSchema,
  revealedAchAccountSchema,
  revealedTinSchema,
  taxIdRevealSchema,
  w9RequestSchema,
} from '@weldsuite/app-api-client/schemas/books-purchases-responses';
import type { RouteSchema } from './conformance-schemas';

export const BOOKS_PURCHASES_ROUTES: RouteSchema[] = [
  // accounting-contacts
  { method: 'GET', route: '/api/accounting-contacts', envelope: 'list', data: accountingContactSchema },
  { method: 'POST', route: '/api/accounting-contacts', envelope: 'single', data: accountingContactSchema },
  { method: 'GET', route: '/api/accounting-contacts/:id', envelope: 'single', data: accountingContactSchema },
  { method: 'PUT', route: '/api/accounting-contacts/:id', envelope: 'single', data: accountingContactSchema },
  { method: 'PATCH', route: '/api/accounting-contacts/:id', envelope: 'single', data: accountingContactSchema },
  { method: 'GET', route: '/api/accounting-contacts/:id/invoices', envelope: 'array', data: billSchema.or(accountingDocumentSchema) },
  { method: 'GET', route: '/api/accounting-contacts/:id/bills', envelope: 'array', data: billSchema },
  { method: 'GET', route: '/api/accounting-contacts/:id/balance', envelope: 'single', data: contactBalanceSchema },
  { method: 'POST', route: '/api/accounting-contacts/import-from-crm', envelope: 'single', data: contactImportSchema },
  { method: 'POST', route: '/api/accounting-contacts/:id/archive', envelope: 'single', data: accountingContactSchema },
  { method: 'POST', route: '/api/accounting-contacts/:id/unarchive', envelope: 'single', data: accountingContactSchema },
  { method: 'POST', route: '/api/accounting-contacts/:id/promote-role', envelope: 'single', data: promotedRoleSchema },
  { method: 'POST', route: '/api/accounting-contacts/:id/reveal-tin', envelope: 'single', data: revealedTinSchema },
  { method: 'POST', route: '/api/accounting-contacts/:id/reveal-ach-account', envelope: 'single', data: revealedAchAccountSchema },
  { method: 'GET', route: '/api/accounting-contacts/:id/tax-id-reveals', envelope: 'list', data: taxIdRevealSchema },
  { method: 'POST', route: '/api/accounting-contacts/:id/verify-bank-details', envelope: 'single', data: accountingContactSchema },
  // accounting-documents
  { method: 'GET', route: '/api/accounting-documents', envelope: 'array', data: accountingDocumentSchema },
  { method: 'GET', route: '/api/accounting-documents/stats', envelope: 'array', data: documentStatusCountSchema },
  { method: 'POST', route: '/api/accounting-documents', envelope: 'single', data: accountingDocumentSchema },
  { method: 'GET', route: '/api/accounting-documents/:id', envelope: 'single', data: accountingDocumentSchema },
  { method: 'POST', route: '/api/accounting-documents/:id/rematch', envelope: 'single', data: documentRematchSchema },
  { method: 'PATCH', route: '/api/accounting-documents/:id/link', envelope: 'single', data: documentLinkedSchema },
  { method: 'PATCH', route: '/api/accounting-documents/:id/reject', envelope: 'single', data: documentRejectedSchema },
  // bills
  { method: 'GET', route: '/api/bills', envelope: 'list', data: billSchema },
  { method: 'POST', route: '/api/bills', envelope: 'single', data: billSchema },
  { method: 'GET', route: '/api/bills/:id', envelope: 'single', data: billDetailSchema },
  { method: 'PUT', route: '/api/bills/:id', envelope: 'single', data: billSchema },
  { method: 'PATCH', route: '/api/bills/:id', envelope: 'single', data: billSchema },
  { method: 'PATCH', route: '/api/bills/:id/approve', envelope: 'single', data: billSchema },
  { method: 'PATCH', route: '/api/bills/:id/reject', envelope: 'single', data: billSchema },
  { method: 'POST', route: '/api/bills/from-document/:documentId', envelope: 'single', data: billPrefillSchema },
  // w9-requests
  { method: 'GET', route: '/api/w9-requests', envelope: 'list', data: w9RequestSchema },
  { method: 'GET', route: '/api/w9-requests/:id', envelope: 'single', data: w9RequestSchema },
  { method: 'POST', route: '/api/w9-requests', envelope: 'single', data: createdW9RequestSchema },
  { method: 'POST', route: '/api/w9-requests/:id/cancel', envelope: 'single', data: w9RequestSchema },
];
