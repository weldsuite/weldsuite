import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import PageComponent from '@/app/weldbooks/invoices/add/page';

const addInvoiceSearchSchema = z.object({
  /** The customer the new invoice starts with. */
  contactId: z.string().optional(),
});

export const Route = createFileRoute('/weldbooks/invoices/add/')({
  component: PageComponent,
  validateSearch: addInvoiceSearchSchema,
});
