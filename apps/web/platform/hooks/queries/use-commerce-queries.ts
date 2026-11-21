/**
 * WeldCommerce query hooks (the rebuilt module, ADR COM-009). Served by the
 * Rust `commerce` module on the EU edition; Global hides the module.
 *
 * - Overview: GET /commerce/overview
 */

import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DataResponse } from '@weldsuite/core-api-client/types';

export interface CommerceOverviewProducts {
  total: number;
  active: number;
  draft: number;
}

export interface CommerceOverviewOrders {
  total: number;
  open: number;
  awaitingFulfilment: number;
  unpaid: number;
}

export interface CommerceRevenueRow {
  currency: string;
  orders: number;
  /** A decimal string, e.g. `"1234.50"`. */
  revenue: string;
}

export interface CommerceRecentOrder {
  id: string;
  orderNumber: string | null;
  source: string | null;
  status: string | null;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  currency: string | null;
  /** A decimal string. */
  total: string | null;
  customerName: string | null;
  /** ISO 8601, UTC. */
  createdAt: string;
}

/** Each section is `null` when the member lacks its read permission. */
export interface CommerceOverview {
  products: CommerceOverviewProducts | null;
  orders: CommerceOverviewOrders | null;
  revenueLast30Days: CommerceRevenueRow[] | null;
  recentOrders: CommerceRecentOrder[] | null;
}

export const commerceKeys = {
  all: ['weldcommerce'] as const,
  overview: () => [...commerceKeys.all, 'overview'] as const,
};

export function useCommerceOverview() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.overview(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceOverview>>('/commerce/overview');
    },
  });
}
