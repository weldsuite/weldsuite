/**
 * A workspace's seat price on Mollie, as a server function (the Kubernetes
 * editions only). The body is in `./seat-price.server.ts`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { kubernetesOnly } from '@/lib/edition';
import { setSeatPrice as setSeatPriceOnServer } from './seat-price.server';

const setSeatPriceFn = createServerFn({ method: 'POST' })
  .middleware([kubernetesOnly])
  .validator(
    z.object({
      workspaceId: z.string().min(1).max(255),
      unitAmount: z.number().int(),
      reason: z.string().max(4000),
    }),
  )
  .handler(({ data }) => setSeatPriceOnServer(data));
export const setSeatPrice = (input: Parameters<typeof setSeatPriceOnServer>[0]) => setSeatPriceFn({ data: input });
