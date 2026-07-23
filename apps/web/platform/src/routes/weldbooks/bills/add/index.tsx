import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import PageComponent from '@/app/weldbooks/bills/add/page';

const addBillSearchSchema = z.object({
  fromDocument: z.string().optional(),
});

export const Route = createFileRoute('/weldbooks/bills/add/')({
  component: PageComponent,
  validateSearch: addBillSearchSchema,
});
