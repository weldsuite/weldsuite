/**
 * Legacy-compatible WeldSuite API facade, now backed by the unified app-api.
 *
 * W1b of the legacy-worker phase-out: this file used to be a 5,200-line
 * `ApiService extends ApiServiceBase` targeting the obsolete mobile-api-worker
 * (`/v1`, port 8787). It is now a thin aggregator over four domain modules in
 * `services/modules/` that call app-api (`/api/...`, port 8789) through
 * `services/app-api.ts`.
 *
 * The public surface is unchanged so screens need ZERO rewrites:
 * - every legacy method name + signature is preserved (modules adapt the
 *   app-api `{ data }` / `{ data, pagination }` envelopes back to the legacy
 *   `{ success, data }` shape, and emulate page-based pagination over
 *   app-api's cursors);
 * - the `setTokenRefreshCallback` / `setAccessToken` / `setOrganizationId`
 *   wiring used by `app/_layout.tsx` and `services/notifications.ts` works
 *   the same (org id is a no-op — app-api derives the workspace from the
 *   Clerk JWT's active org);
 * - all type exports (`Product`, `Ticket`, `Invoice`, …) resolve from the
 *   same `@/services/api` import path;
 * - the generic `get/post/put/patch/delete` passthroughs used by
 *   `contexts/VoipContext.tsx` rewrite legacy `/crm/call-intelligence/*`
 *   paths to the live app-api routes.
 *
 * Module split:
 * - `modules/core-user`         — workspace/org/apps, profile, push tokens,
 *                                 notifications, VoIP passthrough
 * - `modules/mail-accounting`   — WeldMail + WeldBooks + document scanning
 * - `modules/helpdesk-crm-projects` — WeldDesk + WeldCRM + WeldFlow
 * - `modules/commerce-wms-connect`  — WeldCommerce + WeldStash + Parcel +
 *                                 WeldConnect tasks/workflows
 */

import type { ApiResponse, NotificationPreferences } from '@weldsuite/mobile-ui/types';

import { setAppApiTokenGetter, APP_API_URL } from './app-api';
import { coreUserModule } from './modules/core-user';
import { mailAccountingModule } from './modules/mail-accounting';
import { helpdeskCrmProjectsApi } from './modules/helpdesk-crm-projects';
import { commerceWmsConnect } from './modules/commerce-wms-connect';

// ============================================================================
// Type re-exports (backwards compatible with the legacy services/api.ts)
// ============================================================================

export type {
  InstalledApp,
  WorkspaceMember,
  Workspace,
  WorkspaceWithMembership,
  NotificationPreferences,
  ModulePreferencesMap,
  ModuleChannelPreferences,
  ApiResponse,
  PaginatedResponse,
} from '@weldsuite/mobile-ui/types';

export type { Address, User } from './modules/core-user';

export type {
  EmailAccount,
  EmailLabel,
  Email,
  EmailDetail,
  EmailAttachment,
  EmailStats,
  SendEmailRequest,
  AccountingDashboardStats,
  RecentInvoice,
  RecentTransaction,
  InvoiceItem,
  Invoice,
  LedgerEntry,
  BankAccount,
  BankTransaction,
  BankAccountDetail,
  AccountingAnalytics,
  AccountingInboxItem,
  DocumentUpload,
  VatReturn,
  VatReturnDetail,
  VatBreakdown,
  VatAdjustment,
  VatSummary,
  ReconciliationStats,
  ReconciliationAccountSummary,
  UnmatchedTransaction,
  SuggestedMatch,
  Bill,
  BillDetail,
  BillLineItem,
  CreateBillRequest,
} from './modules/mail-accounting';

export type {
  Ticket,
  TicketDetail,
  TicketMessage,
  HelpdeskStats,
  RecentTicket,
  RecentActivity,
  HelpdeskDashboard,
  TeamMember,
  Contact,
  TicketFilters,
  Conversation,
  ConversationDetail,
  ConversationMessage,
  ConversationFilters,
  ContactFilters,
  CreateContactRequest,
  UpdateContactRequest,
  UpdateTicketStatusRequest,
  UpdateTicketPriorityRequest,
  AssignTicketRequest,
  CrmDashboardStats,
  CrmActivity,
  CrmCustomer,
  CrmLead,
  CrmTask,
  CrmNote,
  CreateCrmTaskRequest,
  UpdateCrmTaskRequest,
  CreateCrmNoteRequest,
  UpdateCrmNoteRequest,
  CustomerRecord,
  PipelineStage,
  PipelineWithStages,
  OpportunityRecord,
  ProjectStats,
  Project,
  ProjectDetail,
  ProjectTask,
  ProjectTaskWithProject,
  ProjectTaskStats,
  ProjectReports,
  ProjectMember,
  ProjectFile,
  TimeEntry,
  ProjectDocument,
  ProjectGoalsData,
  WorkloadTaskStats,
  WorkloadMemberTask,
  WorkloadMember,
  WorkloadOverview,
  ProjectWorkloadData,
  ProjectWhiteboard,
  CreateProjectRequest,
  UpdateProjectRequest,
} from './modules/helpdesk-crm-projects';

export type { CustomerFilters, OrderFilters, InventoryFilters } from './modules/commerce-wms-connect';

// ============================================================================
// Commerce / WMS / Parcel types (owned by this facade — the legacy file
// declared them inline; screens import them from '@/services/api')
// ============================================================================

export interface Money {
  amount: number;
  currency: string;
}

export interface Product {
  id: string;
  name: string;
  slug?: string;
  sku: string;
  shortDescription?: string;
  price: Money;
  compareAtPrice?: Money;
  thumbnailUrl?: string;
  categoryId?: string;
  categoryName?: string;
  status: string;
  stock?: number;
  inStock: boolean;
  averageRating?: number;
  reviewCount?: number;
  hasVariants: boolean;
  tags?: string[];
  createdAt: string;
}

export interface ProductDetail extends Product {
  description?: string;
  features?: string[];
  specifications?: Record<string, string>;
  images?: ProductImage[];
  variants?: ProductVariant[];
  barcode?: string;
  brand?: string;
  allowBackorder?: boolean;
  trackInventory: boolean;
  weight?: number;
  weightUnit?: string;
  requiresShipping: boolean;
  isTaxable: boolean;
  updatedAt: string;
}

export interface ProductImage {
  id: string;
  url: string;
  thumbnailUrl?: string;
  altText?: string;
  position: number;
}

export interface ProductVariant {
  id: string;
  title: string;
  sku: string;
  price: Money;
  compareAtPrice?: Money;
  stock?: number;
  inStock: boolean;
  optionValues: string[];
  imageUrl?: string;
}

export interface Category {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  productCount: number;
  parentId?: string;
  position?: number;
  isActive: boolean;
  subcategories?: Category[];
}

export interface ScanResult {
  code: string;
  codeType: string;
  found: boolean;
  product?: ProductDetail;
  message?: string;
  scannedAt: string;
}

export interface CartItem {
  id: string;
  productId: string;
  variantId?: string;
  quantity: number;
  price: number;
  product?: Product;
  variant?: ProductVariant;
}

export interface Cart {
  id: string;
  items: CartItem[];
  totalPrice: number;
  totalItems: number;
}

export interface ProductStats {
  total: number;
  active: number;
  draft: number;
  archived: number;
}

export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  company?: string;
  email: string;
  alternateEmail?: string;
  phone?: string;
  website?: string;
  type: 'B2C' | 'B2B';
  customerGroup?: string;
  vipStatus: 'none' | 'bronze' | 'silver' | 'gold' | 'platinum';
  tags?: string[];
  accountStatus: 'active' | 'inactive' | 'suspended' | 'deleted';
  orderCount: number;
  totalSpent: number;
  averageOrderValue: number;
  firstPurchaseDate?: string;
  lastPurchaseDate?: string;
  acquisitionChannel?: string;
  referralSource?: string;
  preferredLanguage?: string;
  preferredCurrency?: string;
  timezone?: string;
  emailVerified: boolean;
  acceptsMarketing: boolean;
  acceptsSms: boolean;
  taxExempt: boolean;
  taxId?: string;
  loyaltyPoints?: number;
  loyaltyTier?: string;
  memberSince?: string;
  internalNotes?: string;
  customFields?: Record<string, any>;
  defaultShippingAddressId?: string;
  defaultBillingAddressId?: string;
  userId?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  paymentStatus: string;
  fulfillmentStatus: string;
  total: number;
  subtotal: number;
  tax: number;
  shipping: number;
  itemsCount: number;
  orderDate: string;
  shippedDate?: string;
  trackingNumber?: string;
  shippingMethod?: string;
  items: OrderItem[];
  shippingAddress?: OrderAddress;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  productImage?: string;
  sku: string;
  quantity: number;
  price: number;
  total: number;
}

export interface OrderAddress {
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

export interface InventoryItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  currentStock: number;
  reservedStock: number;
  availableStock: number;
  reorderLevel: number;
  reorderQuantity: number;
  unitCost: number;
  lastRestocked?: string;
  location?: string;
  category: string;
  status: 'in_stock' | 'low_stock' | 'out_of_stock';
}

export interface DashboardStats {
  totalSales: number;
  todaySales: number;
  weekSales: number;
  monthSales: number;
  totalOrders: number;
  pendingOrders: number;
  processingOrders: number;
  shippedOrders: number;
  totalProducts: number;
  lowStockProducts: number;
  totalCustomers: number;
  newCustomersToday: number;
}

export interface RecentOrder {
  id: string;
  customerName: string;
  total: number;
  status: string;
  createdAt: string;
}

export interface TopProduct {
  id: string;
  name: string;
  sales: number;
  revenue: number;
}

export interface PerformanceMetrics {
  totalRevenue: number;
  totalRevenue_change: number;
  totalOrders: number;
  totalOrders_change: number;
  activeCustomers: number;
  activeCustomers_change: number;
  productsSold: number;
  productsSold_change: number;
}

export interface ConversionMetrics {
  conversionRate: number;
  averageOrderValue: number;
  cartAbandonmentRate: number;
  repeatPurchaseRate: number;
}

export interface CategoryPerformance {
  category: string;
  revenue: number;
  orders: number;
}

export interface ChannelMetrics {
  channel: string;
  percentage: number;
  revenue: number;
}

export interface WmsAnalytics {
  inventory: {
    totalItems: number;
    totalQuantity: number;
    lowStockItems: number;
    outOfStockItems: number;
    totalValue: number;
    health: {
      healthy: number;
      adequate: number;
      low: number;
      outOfStock: number;
    };
  };
  orders: {
    today: number;
    thisWeek: number;
    thisMonth: number;
    growth: number;
    fulfillmentRate: number;
  };
  pickLists: {
    total: number;
    completed: number;
    completionRate: number;
  };
  shipping: {
    shipmentsThisMonth: number;
    deliveredThisMonth: number;
  };
  dailyOrders: {
    day: string;
    date: string;
    orders: number;
  }[];
  topProducts: {
    productId: string;
    productName: string;
    quantity: number;
  }[];
}

export interface ParcelLookup {
  found: boolean;
  trackingNumber: string;
  carrier?: string;
  status?: string;
  recipient?: string;
  sender?: string;
  currentLocation?: string;
  estimatedDelivery?: string;
  events?: ParcelEvent[];
}

export interface ParcelEvent {
  timestamp: string;
  status: string;
  location?: string;
  description?: string;
}

export interface ParcelDetail {
  id: string;
  trackingNumber: string;
  carrier: string;
  status: 'pending' | 'in-transit' | 'out-for-delivery' | 'delivered' | 'failed' | 'returned';
  sender: {
    name: string;
    address: string;
    city: string;
    country: string;
  };
  recipient: {
    name: string;
    address: string;
    city: string;
    country: string;
    phone?: string;
  };
  weight?: number;
  dimensions?: { length: number; width: number; height: number };
  shippedAt?: string;
  estimatedDelivery?: string;
  deliveredAt?: string;
  events: ParcelEvent[];
}

// ============================================================================
// Error-message helper (previously re-exported from the deleted
// @weldsuite/mobile-ui/services/api-base)
// ============================================================================

export function getApiErrorMessage(
  error: ApiResponse<unknown>['error'],
  fallback = 'An error occurred',
): string {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  return error.message || error.title || fallback;
}

// ============================================================================
// Base URL (legacy export — repointed from mobile-api-worker to app-api)
// ============================================================================

export const API_URL = APP_API_URL;

// ============================================================================
// Auth wiring — the app-api client re-reads the token on every request via
// the getter below; `app/_layout.tsx` keeps driving the legacy hooks.
// ============================================================================

/** Static token fallback used when no refresh callback is wired. */
let staticToken: string | null = null;
let refreshCallback: (() => Promise<string | null>) | null = null;

setAppApiTokenGetter(async () => {
  if (refreshCallback) {
    try {
      const token = await refreshCallback();
      if (token) {
        staticToken = token;
        return token;
      }
    } catch (error) {
      console.error('Token refresh failed:', error);
    }
  }
  return staticToken;
});

// ============================================================================
// The facade — legacy auth hooks + the four domain modules
// ============================================================================

const api = {
  /** Called before each request to fetch a fresh Clerk token. */
  setTokenRefreshCallback(callback: (() => Promise<string | null>) | null) {
    refreshCallback = callback;
  },

  setAccessToken(token: string | null) {
    staticToken = token;
  },

  setOrganizationId(_orgId: string | null | undefined) {
    // No-op: app-api derives the workspace from the Clerk JWT's active org
    // (the legacy x-organization-id header was never read by the middleware).
  },

  ...coreUserModule,
  ...mailAccountingModule,
  ...helpdeskCrmProjectsApi,
  ...commerceWmsConnect,

  // `services/notifications.ts` passes an (ignored) emailAccountId argument —
  // preserve the legacy arity on top of the module implementation.
  getNotificationPreferences(_emailAccountId?: string): Promise<ApiResponse<NotificationPreferences>> {
    return coreUserModule.getNotificationPreferences();
  },
};

export { api };
export default api;

/**
 * Helper function to initialize API with Clerk token
 * Call this after successful authentication
 *
 * Usage:
 * ```typescript
 * import { useClerkAuth } from '@/contexts/ClerkAuthContext';
 * import api, { initializeApi } from '@/services/api';
 *
 * const { getCredentials } = useClerkAuth();
 *
 * useEffect(() => {
 *   const init = async () => {
 *     const credentials = await getCredentials();
 *     if (credentials) {
 *       api.setAccessToken(credentials.accessToken);
 *     }
 *   };
 *   init();
 * }, []);
 * ```
 */
export const initializeApi = async (getCredentials: () => Promise<any>) => {
  try {
    const credentials = await getCredentials();
    if (credentials?.accessToken) {
      api.setAccessToken(credentials.accessToken);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to initialize API with Clerk token:', error);
    return false;
  }
};
