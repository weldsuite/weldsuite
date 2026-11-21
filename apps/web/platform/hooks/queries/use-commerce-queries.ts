/**
 * WeldCommerce query hooks (the rebuilt module, ADR COM-009). Served by the
 * Rust `commerce` module on the EU edition; Global hides the module.
 *
 * - Overview:   GET /commerce/overview
 * - Variants:   /products/:id/variants (+ /generate), a sub-resource of the
 *               products WeldStash lists through the same `/products`
 * - Categories: /categories (list, tree, CRUD), /categories/:id/products
 *               (members), /categories/preview-members (rules, unsaved)
 * - A product's manual categories: GET /products/:id/categories
 *
 * Product rows themselves come from the WeldStash hooks (`/products`): one
 * catalogue, one set of list and detail queries. Variant changes refresh
 * those too, since a product row carries its variant count.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DataResponse, ListResponse } from '@weldsuite/core-api-client/types';
import { buildQueryString } from '@weldsuite/core-api-client/types';
import type { WeldstashProduct } from '@weldsuite/core-api-client/schemas/weldstash';
import { weldstashKeys } from '@/hooks/queries/use-weldstash-queries';

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

// ---------------------------------------------------------------------------
// Products, variants
// ---------------------------------------------------------------------------

/** A `/products` row as WeldCommerce reads it: the WeldStash shape plus its variant count. */
export type CommerceProduct = WeldstashProduct & {
  hasVariants?: boolean | null;
  variantCount?: number | null;
};

export interface CommerceVariant {
  id: string;
  productId: string;
  /** "M / Red": the option values in the product's option order. */
  name?: string | null;
  sku: string | null;
  barcode: string | null;
  /** Option name → value, e.g. `{ Size: 'L', Colour: 'Red' }`. */
  optionValues: Record<string, string>;
  /** A decimal string; null uses the product's price. */
  price: string | null;
  currency: string | null;
  status: string;
  position: number;
  inventoryQuantity: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVariantInput {
  optionValues: Record<string, string>;
  sku?: string;
  barcode?: string;
  price?: string;
  status?: string;
}

/** `null` clears a field (the variant then uses the product's price, or has no SKU). */
export interface UpdateVariantInput {
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  status?: string;
  position?: number;
  optionValues?: Record<string, string>;
}

export interface VariantOption {
  name: string;
  values: string[];
}

export interface GenerateVariantsResult {
  created: number;
  kept: number;
  variants: CommerceVariant[];
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type CategoryType = 'manual' | 'automated';
export type CategoryRulesMatch = 'all' | 'any';

/** Product fields a rule may test: the server's whitelist, in the order the editor offers them. */
export const CATEGORY_RULE_COLUMNS = [
  'name',
  'productType',
  'vendor',
  'brand',
  'sku',
  'status',
  'tag',
  'price',
  'compareAtPrice',
  'weight',
  'inventoryQuantity',
] as const;
export type CategoryRuleColumn = (typeof CATEGORY_RULE_COLUMNS)[number];

export const CATEGORY_RULE_RELATIONS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'less_than',
] as const;
export type CategoryRuleRelation = (typeof CATEGORY_RULE_RELATIONS)[number];

export interface CategoryRule {
  column: CategoryRuleColumn;
  relation: CategoryRuleRelation;
  condition: string;
}

export interface CommerceCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  path: string | null;
  depth: number;
  type: CategoryType;
  rules: CategoryRule[] | null;
  rulesMatch: CategoryRulesMatch | null;
  isActive: boolean;
  /** How members are listed (`manual`, `alpha-asc`, …). */
  sortOrder: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceCategoryNode extends CommerceCategory {
  children: CommerceCategoryNode[];
}

/** A category a product is filed under (`GET /products/:id/categories`). */
export interface CommerceCategoryRef {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  depth: number;
  type: CategoryType;
  isActive: boolean;
}

/** Create and update body. On update every field is optional; `parentId: null` moves to the top level. */
export interface CategoryInput {
  name?: string;
  slug?: string;
  description?: string | null;
  parentId?: string | null;
  isActive?: boolean;
  type?: CategoryType;
  rules?: CategoryRule[] | null;
  rulesMatch?: CategoryRulesMatch | null;
}

export interface CategoryListParams {
  parentId?: string;
  type?: CategoryType;
  search?: string;
  limit?: number;
}

export interface CategoryMembersPreviewInput {
  rules: CategoryRule[];
  rulesMatch: CategoryRulesMatch;
}

export interface CategoryMembersPreview {
  totalCount: number;
  products: CommerceProduct[];
}

export const commerceKeys = {
  all: ['weldcommerce'] as const,
  overview: () => [...commerceKeys.all, 'overview'] as const,
  product: (productId: string) => [...commerceKeys.all, 'products', productId] as const,
  variants: (productId: string) => [...commerceKeys.product(productId), 'variants'] as const,
  productCategories: (productId: string) => [...commerceKeys.product(productId), 'categories'] as const,
  categories: () => [...commerceKeys.all, 'categories'] as const,
  categoryList: (params?: CategoryListParams) => [...commerceKeys.categories(), 'list', params ?? {}] as const,
  categoryTree: () => [...commerceKeys.categories(), 'tree'] as const,
  category: (id: string) => [...commerceKeys.categories(), 'detail', id] as const,
  categoryProducts: (id: string) => [...commerceKeys.category(id), 'products'] as const,
  categoryPreview: (input: CategoryMembersPreviewInput | null) =>
    [...commerceKeys.categories(), 'preview', input] as const,
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

// ---------------------- Variants ----------------------

export function useProductVariants(productId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.variants(productId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceVariant[]>>(`/products/${productId}/variants`);
    },
    enabled: !!productId && enabled,
  });
}

/** After a variant change: the variant list, and the product rows that count them. */
function useInvalidateVariants() {
  const qc = useQueryClient();
  return (productId: string) => {
    void qc.invalidateQueries({ queryKey: commerceKeys.variants(productId) });
    void qc.invalidateQueries({ queryKey: weldstashKeys.products() });
  };
}

export function useCreateProductVariant() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateVariants();
  return useMutation({
    mutationFn: async ({ productId, data }: { productId: string; data: CreateVariantInput }) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string }>>(`/products/${productId}/variants`, data);
    },
    onSuccess: (_, vars) => invalidate(vars.productId),
  });
}

export function useGenerateProductVariants() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateVariants();
  return useMutation({
    mutationFn: async ({ productId, options }: { productId: string; options: VariantOption[] }) => {
      const client = await getClient();
      return client.post<DataResponse<GenerateVariantsResult>>(`/products/${productId}/variants/generate`, {
        options,
      });
    },
    onSuccess: (_, vars) => invalidate(vars.productId),
  });
}

export function useUpdateProductVariant() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateVariants();
  return useMutation({
    mutationFn: async ({
      productId,
      variantId,
      data,
    }: {
      productId: string;
      variantId: string;
      data: UpdateVariantInput;
    }) => {
      const client = await getClient();
      return client.patch<DataResponse<CommerceVariant>>(`/products/${productId}/variants/${variantId}`, data);
    },
    onSuccess: (_, vars) => invalidate(vars.productId),
  });
}

export function useDeleteProductVariant() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateVariants();
  return useMutation({
    mutationFn: async ({ productId, variantId }: { productId: string; variantId: string }) => {
      const client = await getClient();
      return client.delete<void>(`/products/${productId}/variants/${variantId}`);
    },
    onSuccess: (_, vars) => invalidate(vars.productId),
  });
}

// ---------------------- A product's categories ----------------------

/** The manual categories a product is filed under. */
export function useProductCategories(productId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.productCategories(productId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceCategoryRef[]>>(`/products/${productId}/categories`);
    },
    enabled: !!productId && enabled,
  });
}

// ---------------------- Categories ----------------------

/** The whole forest, children nested (`GET /categories/tree`). */
export function useCommerceCategoryTree(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.categoryTree(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceCategoryNode[]>>('/categories/tree');
    },
    enabled,
  });
}

/** One page of the flat list, e.g. the direct children of a category (`parentId`). */
export function useCommerceCategories(params: CategoryListParams, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.categoryList(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString({ ...params } as Record<string, unknown>);
      return client.get<ListResponse<CommerceCategory>>(`/categories${qs}`);
    },
    enabled,
  });
}

/** The flat list, cursor-paged: what the categories page shows while searching. */
export function useInfiniteCommerceCategories(params: CategoryListParams, enabled = true) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...commerceKeys.categoryList(params), 'infinite'],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({ ...params, cursor: pageParam } as Record<string, unknown>);
      return client.get<ListResponse<CommerceCategory>>(`/categories${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
    enabled,
  });
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

export function useCreateCommerceCategory() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CategoryInput) => {
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
    mutationFn: async ({ id, data }: { id: string; data: CategoryInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<CommerceCategory>>(`/categories/${id}`, data);
    },
    // Members of an automated category follow its rules, and a rename shows on
    // every product filed under it: refresh the categories and every product's list.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: commerceKeys.categories() });
      void qc.invalidateQueries({ queryKey: [...commerceKeys.all, 'products'] });
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: commerceKeys.categories() });
      void qc.invalidateQueries({ queryKey: [...commerceKeys.all, 'products'] });
    },
  });
}

// ---------------------- Category members ----------------------

/**
 * A category's products, cursor-paged: its manual members, or what an
 * automated category's rules match right now.
 */
export function useCommerceCategoryProducts(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: commerceKeys.categoryProducts(id),
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({ cursor: pageParam } as Record<string, unknown>);
      return client.get<ListResponse<CommerceProduct>>(`/categories/${id}/products${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
    enabled: !!id && enabled,
  });
}

/** After a membership change: the category's members and the products' own category lists. */
function useInvalidateMembership() {
  const qc = useQueryClient();
  return (categoryId: string, productIds: string[]) => {
    void qc.invalidateQueries({ queryKey: commerceKeys.categoryProducts(categoryId) });
    for (const productId of productIds) {
      void qc.invalidateQueries({ queryKey: commerceKeys.productCategories(productId) });
    }
  };
}

export function useAttachCategoryProducts() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateMembership();
  return useMutation({
    mutationFn: async ({ categoryId, productIds }: { categoryId: string; productIds: string[] }) => {
      const client = await getClient();
      return client.post<DataResponse<{ added: number }>>(`/categories/${categoryId}/products`, { productIds });
    },
    onSuccess: (_, vars) => invalidate(vars.categoryId, vars.productIds),
  });
}

export function useDetachCategoryProduct() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateMembership();
  return useMutation({
    mutationFn: async ({ categoryId, productId }: { categoryId: string; productId: string }) => {
      const client = await getClient();
      return client.delete<void>(`/categories/${categoryId}/products/${productId}`);
    },
    onSuccess: (_, vars) => invalidate(vars.categoryId, [vars.productId]),
  });
}

/**
 * What a rule set would match, before it is saved. Pass null while the rules
 * are incomplete; nothing is asked then.
 */
export function useCategoryMembersPreview(input: CategoryMembersPreviewInput | null) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceKeys.categoryPreview(input),
    queryFn: async () => {
      const client = await getClient();
      return client.post<DataResponse<CategoryMembersPreview>>('/categories/preview-members', input);
    },
    enabled: input !== null,
  });
}
