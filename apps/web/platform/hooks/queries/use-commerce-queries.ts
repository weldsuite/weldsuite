/**
 * WeldCommerce Query Hooks
 *
 * All endpoints live on app-api:
 * - Products:   /products   (shared `products` table — WeldStash reads the same rows)
 * - Categories: /categories (hierarchical; manual + automated, see .claude/weldcommerce-plan.md)
 * - Orders:     /orders
 *
 * Customers are NOT here on purpose. Per `apps/workers/app-api/src/routes/companies/index.ts`,
 * "the customer surface is a status-flag projection on top of companies, not a separate
 * object" — so the customers tab reuses `useCompanies` & co. from
 * `@/components/objects/company/use-company-data`, and the existing `company`
 * object panel. Adding a parallel customer object here would fork that model.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type {
  CreateProductCategoryInput,
  UpdateProductCategoryInput,
  CategoryTreeNode,
} from '@weldsuite/app-api-client/schemas/product-categories';
import type { CreateOrderInput, UpdateOrderInput } from '@weldsuite/core-api-client/schemas/orders';
import type { CreateProductInput, WeldstashProduct } from '@weldsuite/core-api-client/schemas/weldstash';
import type { DataResponse, ListResponse } from '@weldsuite/core-api-client/types';
import { buildQueryString } from '@weldsuite/core-api-client/types';

// ============================================================================
// Row types — shaped to what the app-api routes actually return today.
// ============================================================================

/** One listing of a catalogue product on an external store. */
export interface ProductSalesChannel {
  id: string;
  productId: string;
  connectionId: string;
  provider: string;
  displayName: string | null;
  externalId: string;
  externalUrl: string | null;
  status: 'active' | 'disconnected' | 'deleted_remote';
  lastSyncedAt: string | null;
}

/** A product as rendered by the WeldCommerce catalogue grid. */
export type CommerceProduct = WeldstashProduct & {
  salesChannels?: ProductSalesChannel[];
};

export interface CommerceCategory {
  id: string;
  name: string;
  slug: string | null;
  description?: string | null;
  parentId?: string | null;
  path?: string | null;
  depth?: number | null;
  position?: number | null;
  type?: 'manual' | 'automated' | null;
  rulesMatch?: 'all' | 'any' | null;
  sortOrder?: string | null;
  isActive?: boolean | null;
  image?: string | null;
  color?: string | null;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceOrder {
  id: string;
  orderNumber: string | null;
  customerId?: string | null;
  websiteId?: string | null;
  source?: string | null;
  status: string | null;
  currency?: string | null;
  subtotal?: string | number | null;
  taxTotal?: string | number | null;
  total?: string | number | null;
  createdAt: string;
  updatedAt: string;
}

/** A line item on an order, from the `order_items` table. */
export interface CommerceOrderItem {
  id: string;
  orderId: string;
  productId?: string | null;
  variantId?: string | null;
  sku?: string | null;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  quantity: number;
  unitPrice: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  total: string | number;
  fulfilledQuantity?: number | null;
  createdAt: string;
}

export interface CommerceListQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  status?: string;
  [key: string]: unknown;
}

export interface OrderListQuery extends CommerceListQuery {
  customerId?: string;
}

// ============================================================================
// Query keys
// ============================================================================

export const commerceKeys = {
  all: ['weldcommerce'] as const,

  products: () => [...commerceKeys.all, 'products'] as const,
  productList: (params?: CommerceListQuery) => [...commerceKeys.products(), 'list', params ?? {}] as const,
  product: (id: string) => [...commerceKeys.products(), 'detail', id] as const,

  categories: () => [...commerceKeys.all, 'categories'] as const,
  categoryList: (params?: CommerceListQuery) => [...commerceKeys.categories(), 'list', params ?? {}] as const,
  categoryTree: () => [...commerceKeys.categories(), 'tree'] as const,
  category: (id: string) => [...commerceKeys.categories(), 'detail', id] as const,
  categoryProducts: (id: string) => [...commerceKeys.categories(), 'detail', id, 'products'] as const,
  productCategories: (id: string) => [...commerceKeys.products(), 'detail', id, 'categories'] as const,
  salesChannelTargets: () => [...commerceKeys.products(), 'sales-channel-targets'] as const,

  orders: () => [...commerceKeys.all, 'orders'] as const,
  orderList: (params?: OrderListQuery) => [...commerceKeys.orders(), 'list', params ?? {}] as const,
  order: (id: string) => [...commerceKeys.orders(), 'detail', id] as const,
  orderItems: (id: string) => [...commerceKeys.orders(), 'detail', id, 'items'] as const,
};

/** Matches the slug generation WeldStash uses for the same `products` table. */
function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ============================================================================
// Products
// ============================================================================

export function useCommerceProducts(params?: CommerceListQuery) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.productList(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString((params ?? { limit: 50 }) as Record<string, unknown>);
      return client.get<ListResponse<CommerceProduct>>(`/products${qs}`);
    },
  });
}

/**
 * Cursor-paged variant used by the EntityGrid screens — the grid asks for more
 * rows as you scroll rather than capping at one page, matching the CRM grids.
 */
export function useInfiniteCommerceProducts(params?: Omit<CommerceListQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...commerceKeys.products(), 'infinite', params ?? {}],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({
        ...(params ?? { limit: 50 }),
        cursor: pageParam as string | undefined,
      } as Record<string, unknown>);
      return client.get<ListResponse<CommerceProduct>>(`/products${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
  });
}

export function useCommerceProduct(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.product(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceProduct>>(`/products/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export function useCreateCommerceProduct() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateProductInput) => {
      const client = await getClient();
      // `/products` requires a slug the client has to supply — same as WeldStash.
      const slug = `${slugify(data.name)}-${Math.random().toString(36).slice(2, 8)}`;
      return client.post<DataResponse<CommerceProduct>>('/products', {
        ...data,
        slug,
        sku: data.sku?.toUpperCase(),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceKeys.products() }),
  });
}

export function useUpdateCommerceProduct() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<CreateProductInput> }) => {
      const client = await getClient();
      return client.patch<DataResponse<CommerceProduct>>(`/products/${id}`, data);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: commerceKeys.products() });
      qc.invalidateQueries({ queryKey: commerceKeys.product(vars.id) });
    },
  });
}

export function useDeleteCommerceProduct() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/products/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceKeys.products() }),
  });
}

export interface SalesChannelTarget {
  id: string;
  provider: string;
  label: string;
  displayName: string | null;
  status: string;
  externalAccountId: string | null;
}

export function useSalesChannelTargets(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.salesChannelTargets(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<SalesChannelTarget[]>>('/products/sales-channel-targets');
    },
    enabled,
  });
}

function invalidateProductSalesChannels(qc: ReturnType<typeof useQueryClient>, productId: string) {
  qc.invalidateQueries({ queryKey: commerceKeys.products() });
  qc.invalidateQueries({ queryKey: commerceKeys.product(productId) });
}

export function useAddProductSalesChannel() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId, connectionId }: { productId: string; connectionId: string }) => {
      const client = await getClient();
      return client.post<DataResponse<ProductSalesChannel>>(`/products/${productId}/sales-channels`, {
        connectionId,
      });
    },
    onSuccess: (_, vars) => invalidateProductSalesChannels(qc, vars.productId),
  });
}

export function useRemoveProductSalesChannel() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId, channelId }: { productId: string; channelId: string }) => {
      const client = await getClient();
      return client.delete<void>(`/products/${productId}/sales-channels/${channelId}`);
    },
    onSuccess: (_, vars) => invalidateProductSalesChannels(qc, vars.productId),
  });
}

// ============================================================================
// Categories
// ============================================================================

export function useCommerceCategories(params?: CommerceListQuery) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.categoryList(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString((params ?? { limit: 50 }) as Record<string, unknown>);
      return client.get<ListResponse<CommerceCategory>>(`/categories${qs}`);
    },
  });
}

export function useInfiniteCommerceCategories(params?: Omit<CommerceListQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...commerceKeys.categories(), 'infinite', params ?? {}],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({
        ...(params ?? { limit: 50 }),
        cursor: pageParam as string | undefined,
      } as Record<string, unknown>);
      return client.get<ListResponse<CommerceCategory>>(`/categories${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
  });
}

/**
 * The whole hierarchy in one call. Backs the tree-ordered categories list and
 * the parent picker.
 *
 * `includeInactive` defaults to true here: an admin list that silently hides
 * deactivated categories makes them unreachable — you can't reactivate what
 * you can't see.
 */
export function useCommerceCategoryTree(includeInactive = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...commerceKeys.categoryTree(), { includeInactive }],
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString({ includeInactive: includeInactive ? 'true' : 'false' });
      return client.get<DataResponse<CategoryTreeNode[]>>(`/categories/tree${qs}`);
    },
  });
}

/**
 * Depth-first flatten of the tree, so a plain list renders parents immediately
 * above their children and `depth` can drive the indent.
 */
export function flattenCategoryTree(nodes: CategoryTreeNode[]): CommerceCategory[] {
  const out: CommerceCategory[] = [];
  const walk = (list: CategoryTreeNode[]) => {
    for (const node of list) {
      const { children, ...rest } = node;
      out.push({
        ...rest,
        isActive: node.isActive,
        createdAt: '',
        updatedAt: '',
      } as CommerceCategory);
      if (children?.length) walk(children);
    }
  };
  walk(nodes);
  return out;
}

export function useCommerceCategory(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.category(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceCategory>>(`/categories/${id}`);
    },
    enabled: !!id && enabled,
  });
}

/** Resolved members — junction rows for manual, live rule query for automated. */
export function useCommerceCategoryProducts(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.categoryProducts(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<CommerceProduct>>(`/categories/${id}/products`);
    },
    enabled: !!id && enabled,
  });
}

/**
 * Direct children of a category. `parentId` is a supported filter on the list
 * route, so this is the plain list endpoint rather than a walk of the tree.
 */
export function useCommerceSubcategories(parentId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...commerceKeys.categories(), 'children', parentId],
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString({ parentId, limit: 100 });
      return client.get<ListResponse<CommerceCategory>>(`/categories${qs}`);
    },
    enabled: !!parentId && enabled,
  });
}

/**
 * Categories a product has been manually added to — the reverse of
 * `useCommerceCategoryProducts`. Automated categories don't appear here; their
 * members are computed from rules and never hit the junction table.
 */
export function useCommerceProductCategories(productId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.productCategories(productId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<CommerceCategory>>(`/products/${productId}/categories`);
    },
    enabled: !!productId && enabled,
  });
}

/**
 * Attach products to a MANUAL category. Both directions of the cache have to
 * be invalidated — the category's member list and each product's category
 * list — or the panel you didn't act from shows stale membership.
 */
export function useAttachCategoryProducts() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ categoryId, productIds }: { categoryId: string; productIds: string[] }) => {
      const client = await getClient();
      return client.post<DataResponse<{ added: number }>>(
        `/categories/${categoryId}/products`,
        { productIds },
      );
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: commerceKeys.categoryProducts(vars.categoryId) });
      for (const productId of vars.productIds) {
        qc.invalidateQueries({ queryKey: commerceKeys.productCategories(productId) });
      }
    },
  });
}

export function useDetachCategoryProduct() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ categoryId, productId }: { categoryId: string; productId: string }) => {
      const client = await getClient();
      return client.delete<void>(`/categories/${categoryId}/products/${productId}`);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: commerceKeys.categoryProducts(vars.categoryId) });
      qc.invalidateQueries({ queryKey: commerceKeys.productCategories(vars.productId) });
    },
  });
}

export function useCreateCommerceCategory() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateProductCategoryInput) => {
      const client = await getClient();
      return client.post<DataResponse<CommerceCategory>>('/categories', data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceKeys.categories() }),
  });
}

export function useUpdateCommerceCategory() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateProductCategoryInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<CommerceCategory>>(`/categories/${id}`, data);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: commerceKeys.categories() });
      qc.invalidateQueries({ queryKey: commerceKeys.category(vars.id) });
    },
  });
}

export function useDeleteCommerceCategory() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/categories/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceKeys.categories() }),
  });
}

// ============================================================================
// Orders
// ============================================================================

export function useCommerceOrders(params?: OrderListQuery) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.orderList(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString((params ?? { limit: 50 }) as Record<string, unknown>);
      return client.get<ListResponse<CommerceOrder>>(`/orders${qs}`);
    },
  });
}

export function useInfiniteCommerceOrders(params?: Omit<OrderListQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...commerceKeys.orders(), 'infinite', params ?? {}],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({
        ...(params ?? { limit: 50 }),
        cursor: pageParam as string | undefined,
      } as Record<string, unknown>);
      return client.get<ListResponse<CommerceOrder>>(`/orders${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
  });
}

export function useCommerceOrder(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.order(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceOrder>>(`/orders/${id}`);
    },
    enabled: !!id && enabled,
  });
}

/** Line items for one order — backs the Items tab of the order panel. */
export function useCommerceOrderItems(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.orderItems(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<CommerceOrderItem>>(`/orders/${id}/items`);
    },
    enabled: !!id && enabled,
  });
}

export function useCreateCommerceOrder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateOrderInput) => {
      const client = await getClient();
      return client.post<DataResponse<CommerceOrder>>('/orders', data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceKeys.orders() }),
  });
}

export function useUpdateCommerceOrder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateOrderInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<CommerceOrder>>(`/orders/${id}`, data);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: commerceKeys.orders() });
      qc.invalidateQueries({ queryKey: commerceKeys.order(vars.id) });
    },
  });
}

export function useDeleteCommerceOrder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/orders/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceKeys.orders() }),
  });
}

export interface CommercePortalSettings {
  id: string | null;
  isEnabled: boolean;
  displayName: string | null;
  logo: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  portalUrl: string | null;
  workspaceSlug: string | null;
}

export interface CommercePortalAccessRow {
  id: string;
  personId: string;
  companyId: string;
  email: string;
  status: 'invited' | 'active' | 'revoked' | string;
  invitedAt?: string | null;
  lastLoginAt?: string | null;
}

const portalKeys = {
  settings: ['commerce-portal', 'settings'] as const,
  access: (companyId: string) => ['commerce-portal', 'access', companyId] as const,
};

export function useCommercePortalSettings() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: portalKeys.settings,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<DataResponse<CommercePortalSettings>>('/commerce-portal/settings');
      return res.data;
    },
  });
}

export function useUpdateCommercePortalSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<Pick<CommercePortalSettings, 'isEnabled' | 'displayName' | 'logo' | 'primaryColor' | 'accentColor'>>) => {
      const client = await getClient();
      const res = await client.patch<DataResponse<CommercePortalSettings>>('/commerce-portal/settings', data);
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.settings }),
  });
}

export function useCommercePortalAccess(companyId: string | undefined) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: portalKeys.access(companyId ?? ''),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<CommercePortalAccessRow>>(`/commerce-portal/access?companyId=${encodeURIComponent(companyId!)}`);
    },
    enabled: !!companyId,
  });
}

export function useInviteCommercePortalAccess() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { personId: string; companyId: string }) => {
      const client = await getClient();
      return client.post<DataResponse<CommercePortalAccessRow>>('/commerce-portal/access/invite', data);
    },
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: portalKeys.access(vars.companyId) }),
  });
}

export function useRevokeCommercePortalAccess(companyId: string) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<DataResponse<CommercePortalAccessRow>>(`/commerce-portal/access/${id}/revoke`, {});
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.access(companyId) }),
  });
}

export function useResendCommercePortalAccess(companyId: string) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<DataResponse<{ ok: boolean }>>(`/commerce-portal/access/${id}/resend`, {});
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.access(companyId) }),
  });
}
