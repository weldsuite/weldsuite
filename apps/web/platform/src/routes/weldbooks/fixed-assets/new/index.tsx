import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import PageComponent from '@/app/weldbooks/fixed-assets/new/page';

/** `?billItemId=` (and optionally `&billId=`) creates the asset from that bill line. */
const newAssetSearchSchema = z.object({
  billItemId: z.string().optional(),
  billId: z.string().optional(),
});

export const Route = createFileRoute('/weldbooks/fixed-assets/new/')({
  component: PageComponent,
  validateSearch: newAssetSearchSchema,
});
