import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import PageComponent from '@/app/weldbooks/quotes/add/page';

const addQuoteSearchSchema = z.object({
  /** The customer the new quote starts with. */
  contactId: z.string().optional(),
});

export const Route = createFileRoute('/weldbooks/quotes/add/')({
  component: PageComponent,
  validateSearch: addQuoteSearchSchema,
});
