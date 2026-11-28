import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import PageComponent from '@/app/weldbooks/time/unbilled/page';

const unbilledSearchSchema = z.object({
  /** The customer (WeldBooks contact) selected on the left. */
  customerId: z.string().optional(),
  /** Only the hours of this WeldFlow project. */
  projectId: z.string().optional(),
});

export const Route = createFileRoute('/weldbooks/time/unbilled/')({
  component: PageComponent,
  validateSearch: unbilledSearchSchema,
});
