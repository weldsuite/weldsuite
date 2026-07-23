/**
 * W1b package P4 — `commerce-wms-connect`
 *
 * Commerce + WMS + Parcel + WeldConnect (tasks/workflows) surface of the
 * legacy weldsuite-app ApiService, re-implemented against the unified
 * app-api (`/api/...`). All of these legacy routes (`/v1/commerce/*`,
 * `/v1/products/*`, `/v1/wms/*`, `/v1/parcel/*`, `/v1/tasks/*`) were NEVER
 * mounted on mobile-api-worker — they 404 in prod today — so this module
 * gives them live semantics for the first time while preserving the exact
 * legacy method names, parameter shapes, and screen-facing
 * `ApiResponse<{ success, data }>` envelope.
 *
 * Endpoint map (legacy /v1 → app-api /api):
 * - /commerce/products*, /wms/products*  → /api/products
 * - /commerce/categories*                → /api/categories
 * - /commerce/orders*, /wms/orders*, /parcel/orders → /api/orders
 * - /commerce/customers*                 → /api/people
 * - /commerce/inventory*, /wms/inventory* → /api/inventory (+/adjust)
 * - /wms/inventory/movements, /wms/stock-movements → /api/inventory-movements
 * - /wms/warehouses*                     → /api/warehouses
 * - /wms/locations*                      → /api/warehouse-locations
 * - /wms/picklists*                      → /api/pick-lists
 * - /wms/shipments*                      → /api/shipments (+ /api/carriers)
 * - /wms/purchase-orders*                → /api/purchase-orders
 * - /wms/returns*, /parcel/returns       → /api/returns
 * - /wms/cycle-counts*                   → /api/cycle-counts
 * - /wms/dashboard                       → /api/wms-activity
 * - /parcel/parcels*                     → /api/parcels
 * - /parcel/dashboard/stats              → /api/parcel-analytics
 * - /parcel/pickups                      → /api/pickups
 * - /tasks*                              → /api/tasks (+ /task-comments, /task-projects, /task-tags)
 * - /tasks/workflows*                    → /api/workflows
 * - /tasks/executions*                   → /api/workflow-executions
 * - /tasks/schedules*                    → /api/workflow-schedules
 * - /tasks/templates*                    → /api/workflow-templates
 * - /tasks/analytics/*                   → /api/workflow-dashboard/stats, /workflow-executions/trends, /workflows/:id/metrics
 *
 * Winning-duplicate semantics (legacy class had duplicate implementations;
 * runtime used the LATER definition): `getOrders`/`getOrder` keep the
 * commerce OrderFilters signature, `updateOrderStatus`/`getOrderStats`
 * keep the WMS semantics. Each is defined exactly once here.
 *
 * Methods with no app-api equivalent return
 * `{ success: false, error: { title: 'not_supported', ... } }` — behavior
 * identical to today's prod 404s. Each carries a TODO(phase-out) note.
 */

import { isApiError } from '@weldsuite/api-client/client';
import type { ApiResponse } from '@weldsuite/mobile-ui/types';

import { appApiClient } from '../app-api';

// ============================================================
// Filter types (were non-exported in the legacy services/api.ts —
// re-declared here and exported so the facade can re-export them)
// ============================================================

export interface CustomerFilters {
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'email' | 'ordercount' | 'totalspent' | 'createdat';
  sortOrder?: 'asc' | 'desc';
  accountStatus?: 'active' | 'inactive' | 'suspended' | 'deleted';
  customerGroup?: string;
  vipStatus?: 'none' | 'bronze' | 'silver' | 'gold' | 'platinum';
}

export interface OrderFilters {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface InventoryFilters {
  search?: string;
  status?: 'in_stock' | 'low_stock' | 'out_of_stock';
  page?: number;
  limit?: number;
}

// ============================================================
// Shared adapters (envelope + cursor-map pagination)
// ============================================================

interface AppApiListEnvelope<T = any> {
  data: T[];
  pagination?: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface LegacyListBody<T = any> {
  data: T[];
  items: T[];
  pagination: { page: number; pageSize: number; totalCount: number; totalPages: number; hasMore: boolean };
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Legacy order row: `items` is declared as an array (not plain `any`) so the
 * screens' `apiOrder.items.map((item) => …)` callbacks stay contextually
 * typed — `.map` on a plain `any` receiver trips TS7006 under noImplicitAny.
 */
type LegacyOrderRow = { items: any[] } & Record<string, any>;

/**
 * app-api /orders rows carry NO `items` array (order items live in the
 * separate order_items table and neither the list nor the detail route joins
 * them), but the legacy screens dereference `.items` unguarded
 * (`apiOrder.items.map`, `item.items.reduce`). Default to [] so real order
 * rows render instead of crashing.
 */
function withOrderItems(row: Record<string, any> | null | undefined): LegacyOrderRow {
  const base = row ?? {};
  return { ...base, items: Array.isArray(base.items) ? base.items : [] } as LegacyOrderRow;
}

function toError(err: unknown): ApiResponse<never> {
  if (isApiError(err)) {
    const apiErr = err as unknown as { status: number; message: string };
    return { success: false, error: { title: `api_error_${apiErr.status}`, message: apiErr.message } };
  }
  return {
    success: false,
    error: { title: 'network_error', message: err instanceof Error ? err.message : 'Request failed' },
  };
}

function notSupported(method: string): ApiResponse<never> {
  return {
    success: false,
    error: { title: 'not_supported', message: `${method} has no app-api equivalent yet` },
  };
}

function qs(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

/**
 * app-api is cursor-paginated; legacy screens do page-increment infinite
 * scroll. A per-(endpoint+filters) cursor map lets page N>1 send the cursor
 * stored from the previous page; page 1 (or no page) resets the stream.
 */
const cursorMap = new Map<string, string | null>();

async function fetchList(
  basePath: string,
  query: Record<string, unknown>,
  page?: number,
  limit?: number,
): Promise<LegacyListBody> {
  const effectiveLimit = limit ?? 25;
  const filters: Record<string, unknown> = { ...query, limit: effectiveLimit };
  const key = `${basePath}|${JSON.stringify(filters)}`;
  const currentPage = page && page > 1 ? page : 1;
  if (currentPage > 1) {
    const cursor = cursorMap.get(key);
    if (cursor) filters.cursor = cursor;
  }
  const res = await appApiClient.get<AppApiListEnvelope>(`${basePath}${qs(filters)}`);
  const items = res.data ?? [];
  const totalCount = res.pagination?.totalCount ?? items.length;
  const hasMore = res.pagination?.hasMore ?? false;
  cursorMap.set(key, res.pagination?.cursor ?? null);
  const totalPages = effectiveLimit > 0 ? Math.max(1, Math.ceil(totalCount / effectiveLimit)) : 1;
  return {
    data: items,
    items,
    pagination: { page: currentPage, pageSize: effectiveLimit, totalCount, totalPages, hasMore },
    meta: { page: currentPage, limit: effectiveLimit, total: totalCount, totalPages },
  };
}

/** GET a list and adapt to the legacy list body (both `pagination` and `meta`). */
async function listResponse(
  basePath: string,
  query: Record<string, unknown>,
  page?: number,
  limit?: number,
): Promise<ApiResponse<any>> {
  try {
    const body = await fetchList(basePath, query, page, limit);
    return { success: true, data: body };
  } catch (err) {
    return toError(err);
  }
}

/** GET a list and return the bare items array (legacy array-shaped endpoints). */
async function arrayResponse(
  basePath: string,
  query: Record<string, unknown>,
  limit?: number,
): Promise<ApiResponse<any>> {
  try {
    const body = await fetchList(basePath, query, 1, limit);
    return { success: true, data: body.items };
  } catch (err) {
    return toError(err);
  }
}

async function getOne(path: string): Promise<ApiResponse<any>> {
  try {
    const res = await appApiClient.get<{ data: any }>(path);
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

async function postOne(path: string, body?: unknown): Promise<ApiResponse<any>> {
  try {
    const res = await appApiClient.post<{ data: any }>(path, body);
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

async function patchOne(path: string, body: unknown): Promise<ApiResponse<any>> {
  try {
    const res = await appApiClient.patch<{ data: any }>(path, body);
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

async function deleteOne(path: string): Promise<ApiResponse<any>> {
  try {
    await appApiClient.delete<Record<string, never>>(path); // 204 → {}
    return { success: true };
  } catch (err) {
    return toError(err);
  }
}

/** Total row count for a resource (used to derive legacy *Stats endpoints). */
async function totalCountOf(basePath: string, query: Record<string, unknown> = {}): Promise<number> {
  const res = await appApiClient.get<AppApiListEnvelope>(`${basePath}${qs({ ...query, limit: 1 })}`);
  return res.pagination?.totalCount ?? (res.data ?? []).length;
}

// ============================================================
// Module surface
// ============================================================

export const commerceWmsConnect = {
  // ==================== COMMERCE — Products ====================

  async getProducts(params?: {
    search?: string;
    categoryId?: string;
    minPrice?: number;
    maxPrice?: number;
    inStockOnly?: boolean;
    featured?: boolean;
    status?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: string;
  }): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): app-api /products supports search/status/cursor/limit
      // only — categoryId/minPrice/maxPrice/inStockOnly/featured are filtered
      // client-side below (sortBy/sortOrder are dropped).
      const body = await fetchList(
        '/products',
        { search: params?.search, status: params?.status },
        params?.page,
        params?.limit,
      );
      let items = body.items;
      if (params?.categoryId) items = items.filter((p) => p.categoryId === params.categoryId);
      if (params?.minPrice !== undefined) items = items.filter((p) => Number(p.price) >= params.minPrice!);
      if (params?.maxPrice !== undefined) items = items.filter((p) => Number(p.price) <= params.maxPrice!);
      if (params?.inStockOnly) items = items.filter((p) => (p.stockQuantity ?? p.quantityOnHand ?? 0) > 0);
      if (params?.featured !== undefined) items = items.filter((p) => Boolean(p.isFeatured ?? p.featured) === params.featured);
      return {
        success: true,
        data: { items, products: items, data: items, meta: body.meta, pagination: body.pagination },
      };
    } catch (err) {
      return toError(err);
    }
  },

  async getProduct(id: string): Promise<ApiResponse<{ images?: any[] } & Record<string, any>>> {
    return getOne(`/products/${id}`);
  },

  async getProductBySlug(slug: string): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no slug lookup route on app-api — search fallback.
      const body = await fetchList('/products', { search: slug }, 1, 50);
      const match = body.items.find((p) => p.slug === slug) ?? body.items[0];
      if (!match) {
        return { success: false, error: { title: 'not_found', message: `Product with slug ${slug} not found` } };
      }
      return { success: true, data: match };
    } catch (err) {
      return toError(err);
    }
  },

  async getFeaturedProducts(limit: number = 10): Promise<ApiResponse<{ products: any[] }>> {
    try {
      // TODO(phase-out): no featured route on app-api — filter client-side.
      const body = await fetchList('/products', {}, 1, Math.max(limit, 25));
      const products = body.items.filter((p) => Boolean(p.isFeatured ?? p.featured)).slice(0, limit);
      return { success: true, data: { products } };
    } catch (err) {
      return toError(err);
    }
  },

  async scanProduct(code: string): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no barcode-lookup route on app-api — search fallback,
      // preferring an exact barcode/sku match.
      const body = await fetchList('/products', { search: code }, 1, 25);
      const match =
        body.items.find((p) => p.barcode === code || p.sku === code) ?? body.items[0];
      if (!match) {
        return { success: false, error: { title: 'not_found', message: `No product matches ${code}` } };
      }
      return { success: true, data: { found: true, product: match, ...match } };
    } catch (err) {
      return toError(err);
    }
  },

  async checkProductAvailability(id: string): Promise<ApiResponse<any>> {
    try {
      const body = await fetchList('/inventory', { productId: id }, 1, 100);
      const totalOnHand = body.items.reduce(
        (sum, row) => sum + Number(row.quantityOnHand ?? row.inventory?.quantityOnHand ?? 0),
        0,
      );
      return { success: true, data: { available: totalOnHand > 0, quantity: totalOnHand, items: body.items } };
    } catch (err) {
      return toError(err);
    }
  },

  async getProductStats(): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no product-stats route — derive the total from the list.
      const totalProducts = await totalCountOf('/products');
      return { success: true, data: { totalProducts, total: totalProducts } };
    } catch (err) {
      return toError(err);
    }
  },

  async createProduct(productData: {
    name: string;
    sku: string;
    description?: string;
    price?: number;
    compareAtPrice?: number;
    categoryId?: string;
    status?: string;
    imageUrl?: string;
    trackQuantity?: boolean;
    allowBackorder?: boolean;
    weight?: number;
    weightUnit?: string;
    barcode?: string;
  }): Promise<ApiResponse<any>> {
    return postOne('/products', productData);
  },

  async updateProduct(id: string, productData: {
    name?: string;
    sku?: string;
    description?: string;
    price?: number;
    compareAtPrice?: number;
    categoryId?: string;
    status?: string;
    imageUrl?: string;
    trackQuantity?: boolean;
    allowBackorder?: boolean;
    weight?: number;
    weightUnit?: string;
    barcode?: string;
  }): Promise<ApiResponse<any>> {
    return patchOne(`/products/${id}`, productData);
  },

  async deleteProduct(id: string): Promise<ApiResponse<{ success: boolean; message: string }>> {
    const res = await deleteOne(`/products/${id}`);
    if (!res.success) return res as ApiResponse<never>;
    return { success: true, data: { success: true, message: 'Product deleted' } };
  },

  // ==================== COMMERCE — Categories ====================

  async getCategories(params?: {
    parentId?: string;
    includeSubcategories?: boolean;
    activeOnly?: boolean;
  }): Promise<ApiResponse<{ categories: any[]; count: number }>> {
    try {
      const body = await fetchList('/categories', {}, 1, 100);
      let items = body.items;
      if (params?.parentId) items = items.filter((cat) => cat.parentId === params.parentId);
      if (params?.activeOnly) items = items.filter((cat) => cat.isActive !== false && cat.status !== 'inactive');
      return { success: true, data: { categories: items, count: body.pagination.totalCount } };
    } catch (err) {
      return toError(err);
    }
  },

  async getCategory(id: string, _includeSubcategories: boolean = true): Promise<ApiResponse<any>> {
    return getOne(`/categories/${id}`);
  },

  async getCategoryBySlug(slug: string, _includeSubcategories: boolean = true): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no slug route — resolve client-side from the list.
      const body = await fetchList('/categories', {}, 1, 100);
      const match = body.items.find((cat) => cat.slug === slug);
      if (!match) {
        return { success: false, error: { title: 'not_found', message: `Category with slug ${slug} not found` } };
      }
      return { success: true, data: match };
    } catch (err) {
      return toError(err);
    }
  },

  async getCategoryProducts(
    id: string,
    params?: {
      includeSubcategories?: boolean;
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: string;
    },
  ): Promise<ApiResponse<{ products: any[]; pagination: any }>> {
    try {
      // TODO(phase-out): /products has no categoryId query — filter client-side.
      const body = await fetchList('/products', {}, params?.page, params?.limit);
      const products = body.items.filter((p) => p.categoryId === id);
      return { success: true, data: { products, pagination: body.pagination } };
    } catch (err) {
      return toError(err);
    }
  },

  async getCategoryTree(): Promise<ApiResponse<{ categories: any[]; count: number }>> {
    try {
      const body = await fetchList('/categories', {}, 1, 200);
      // Build the tree client-side by parentId.
      const byId = new Map<string, any>(body.items.map((cat) => [cat.id, { ...cat, children: [] as any[] }]));
      const roots: any[] = [];
      for (const cat of byId.values()) {
        if (cat.parentId && byId.has(cat.parentId)) {
          byId.get(cat.parentId).children.push(cat);
        } else {
          roots.push(cat);
        }
      }
      return { success: true, data: { categories: roots, count: body.pagination.totalCount } };
    } catch (err) {
      return toError(err);
    }
  },

  // ==================== COMMERCE — Cart (no app-api equivalent) ====================

  async getCart(): Promise<ApiResponse<any>> {
    // TODO(phase-out): app-api has no cart routes (dead in prod today too).
    return notSupported('getCart');
  },

  async addToCart(_productId: string, _quantity: number, _variantId?: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): app-api has no cart routes.
    return notSupported('addToCart');
  },

  async updateCartItem(_itemId: string, _quantity: number): Promise<ApiResponse<any>> {
    // TODO(phase-out): app-api has no cart routes.
    return notSupported('updateCartItem');
  },

  async removeFromCart(_itemId: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): app-api has no cart routes.
    return notSupported('removeFromCart');
  },

  async clearCart(): Promise<ApiResponse<any>> {
    // TODO(phase-out): app-api has no cart routes.
    return notSupported('clearCart');
  },

  // ==================== COMMERCE/WMS — Orders (winning-duplicate defs) ====================

  /**
   * Winning definition (legacy line 2114, OrderFilters variant — the later
   * duplicate won at runtime). Returns the legacy paginated body.
   */
  async getOrders(filters?: OrderFilters): Promise<ApiResponse<LegacyListBody<LegacyOrderRow>>> {
    // sortBy/sortOrder are dropped (app-api orders sort is fixed newest-first).
    const res = await listResponse(
      '/orders',
      { search: filters?.search, status: filters?.status },
      filters?.page,
      filters?.limit,
    );
    if (res.success && res.data) {
      const rows = (res.data.items ?? []).map(withOrderItems);
      res.data.items = rows;
      res.data.data = rows;
    }
    return res;
  },

  /** Winning definition (legacy line 2127). */
  async getOrder(id: string): Promise<ApiResponse<LegacyOrderRow>> {
    const res = await getOne(`/orders/${id}`);
    if (res.success && res.data) res.data = withOrderItems(res.data);
    return res;
  },

  /**
   * Winning definition (legacy line 2735 — the WMS variant with `notes`).
   */
  async updateOrderStatus(id: string, status: string, notes?: string): Promise<ApiResponse<any>> {
    return patchOne(`/orders/${id}`, notes !== undefined ? { status, notes } : { status });
  },

  /**
   * Winning definition (legacy line 2717 — WMS variant).
   * TODO(phase-out): no order-stats route — derive the total from the list.
   */
  async getOrderStats(): Promise<ApiResponse<any>> {
    try {
      const totalOrders = await totalCountOf('/orders');
      return { success: true, data: { totalOrders, total: totalOrders } };
    } catch (err) {
      return toError(err);
    }
  },

  async createOrder(orderData: {
    shippingAddress: any;
    paymentMethod: string;
    items?: { productId: string; variantId?: string; quantity: number }[];
  }): Promise<ApiResponse<any>> {
    return postOne('/orders', orderData);
  },

  async createCommerceOrder(orderData: {
    customerId: string;
    items: { productId: string; quantity: number; price: number }[];
    shippingAddress?: string;
    notes?: string;
    subtotal: number;
    tax: number;
    total: number;
  }): Promise<ApiResponse<any>> {
    return postOne('/orders', orderData);
  },

  async getRecentOrders(limit: number = 5): Promise<ApiResponse<any[]>> {
    return arrayResponse('/orders', {}, limit);
  },

  // ==================== COMMERCE — Customers ====================

  async getCustomers(filters?: CustomerFilters): Promise<ApiResponse<LegacyListBody>> {
    // TODO(phase-out): accountStatus/customerGroup/vipStatus/sortBy have no
    // app-api /people equivalents — dropped.
    return listResponse('/people', { search: filters?.search }, filters?.page, filters?.limit);
  },

  async getCustomer(id: string): Promise<ApiResponse<any>> {
    return getOne(`/people/${id}/detail`);
  },

  async createCustomer(customer: Record<string, any>): Promise<ApiResponse<any>> {
    return postOne('/people', customer);
  },

  async updateCustomer(id: string, customer: Record<string, any>): Promise<ApiResponse<any>> {
    return patchOne(`/people/${id}`, customer);
  },

  // ==================== COMMERCE — Inventory ====================

  async getInventory(filters?: InventoryFilters): Promise<ApiResponse<LegacyListBody>> {
    try {
      // TODO(phase-out): app-api /inventory has no search/status filters —
      // search matches productName/productSku client-side; status is derived.
      const body = await fetchList('/inventory', {}, filters?.page, filters?.limit);
      let items = body.items;
      if (filters?.search) {
        const term = filters.search.toLowerCase();
        items = items.filter(
          (row) =>
            String(row.productName ?? '').toLowerCase().includes(term) ||
            String(row.productSku ?? row.sku ?? '').toLowerCase().includes(term),
        );
      }
      return { success: true, data: { ...body, data: items, items } };
    } catch (err) {
      return toError(err);
    }
  },

  async adjustStock(inventoryItemId: string, quantity: number, reason: string): Promise<ApiResponse<any>> {
    return postOne('/inventory/adjust', { inventoryItemId, quantity, reason });
  },

  async getInventoryStats(): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no inventory-stats route — derive the total.
      const totalItems = await totalCountOf('/inventory');
      return { success: true, data: { totalItems, total: totalItems } };
    } catch (err) {
      return toError(err);
    }
  },

  // ==================== COMMERCE — Dashboard & Analytics (no equivalent) ====================

  async getDashboardStats(): Promise<ApiResponse<any>> {
    // TODO(phase-out): commerce dashboard has no app-api equivalent.
    return notSupported('getDashboardStats');
  },

  async getTopProducts(_limit: number = 5): Promise<ApiResponse<any>> {
    // TODO(phase-out): commerce analytics absent from app-api.
    return notSupported('getTopProducts');
  },

  async getPerformanceMetrics(): Promise<ApiResponse<any>> {
    // TODO(phase-out): commerce analytics absent from app-api.
    return notSupported('getPerformanceMetrics');
  },

  async getConversionMetrics(): Promise<ApiResponse<any>> {
    // TODO(phase-out): commerce analytics absent from app-api.
    return notSupported('getConversionMetrics');
  },

  async getTopCategories(): Promise<ApiResponse<any>> {
    // TODO(phase-out): commerce analytics absent from app-api.
    return notSupported('getTopCategories');
  },

  async getChannelMetrics(): Promise<ApiResponse<any>> {
    // TODO(phase-out): commerce analytics absent from app-api.
    return notSupported('getChannelMetrics');
  },

  // ==================== WMS — Warehouses ====================

  async getWarehouses(filters?: {
    status?: string;
    type?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/warehouses',
      { status: filters?.status, type: filters?.type, isActive: filters?.isActive },
      filters?.page,
      filters?.limit,
    );
  },

  async getWarehouse(id: string): Promise<ApiResponse<any>> {
    return getOne(`/warehouses/${id}`);
  },

  async getWarehouseStats(id: string): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no warehouse-stats route — derive from inventory.
      const inventoryItems = await totalCountOf('/inventory', { warehouseId: id });
      return { success: true, data: { inventoryItems, totalItems: inventoryItems } };
    } catch (err) {
      return toError(err);
    }
  },

  async getWarehouseInventory(id: string, page = 1, limit = 50, search?: string): Promise<ApiResponse<any>> {
    try {
      const body = await fetchList('/inventory', { warehouseId: id }, page, limit);
      let items = body.items;
      if (search) {
        const term = search.toLowerCase();
        items = items.filter(
          (row) =>
            String(row.productName ?? '').toLowerCase().includes(term) ||
            String(row.productSku ?? row.sku ?? '').toLowerCase().includes(term),
        );
      }
      return { success: true, data: { ...body, data: items, items } };
    } catch (err) {
      return toError(err);
    }
  },

  async getWarehouseLocations(id: string, zoneId?: string): Promise<ApiResponse<any>> {
    return listResponse('/warehouse-locations', { warehouseId: id, zoneId }, 1, 100);
  },

  // ==================== WMS — Inventory ====================

  async getInventoryItems(filters?: {
    warehouseId?: string;
    productId?: string;
    status?: string;
    lowStock?: boolean;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: string;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/inventory',
      {
        warehouseId: filters?.warehouseId,
        productId: filters?.productId,
        lowStockOnly: filters?.lowStock ? 'true' : undefined,
      },
      filters?.page,
      filters?.limit,
    );
  },

  async getInventoryItem(id: string): Promise<ApiResponse<any>> {
    return getOne(`/inventory/${id}`);
  },

  async getLowStockItems(warehouseId?: string): Promise<ApiResponse<any>> {
    return listResponse('/inventory', { lowStockOnly: 'true', warehouseId }, 1, 100);
  },

  async getInventoryMovements(filters?: {
    productId?: string;
    warehouseId?: string;
    movementType?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/inventory-movements',
      {
        productId: filters?.productId,
        warehouseId: filters?.warehouseId,
        movementType: filters?.movementType,
      },
      filters?.page,
      filters?.limit,
    );
  },

  async adjustInventory(request: any): Promise<ApiResponse<any>> {
    return postOne('/inventory/adjust', request);
  },

  async transferInventory(request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): no dedicated transfer route — recorded as a
    // transfer-type inventory movement.
    return postOne('/inventory-movements', { ...request, movementType: 'transfer' });
  },

  // ==================== WMS — Orders ====================

  async getWmsOrders(filters?: {
    warehouseId?: string;
    status?: string;
    fulfillmentStatus?: string;
    priority?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: string;
    search?: string;
  }): Promise<ApiResponse<any>> {
    // TODO(phase-out): warehouseId/fulfillmentStatus/priority/sort have no
    // app-api /orders equivalents — dropped.
    const res = await listResponse(
      '/orders',
      { status: filters?.status, search: filters?.search },
      filters?.page,
      filters?.limit,
    );
    if (res.success && res.data) {
      const rows = (res.data.items ?? []).map(withOrderItems);
      res.data.items = rows;
      res.data.data = rows;
    }
    return res;
  },

  async getWmsOrder(id: string): Promise<ApiResponse<any>> {
    const res = await getOne(`/orders/${id}`);
    if (res.success && res.data) res.data = withOrderItems(res.data);
    return res;
  },

  async createWmsOrder(request: any): Promise<ApiResponse<any>> {
    return postOne('/orders', request);
  },

  async updateWmsOrder(id: string, request: any): Promise<ApiResponse<any>> {
    return patchOne(`/orders/${id}`, request);
  },

  async allocateOrderInventory(_request: { orderId: string; warehouseId: string }): Promise<ApiResponse<any>> {
    // TODO(phase-out): no allocation route on app-api.
    return notSupported('allocateOrderInventory');
  },

  async addOrderNote(id: string, note: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): no dedicated order-notes route — stored on the order's
    // notes field via PATCH (overwrites rather than appends).
    return patchOne(`/orders/${id}`, { notes: note });
  },

  async deleteWmsOrder(id: string): Promise<ApiResponse<any>> {
    return deleteOne(`/orders/${id}`);
  },

  // ==================== WMS — Pick lists ====================

  async getPickLists(filters?: {
    warehouseId?: string;
    status?: string;
    pickerId?: string;
    priority?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/pick-lists',
      {
        warehouseId: filters?.warehouseId,
        status: filters?.status,
        pickerId: filters?.pickerId,
        priority: filters?.priority,
      },
      filters?.page,
      filters?.limit,
    );
  },

  async getPickList(id: string): Promise<ApiResponse<any>> {
    return getOne(`/pick-lists/${id}`);
  },

  async createPickList(request: any): Promise<ApiResponse<any>> {
    return postOne('/pick-lists', request);
  },

  async batchCreatePickLists(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): no batch pick-list creation on app-api.
    return notSupported('batchCreatePickLists');
  },

  async generateBatchPickList(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): no batch pick-list generation on app-api.
    return notSupported('generateBatchPickList');
  },

  async updatePickList(id: string, request: any): Promise<ApiResponse<any>> {
    return patchOne(`/pick-lists/${id}`, request);
  },

  async assignPickList(id: string, pickerId: string): Promise<ApiResponse<any>> {
    return patchOne(`/pick-lists/${id}`, { pickerId });
  },

  async startPickList(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/pick-lists/${id}`, { status: 'in_progress' });
  },

  async pausePickList(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/pick-lists/${id}`, { status: 'paused' });
  },

  async resumePickList(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/pick-lists/${id}`, { status: 'in_progress' });
  },

  async updatePickProgress(_id: string, _request: { itemId: string; pickedQuantity: number }): Promise<ApiResponse<any>> {
    // TODO(phase-out): item-level pick operations absent from app-api.
    return notSupported('updatePickProgress');
  },

  async pickItem(
    _pickListId: string,
    _pickListItemId: string,
    _request: { quantity: number; locationCode?: string },
  ): Promise<ApiResponse<any>> {
    // TODO(phase-out): item-level pick operations absent from app-api.
    return notSupported('pickItem');
  },

  async skipPickItem(_id: string, _itemId: string, _reason: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): item-level pick operations absent from app-api.
    return notSupported('skipPickItem');
  },

  async completePickList(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/pick-lists/${id}`, { status: 'completed' });
  },

  async cancelPickList(id: string, _reason: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): cancellation reason has no field on app-api pick-lists.
    return patchOne(`/pick-lists/${id}`, { status: 'cancelled' });
  },

  // ==================== WMS — Shipments ====================

  async getShipments(filters?: {
    warehouseId?: string;
    status?: string;
    orderId?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/shipments',
      { warehouseId: filters?.warehouseId, status: filters?.status, orderId: filters?.orderId },
      filters?.page,
      filters?.limit,
    );
  },

  async getShipment(id: string): Promise<ApiResponse<any>> {
    return getOne(`/shipments/${id}`);
  },

  async trackShipment(_trackingNumber: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): no tracking-number lookup on app-api shipments.
    return notSupported('trackShipment');
  },

  async getCarriers(): Promise<ApiResponse<any>> {
    return listResponse('/carriers', {}, 1, 100);
  },

  async getShipmentTracking(_trackingNumber: string, _carrier?: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): no tracking lookup on app-api shipments.
    return notSupported('getShipmentTracking');
  },

  async createShipment(request: any): Promise<ApiResponse<any>> {
    return postOne('/shipments', request);
  },

  async getShippingRates(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): rate shopping has no app-api equivalent.
    return notSupported('getShippingRates');
  },

  async getBatchShippingRates(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): rate shopping has no app-api equivalent.
    return notSupported('getBatchShippingRates');
  },

  async generateShippingLabel(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): label generation has no app-api equivalent.
    return notSupported('generateShippingLabel');
  },

  async generateBulkShippingLabels(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): label generation has no app-api equivalent.
    return notSupported('generateBulkShippingLabels');
  },

  async validateAddress(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): address validation has no app-api equivalent.
    return notSupported('validateAddress');
  },

  async cancelShipment(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/shipments/${id}`, { status: 'cancelled' });
  },

  async updateShipmentStatus(
    id: string,
    request: { status: string; timestamp?: string; location?: string; description?: string },
  ): Promise<ApiResponse<any>> {
    // TODO(phase-out): timestamp/location/description events aren't stored by
    // app-api shipments — only the status field is updated.
    return patchOne(`/shipments/${id}`, { status: request.status });
  },

  // ==================== WMS — Purchase orders ====================

  async getPurchaseOrders(filters?: {
    supplierId?: string;
    status?: string;
    warehouseId?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/purchase-orders',
      { supplierId: filters?.supplierId, status: filters?.status, warehouseId: filters?.warehouseId },
      filters?.page,
      filters?.limit,
    );
  },

  async getPurchaseOrder(id: string): Promise<ApiResponse<any>> {
    return getOne(`/purchase-orders/${id}`);
  },

  async createPurchaseOrder(request: any): Promise<ApiResponse<any>> {
    return postOne('/purchase-orders', request);
  },

  async updatePurchaseOrder(id: string, request: any): Promise<ApiResponse<any>> {
    return patchOne(`/purchase-orders/${id}`, request);
  },

  async deletePurchaseOrder(id: string): Promise<ApiResponse<any>> {
    return deleteOne(`/purchase-orders/${id}`);
  },

  async approvePurchaseOrder(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/purchase-orders/${id}`, { status: 'approved' });
  },

  async receivePurchaseOrder(
    _id: string,
    _request: { items: { purchaseOrderItemId: string; receivedQuantity: number; locationId?: string }[] },
  ): Promise<ApiResponse<any>> {
    // TODO(phase-out): item-level PO receiving absent from app-api.
    return notSupported('receivePurchaseOrder');
  },

  // ==================== WMS — Returns ====================

  async getReturns(filters?: {
    warehouseId?: string;
    status?: string;
    customerId?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/returns',
      { warehouseId: filters?.warehouseId, status: filters?.status, customerId: filters?.customerId },
      filters?.page,
      filters?.limit,
    );
  },

  async getReturn(id: string): Promise<ApiResponse<any>> {
    return getOne(`/returns/${id}`);
  },

  async createReturn(request: any): Promise<ApiResponse<any>> {
    return postOne('/returns', request);
  },

  async processReturn(
    id: string,
    request: { action: string; notes?: string; inspectionNotes?: string },
  ): Promise<ApiResponse<any>> {
    // TODO(phase-out): no process route on app-api returns — the action is
    // stored as the return's status via PATCH.
    return patchOne(`/returns/${id}`, {
      status: request.action,
      ...(request.notes !== undefined ? { notes: request.notes } : {}),
    });
  },

  // ==================== WMS — Cycle counts ====================

  async getCycleCounts(filters?: {
    warehouseId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/cycle-counts',
      { warehouseId: filters?.warehouseId, status: filters?.status },
      filters?.page,
      filters?.limit,
    );
  },

  async getCycleCount(id: string): Promise<ApiResponse<any>> {
    return getOne(`/cycle-counts/${id}`);
  },

  async createCycleCount(request: any): Promise<ApiResponse<any>> {
    return postOne('/cycle-counts', request);
  },

  async updateCycleCount(id: string, request: any): Promise<ApiResponse<any>> {
    return patchOne(`/cycle-counts/${id}`, request);
  },

  async startCycleCount(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/cycle-counts/${id}`, { status: 'in_progress' });
  },

  async completeCycleCount(id: string, request: { applyAdjustments: boolean; notes?: string }): Promise<ApiResponse<any>> {
    // TODO(phase-out): applyAdjustments has no app-api equivalent — only the
    // status flip is applied.
    return patchOne(`/cycle-counts/${id}`, {
      status: 'completed',
      ...(request.notes !== undefined ? { notes: request.notes } : {}),
    });
  },

  async countCycleCountItem(
    _cycleCountId: string,
    _itemId: string,
    _request: { countedQuantity: number; countedByUserId?: string; notes?: string; autoAdjust?: boolean },
  ): Promise<ApiResponse<any>> {
    // TODO(phase-out): item-level cycle counting absent from app-api.
    return notSupported('countCycleCountItem');
  },

  // ==================== WMS — Locations ====================

  async getLocations(filters?: {
    warehouseId?: string;
    zone?: string;
    status?: string;
    type?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/warehouse-locations',
      {
        warehouseId: filters?.warehouseId,
        zone: filters?.zone,
        status: filters?.status,
        type: filters?.type,
        isActive: filters?.isActive,
      },
      filters?.page,
      filters?.limit,
    );
  },

  async getLocationStats(warehouseId?: string): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no location-stats route — derive the total.
      const totalLocations = await totalCountOf('/warehouse-locations', warehouseId ? { warehouseId } : {});
      return { success: true, data: { totalLocations, total: totalLocations } };
    } catch (err) {
      return toError(err);
    }
  },

  async getLocation(id: string): Promise<ApiResponse<any>> {
    return getOne(`/warehouse-locations/${id}`);
  },

  async createLocation(request: any): Promise<ApiResponse<any>> {
    return postOne('/warehouse-locations', request);
  },

  async updateLocation(id: string, request: any): Promise<ApiResponse<any>> {
    return patchOne(`/warehouse-locations/${id}`, request);
  },

  async deleteLocation(id: string): Promise<ApiResponse<any>> {
    return deleteOne(`/warehouse-locations/${id}`);
  },

  // ==================== WMS — Products ====================

  async getWmsProducts(filters?: {
    categoryId?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    try {
      const body = await fetchList('/products', {}, filters?.page, filters?.limit);
      let items = body.items;
      if (filters?.categoryId) items = items.filter((p) => p.categoryId === filters.categoryId);
      if (filters?.isActive !== undefined) {
        items = items.filter((p) => (p.status !== 'archived' && p.isActive !== false) === filters.isActive);
      }
      return { success: true, data: { ...body, data: items, items } };
    } catch (err) {
      return toError(err);
    }
  },

  async getWmsProduct(id: string): Promise<ApiResponse<any>> {
    return getOne(`/products/${id}`);
  },

  async getWmsProductStats(): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no product-stats route — derive the total.
      const totalProducts = await totalCountOf('/products');
      return { success: true, data: { totalProducts, total: totalProducts } };
    } catch (err) {
      return toError(err);
    }
  },

  async verifyBarcode(barcode: string): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no barcode route — search fallback with exact match.
      const body = await fetchList('/products', { search: barcode }, 1, 25);
      const match = body.items.find((p) => p.barcode === barcode || p.sku === barcode);
      if (!match) {
        return { success: false, error: { title: 'not_found', message: `No product matches barcode ${barcode}` } };
      }
      return { success: true, data: { found: true, product: match } };
    } catch (err) {
      return toError(err);
    }
  },

  async exportWmsProducts(_format?: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): export has no app-api equivalent.
    return notSupported('exportWmsProducts');
  },

  async createWmsProduct(request: any): Promise<ApiResponse<any>> {
    return postOne('/products', request);
  },

  async updateWmsProduct(id: string, request: any): Promise<ApiResponse<any>> {
    return patchOne(`/products/${id}`, request);
  },

  async updateProductStock(id: string, request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): stock changes go through the inventory adjust route.
    return postOne('/inventory/adjust', { productId: id, ...request });
  },

  async deleteWmsProduct(id: string): Promise<ApiResponse<any>> {
    return deleteOne(`/products/${id}`);
  },

  async bulkImportProducts(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): bulk import has no app-api equivalent.
    return notSupported('bulkImportProducts');
  },

  // ==================== WMS — Putaway (no app-api equivalent) ====================

  async getPutawayTasks(_filters?: {
    warehouseId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    // TODO(phase-out): putaway tasks absent from app-api.
    return notSupported('getPutawayTasks');
  },

  async getPutawayTask(_id: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): putaway tasks absent from app-api.
    return notSupported('getPutawayTask');
  },

  async createPutawayTask(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): putaway tasks absent from app-api.
    return notSupported('createPutawayTask');
  },

  async completePutawayTask(_id: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): putaway tasks absent from app-api.
    return notSupported('completePutawayTask');
  },

  // ==================== WMS — Packing (no app-api equivalent) ====================

  async getPackingTasks(_filters?: {
    warehouseId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    // TODO(phase-out): packing tasks absent from app-api (/api/boxes is box
    // definitions, not tasks).
    return notSupported('getPackingTasks');
  },

  async getPackingTask(_id: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): packing tasks absent from app-api.
    return notSupported('getPackingTask');
  },

  async createPackingTask(_request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): packing tasks absent from app-api.
    return notSupported('createPackingTask');
  },

  async completePackingTask(_id: string, _request: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): packing tasks absent from app-api.
    return notSupported('completePackingTask');
  },

  // ==================== WMS — Movements & dashboard ====================

  async getStockMovements(filters?: {
    productId?: string;
    warehouseId?: string;
    type?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/inventory-movements',
      { productId: filters?.productId, warehouseId: filters?.warehouseId, movementType: filters?.type },
      filters?.page,
      filters?.limit,
    );
  },

  async getWmsDashboard(): Promise<ApiResponse<any>> {
    // TODO(phase-out): shape delta — /api/wms-activity returns the activity
    // feed, not the legacy dashboard aggregate (screens are defensive).
    return getOne('/wms-activity');
  },

  async getRecentMovements(limit = 10): Promise<ApiResponse<any>> {
    return arrayResponse('/inventory-movements', {}, limit);
  },

  async getWmsAnalytics(_warehouseId?: string): Promise<ApiResponse<any>> {
    // TODO(phase-out): the legacy WmsAnalytics aggregate has no app-api
    // equivalent; composing it client-side would take several heavy list
    // scans. Dead in prod today too.
    return notSupported('getWmsAnalytics');
  },

  // ==================== PARCEL ====================

  async getParcelDashboardStats(): Promise<ApiResponse<any>> {
    // TODO(phase-out): field names differ from the legacy ParcelDashboardStats
    // shape — /api/parcel-analytics is the closest aggregate.
    return getOne('/parcel-analytics');
  },

  async getRecentParcels(limit = 5): Promise<ApiResponse<any>> {
    return arrayResponse('/parcels', {}, limit);
  },

  async getParcelTodayOverview(): Promise<ApiResponse<any>> {
    // TODO(phase-out): no today-overview aggregate on app-api.
    return notSupported('getParcelTodayOverview');
  },

  async getParcels(params?: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/parcels',
      { status: params?.status, search: params?.search },
      params?.page,
      params?.limit,
    );
  },

  async getParcel(id: string): Promise<ApiResponse<any>> {
    return getOne(`/parcels/${id}`);
  },

  async trackParcel(trackingNumber: string): Promise<ApiResponse<any>> {
    return findParcelByTracking(trackingNumber);
  },

  async getParcelReturns(params?: {
    page?: number;
    limit?: number;
    status?: string;
  }): Promise<ApiResponse<any>> {
    return listResponse('/returns', { status: params?.status }, params?.page, params?.limit);
  },

  async getParcelPickups(params?: {
    page?: number;
    limit?: number;
    status?: string;
  }): Promise<ApiResponse<any>> {
    return listResponse('/pickups', { status: params?.status }, params?.page, params?.limit);
  },

  async getParcelOrders(params?: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/orders',
      { status: params?.status, search: params?.search },
      params?.page,
      params?.limit,
    );
  },

  async lookupParcelByBarcode(barcode: string): Promise<ApiResponse<any>> {
    return findParcelByTracking(barcode);
  },

  async getParcelDetails(trackingNumber: string): Promise<ApiResponse<any>> {
    return findParcelByTracking(trackingNumber);
  },

  async updateParcelStatus(trackingNumber: string, status: string, _location?: string): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no tracking-number route — resolve the parcel id via
      // search, then PATCH. The scan location has no app-api field.
      const found = await findParcelByTracking(trackingNumber);
      if (!found.success || !found.data?.id) {
        return found.success
          ? { success: false, error: { title: 'not_found', message: `Parcel ${trackingNumber} not found` } }
          : (found as ApiResponse<never>);
      }
      await appApiClient.patch<{ data: any }>(`/parcels/${found.data.id}`, { status });
      return { success: true };
    } catch (err) {
      return toError(err);
    }
  },

  // ==================== WELDCONNECT — Tasks ====================

  async getTaskDashboard(): Promise<ApiResponse<any>> {
    try {
      // Compose: my tasks + workflow stats (legacy /tasks/dashboard bundled both).
      const [myTasks, stats] = await Promise.all([
        appApiClient.get<AppApiListEnvelope>('/my-tasks').catch(() => ({ data: [] as any[] })),
        appApiClient.get<{ data: any }>('/workflow-dashboard/stats').catch(() => ({ data: null })),
      ]);
      return {
        success: true,
        data: { tasks: myTasks.data ?? [], myTasks: myTasks.data ?? [], workflowStats: stats.data },
      };
    } catch (err) {
      return toError(err);
    }
  },

  async getTaskStats(): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no task-stats route — derive the total.
      const totalTasks = await totalCountOf('/tasks');
      return { success: true, data: { totalTasks, total: totalTasks } };
    } catch (err) {
      return toError(err);
    }
  },

  async getTasks(params?: {
    status?: string;
    priority?: string;
    assigneeId?: string;
    projectId?: string;
    isImportant?: boolean;
    isArchived?: boolean;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    try {
      const body = await fetchList(
        '/tasks',
        {
          status: params?.status,
          priority: params?.priority,
          assigneeId: params?.assigneeId,
          projectId: params?.projectId,
          search: params?.search,
        },
        params?.page,
        params?.limit,
      );
      let items = body.items;
      // isImportant/isArchived aren't list filters on app-api — filter here.
      if (params?.isImportant !== undefined) items = items.filter((t) => Boolean(t.isImportant) === params.isImportant);
      if (params?.isArchived !== undefined) items = items.filter((t) => Boolean(t.isArchived) === params.isArchived);
      return { success: true, data: { ...body, data: items, items } };
    } catch (err) {
      return toError(err);
    }
  },

  async getTask(id: string): Promise<ApiResponse<any>> {
    return getOne(`/tasks/${id}`);
  },

  async createTask(data: {
    title: string;
    description?: string;
    priority?: string;
    dueDate?: string;
    assigneeId?: string;
    projectId?: string;
    tags?: string[];
    isImportant?: boolean;
  }): Promise<ApiResponse<any>> {
    return postOne('/tasks', data);
  },

  async updateTask(id: string, data: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    dueDate?: string;
    assigneeId?: string;
    projectId?: string;
    tags?: string[];
    isImportant?: boolean;
    isArchived?: boolean;
  }): Promise<ApiResponse<any>> {
    return patchOne(`/tasks/${id}`, data);
  },

  async deleteTask(id: string): Promise<ApiResponse<any>> {
    return deleteOne(`/tasks/${id}`);
  },

  async toggleTaskComplete(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/tasks/${id}/toggle`, {});
  },

  async toggleTaskImportant(id: string): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): no toggle-important route — fetch-then-invert.
      const current = await appApiClient.get<{ data: any }>(`/tasks/${id}`);
      const res = await appApiClient.patch<{ data: any }>(`/tasks/${id}`, {
        isImportant: !current.data?.isImportant,
      });
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  },

  async getTaskComments(taskId: string): Promise<ApiResponse<any>> {
    return arrayResponse('/task-comments', { taskId }, 100);
  },

  async addTaskComment(taskId: string, content: string): Promise<ApiResponse<any>> {
    return postOne('/task-comments', { taskId, content });
  },

  // ==================== WELDCONNECT — Task projects & tags ====================

  async getTaskProjects(): Promise<ApiResponse<any>> {
    return arrayResponse('/task-projects', {}, 100);
  },

  async getTaskProject(id: string): Promise<ApiResponse<any>> {
    return getOne(`/task-projects/${id}`);
  },

  async createTaskProject(data: {
    name: string;
    description?: string;
    color?: string;
    icon?: string;
  }): Promise<ApiResponse<any>> {
    return postOne('/task-projects', data);
  },

  async updateTaskProject(id: string, data: {
    name?: string;
    description?: string;
    color?: string;
    icon?: string;
  }): Promise<ApiResponse<any>> {
    return patchOne(`/task-projects/${id}`, data);
  },

  async deleteTaskProject(id: string): Promise<ApiResponse<any>> {
    return deleteOne(`/task-projects/${id}`);
  },

  async getTaskTags(): Promise<ApiResponse<any>> {
    return arrayResponse('/task-tags', {}, 100);
  },

  async createTaskTag(data: { name: string; color?: string }): Promise<ApiResponse<any>> {
    return postOne('/task-tags', data);
  },

  // ==================== WELDCONNECT — Workflows ====================

  async getWorkflows(params?: {
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/workflows',
      { status: params?.status, search: params?.search },
      params?.page,
      params?.limit,
    );
  },

  async getWorkflow(id: string): Promise<ApiResponse<any>> {
    return getOne(`/workflows/${id}`);
  },

  async createWorkflow(data: {
    name: string;
    description?: string;
    steps?: any[];
    settings?: any;
    tags?: string[];
  }): Promise<ApiResponse<any>> {
    return postOne('/workflows', data);
  },

  async updateWorkflow(_id: string, _data: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): app-api workflows expose PATCH /:id/status only —
    // general edits go through the workflow-builder surface, which has no
    // mobile mapping yet.
    return notSupported('updateWorkflow');
  },

  async deleteWorkflow(id: string): Promise<ApiResponse<any>> {
    return deleteOne(`/workflows/${id}`);
  },

  async activateWorkflow(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/workflows/${id}/status`, { status: 'active' });
  },

  async pauseWorkflow(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/workflows/${id}/status`, { status: 'paused' });
  },

  async testWorkflow(id: string, testData?: any): Promise<ApiResponse<any>> {
    return postOne(`/workflows/${id}/test`, { testData });
  },

  async triggerWorkflow(id: string, data?: any): Promise<ApiResponse<any>> {
    return postOne(`/workflows/${id}/trigger`, data || {});
  },

  // ==================== WELDCONNECT — Executions ====================

  async getExecutions(params?: {
    workflowId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/workflow-executions',
      { workflowId: params?.workflowId, status: params?.status },
      params?.page,
      params?.limit,
    );
  },

  async getExecution(id: string): Promise<ApiResponse<any>> {
    return getOne(`/workflow-executions/${id}`);
  },

  async cancelExecution(id: string): Promise<ApiResponse<any>> {
    return patchOne(`/workflow-executions/${id}/cancel`, {});
  },

  async retryExecution(id: string): Promise<ApiResponse<any>> {
    return postOne(`/workflow-executions/${id}/retry`, {});
  },

  // ==================== WELDCONNECT — Schedules ====================

  async getSchedules(params?: {
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse('/workflow-schedules', {}, params?.page, params?.limit);
  },

  async createSchedule(data: {
    workflowId: string;
    cronExpression?: string;
    interval?: number;
    timezone?: string;
  }): Promise<ApiResponse<any>> {
    return postOne('/workflow-schedules', data);
  },

  async toggleSchedule(id: string): Promise<ApiResponse<any>> {
    try {
      // app-api's PATCH /:id/toggle needs the explicit { enabled } value —
      // fetch-then-invert to preserve the legacy parameterless toggle.
      const current = await appApiClient.get<{ data: any }>(`/workflow-schedules/${id}`);
      const res = await appApiClient.patch<{ data: any }>(`/workflow-schedules/${id}/toggle`, {
        enabled: !current.data?.enabled,
      });
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  },

  async deleteSchedule(id: string): Promise<ApiResponse<any>> {
    return deleteOne(`/workflow-schedules/${id}`);
  },

  // ==================== WELDCONNECT — Templates & analytics ====================

  async getWorkflowTemplates(params?: {
    category?: string;
    difficulty?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse<any>> {
    return listResponse(
      '/workflow-templates',
      { category: params?.category, difficulty: params?.difficulty, search: params?.search },
      params?.page,
      params?.limit,
    );
  },

  async useTemplate(templateId: string, name: string): Promise<ApiResponse<any>> {
    return postOne(`/workflow-templates/${templateId}/use`, { name });
  },

  async getWorkflowStats(): Promise<ApiResponse<any>> {
    return getOne('/workflow-dashboard/stats');
  },

  async getExecutionTrends(period: 'day' | 'week' | 'month' = 'week'): Promise<ApiResponse<any>> {
    return getOne(`/workflow-executions/trends?period=${period}`);
  },

  async getWorkflowMetrics(workflowId: string): Promise<ApiResponse<any>> {
    return getOne(`/workflows/${workflowId}/metrics`);
  },
};

// ============================================================
// Internal helpers referencing multiple methods
// ============================================================

/**
 * Resolve a parcel by tracking number via list search + exact client-side
 * match (app-api has no tracking-number route).
 */
async function findParcelByTracking(trackingNumber: string): Promise<ApiResponse<any>> {
  try {
    const res = await appApiClient.get<AppApiListEnvelope>(`/parcels${qs({ search: trackingNumber, limit: 25 })}`);
    const items = res.data ?? [];
    const match =
      items.find((p: any) => p.trackingNumber === trackingNumber || p.barcode === trackingNumber) ?? items[0];
    if (!match) {
      return { success: false, error: { title: 'not_found', message: `Parcel ${trackingNumber} not found` } };
    }
    return { success: true, data: match };
  } catch (err) {
    return toError(err);
  }
}

export type CommerceWmsConnectModule = typeof commerceWmsConnect;

export default commerceWmsConnect;
