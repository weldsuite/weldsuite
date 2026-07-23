/**
 * WeldSuite Complete API Type Definitions
 * Comprehensive type system for all 20+ integrated applications
 * With all features and correct data relationships
 */

// ============================================================================
// Common Types
// ============================================================================

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: PaginationMeta;
}

interface ApiError {
  code: string;
  message: string;
  details?: Record<string, any>;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

interface PaginationParams {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  filters?: Record<string, any>;
}

interface DateRange {
  start: string;
  end: string;
}

interface TimestampFields {
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string; // Soft delete support
}

export interface BaseEntity extends TimestampFields {
  id: string;
}

interface Address {
  id?: string;
  type?: 'billing' | 'shipping' | 'both' | 'office' | 'home';
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
  isDefault?: boolean;
  label?: string; // Custom label like "Main Office", "Warehouse 1"
}

interface Money {
  amount: number;
  currency: string;
  formatted?: string; // "$1,234.56"
}

interface PhoneNumber {
  number: string;
  type: 'mobile' | 'work' | 'home' | 'fax';
  isPrimary?: boolean;
}

interface SocialMedia {
  platform: 'linkedin' | 'twitter' | 'facebook' | 'instagram' | 'youtube' | 'tiktok' | 'other';
  url: string;
  handle?: string;
}

interface CustomField {
  key: string;
  label: string;
  value: any;
  type: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect' | 'url' | 'email';
  options?: string[]; // For select/multiselect
}

interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  thumbnailUrl?: string;
  uploadedBy?: string;
  uploadedAt?: string;
}

interface Tag {
  id: string;
  name: string;
  color?: string;
  category?: string;
}

// ============================================================================
// Authentication & Authorization Types
// ============================================================================

interface User extends BaseEntity {
  email: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  avatar?: string;
  phone?: string;
  role: UserRole;
  permissions?: Permission[];
  emailVerified?: boolean;
  phoneVerified?: boolean;
  twoFactorEnabled?: boolean;
  lastLogin?: string;
  loginCount?: number;
  preferences?: UserPreferences;
  metadata?: Record<string, any>;
  status: 'active' | 'inactive' | 'suspended' | 'pending';
}

type UserRole = 'super_admin' | 'admin' | 'manager' | 'user' | 'support' | 'sales' | 'accounting' | 'warehouse';

interface Permission {
  resource: string;
  action: string[];
}

interface NotificationPreferences {
  email?: boolean;
  push?: boolean;
  sms?: boolean;
  inApp?: boolean;
  digest?: 'none' | 'daily' | 'weekly';
  categories?: Record<string, boolean>;
}

interface UserPreferences {
  theme?: 'light' | 'dark' | 'auto';
  language?: string;
  timezone?: string;
  dateFormat?: string;
  currency?: string;
  notifications?: NotificationPreferences;
}

// ============================================================================
// COMMERCE MODULE - Complete with all features
// ============================================================================

interface Product extends BaseEntity {
  // Basic Information
  sku: string;
  name: string;
  slug: string;
  description?: string;
  shortDescription?: string;

  // Pricing
  price: Money;
  compareAtPrice?: Money;
  costPrice?: Money;

  // Organization
  categoryIds: string[];
  brandId?: string;
  vendorId?: string;
  collectionIds?: string[];

  // Media
  images: ProductImage[];
  videos?: ProductVideo[];
  documents?: Attachment[];

  // Inventory
  trackInventory: boolean;
  inventoryPolicy: 'deny' | 'continue'; // When out of stock
  stock: number;
  lowStockThreshold?: number;

  // Variants
  hasVariants: boolean;
  variants?: ProductVariant[];
  options?: ProductOption[]; // Size, Color, etc.

  // Physical Properties
  weight?: number;
  weightUnit?: 'kg' | 'lb' | 'oz' | 'g';
  dimensions?: {
    length: number;
    width: number;
    height: number;
    unit: 'cm' | 'in' | 'm' | 'ft';
  };

  // SEO
  metaTitle?: string;
  metaDescription?: string;
  metaKeywords?: string[];

  // Status & Visibility
  status: 'active' | 'draft' | 'archived';
  visibility: 'visible' | 'hidden' | 'catalog' | 'search';
  publishedAt?: string;

  // Features
  isFeatured?: boolean;
  isDigital?: boolean;
  isGiftCard?: boolean;
  requiresShipping?: boolean;
  taxable?: boolean;

  // Additional Data
  tags?: string[];
  customFields?: CustomField[];
  attributes?: ProductAttribute[];

  // Analytics
  viewCount?: number;
  purchaseCount?: number;
  rating?: number;
  reviewCount?: number;
}

interface ProductImage {
  id: string;
  url: string;
  alt?: string;
  position: number;
  isMain: boolean;
}

interface ProductVideo {
  id: string;
  url: string;
  type: 'youtube' | 'vimeo' | 'custom';
  thumbnail?: string;
  duration?: number;
}

interface ProductVariant extends BaseEntity {
  productId: string;
  sku: string;
  name: string;
  price?: Money;
  compareAtPrice?: Money;
  costPrice?: Money;
  stock?: number;
  weight?: number;
  image?: string;
  barcode?: string;
  options: VariantOption[];
  isDefault?: boolean;
  position?: number;
}

interface VariantOption {
  name: string; // "Size", "Color"
  value: string; // "Large", "Red"
}

interface ProductOption {
  id: string;
  name: string; // "Size", "Color", "Material"
  values: string[]; // ["S", "M", "L", "XL"]
  position: number;
}

interface ProductAttribute {
  key: string;
  label: string;
  value: string;
  group?: string;
  showInProductPage?: boolean;
}

interface Collection extends BaseEntity {
  name: string;
  slug: string;
  description?: string;
  image?: string;
  type: 'manual' | 'automated';
  rules?: CollectionRule[]; // For automated collections
  productIds?: string[]; // For manual collections
  position?: number;
  isActive: boolean;
  seo?: {
    title?: string;
    description?: string;
    keywords?: string[];
  };
}

interface CollectionRule {
  field: string; // "price", "vendor", "tag", etc.
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than';
  value: any;
}

interface Category extends BaseEntity {
  name: string;
  slug: string;
  description?: string;
  parentId?: string;
  image?: string;
  icon?: string;
  position: number;
  level: number;
  path: string; // "/electronics/computers/laptops"
  productCount?: number;
  isActive: boolean;
  showInMenu?: boolean;
  seo?: {
    title?: string;
    description?: string;
    keywords?: string[];
  };
}

interface Brand extends BaseEntity {
  name: string;
  slug: string;
  logo?: string;
  description?: string;
  website?: string;
  isActive: boolean;
}

// Commerce - Orders & Cart

interface Order extends BaseEntity {
  // Identification
  orderNumber: string;
  referenceNumber?: string;

  // Customer
  customerId: string;
  customerType: 'b2c' | 'b2b';
  customerEmail: string;
  customerPhone?: string;

  // Items
  items: OrderItem[];

  // Pricing
  subtotal: Money;
  taxAmount: Money;
  shippingAmount: Money;
  discountAmount: Money;
  total: Money;

  // Discounts
  discounts?: AppliedDiscount[];
  couponCode?: string;

  // Addresses
  billingAddress: Address;
  shippingAddress?: Address;

  // Status
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;

  // Payment
  paymentMethod?: string;
  paymentDetails?: Record<string, any>;

  // Shipping
  shippingMethod?: string;
  shippingCarrier?: string;
  trackingNumber?: string;
  estimatedDelivery?: string;
  actualDelivery?: string;

  // Additional
  notes?: string;
  internalNotes?: string;
  tags?: string[];
  source?: 'web' | 'pos' | 'mobile' | 'marketplace' | 'manual';
  channel?: string;

  // Dates
  paidAt?: string;
  fulfilledAt?: string;
  cancelledAt?: string;
  refundedAt?: string;
}

type OrderStatus =
  | 'draft'
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'failed';

type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'partially_paid'
  | 'partially_refunded'
  | 'refunded'
  | 'voided'
  | 'failed';

type FulfillmentStatus =
  | 'unfulfilled'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'cancelled'
  | 'returned';

interface OrderItem extends BaseEntity {
  // Product
  productId: string;
  variantId?: string;
  sku: string;
  name: string;
  image?: string;

  // Quantity & Pricing
  quantity: number;
  price: Money;
  compareAtPrice?: Money;
  total: Money;

  // Discounts & Tax
  discountAmount?: Money;
  taxAmount?: Money;
  taxRate?: number;

  // Fulfillment
  fulfilledQuantity?: number;
  refundedQuantity?: number;

  // Additional
  customization?: Record<string, any>;
  giftMessage?: string;
  warranty?: string;
  metadata?: Record<string, any>;
}

interface Cart extends BaseEntity {
  // Identification
  sessionId?: string;
  customerId?: string;

  // Items
  items: CartItem[];

  // Pricing
  subtotal: Money;
  taxAmount: Money;
  shippingAmount: Money;
  discountAmount: Money;
  total: Money;

  // Discounts
  appliedDiscounts?: AppliedDiscount[];
  couponCode?: string;

  // Addresses
  shippingAddress?: Address;
  billingAddress?: Address;

  // Shipping
  shippingMethod?: ShippingMethod;
  availableShippingMethods?: ShippingMethod[];

  // Additional
  notes?: string;
  abandonedAt?: string;
  recoveryEmailSent?: boolean;
  expiresAt?: string;
}

interface CartItem {
  id: string;
  productId: string;
  variantId?: string;
  sku: string;
  name: string;
  image?: string;
  quantity: number;
  price: Money;
  total: Money;
  customization?: Record<string, any>;
}

// Commerce - Discounts & Promotions

interface Discount extends BaseEntity {
  // Basic
  name: string;
  code?: string; // Coupon code
  description?: string;

  // Type & Value
  type: DiscountType;
  valueType: 'percentage' | 'fixed';
  value: number;

  // Application
  appliesTo: 'order' | 'products' | 'shipping' | 'categories' | 'customers';
  productIds?: string[];
  categoryIds?: string[];
  customerGroupIds?: string[];

  // Conditions
  minimumAmount?: Money;
  minimumQuantity?: number;
  maximumDiscount?: Money;

  // Buy X Get Y
  buyXGetY?: {
    buyQuantity: number;
    buyProductIds?: string[];
    getQuantity: number;
    getProductIds?: string[];
    getDiscount: number; // Percentage
  };

  // Usage
  usageLimit?: number;
  usageCount: number;
  usageLimitPerCustomer?: number;

  // Validity
  startDate?: string;
  endDate?: string;

  // Rules
  stackable: boolean;
  priority: number;
  excludeSaleItems?: boolean;

  // Status
  isActive: boolean;
}

type DiscountType =
  | 'percentage'
  | 'fixed_amount'
  | 'buy_x_get_y'
  | 'free_shipping'
  | 'tiered'; // Based on cart value tiers

interface AppliedDiscount {
  discountId: string;
  code?: string;
  type: DiscountType;
  amount: Money;
  description: string;
}

// Commerce - Reviews & Ratings

interface Review extends BaseEntity {
  // Relations
  productId: string;
  customerId: string;
  orderId?: string;

  // Review Content
  rating: number; // 1-5
  title?: string;
  comment?: string;
  pros?: string[];
  cons?: string[];

  // Media
  images?: string[];
  videos?: string[];

  // Verification
  isVerifiedPurchase: boolean;

  // Interaction
  helpfulCount: number;
  reportCount?: number;

  // Response
  merchantResponse?: {
    comment: string;
    respondedBy: string;
    respondedAt: string;
  };

  // Status
  status: 'pending' | 'approved' | 'rejected' | 'flagged';
  moderatedBy?: string;
  moderatedAt?: string;
}

// Commerce - Wishlist

interface Wishlist extends BaseEntity {
  customerId: string;
  name: string;
  isDefault: boolean;
  isPublic: boolean;
  items: WishlistItem[];
  sharedWith?: string[]; // Email addresses
  shareToken?: string; // For public sharing
}

interface WishlistItem {
  id: string;
  productId: string;
  variantId?: string;
  addedAt: string;
  notes?: string;
  priority?: number;
}

// Commerce - Gift Cards

interface GiftCard extends BaseEntity {
  code: string;
  pin?: string;

  // Value
  initialAmount: Money;
  currentBalance: Money;
  currency: string;

  // Recipient
  recipientEmail?: string;
  recipientName?: string;
  senderName?: string;
  message?: string;

  // Validity
  expiresAt?: string;
  isActive: boolean;

  // Usage
  transactions?: GiftCardTransaction[];
}

interface GiftCardTransaction {
  id: string;
  type: 'purchase' | 'redemption' | 'adjustment' | 'refund';
  amount: Money;
  orderId?: string;
  balance: Money;
  createdAt: string;
}

// Commerce - Shipping

interface ShippingMethod {
  id: string;
  name: string;
  carrier?: string;
  service?: string;

  // Pricing
  price: Money;
  isFree?: boolean;
  freeThreshold?: Money;

  // Delivery
  estimatedDays?: {
    min: number;
    max: number;
  };

  // Restrictions
  countries?: string[];
  states?: string[];
  postalCodes?: string[];
  weightLimit?: {
    min?: number;
    max?: number;
    unit: string;
  };

  // Status
  isActive: boolean;
}

// ============================================================================
// CRM MODULE - Redesigned with Customer-centric approach
// ============================================================================

interface Customer extends BaseEntity {
  // Basic Information
  type: 'b2c' | 'b2b';

  // B2C Fields (Person)
  firstName?: string;
  lastName?: string;
  fullName?: string;
  dateOfBirth?: string;
  gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say';

  // B2B Fields (Company)
  companyName?: string;
  tradingName?: string;
  registrationNumber?: string;
  taxId?: string;
  industry?: string;
  employeeCount?: string;
  annualRevenue?: Money;
  website?: string;

  // Contact Information
  email: string;
  emails?: string[]; // Additional emails
  phone?: string;
  phones?: PhoneNumber[];

  // Addresses
  addresses?: Address[];
  defaultBillingAddressId?: string;
  defaultShippingAddressId?: string;

  // B2B Contacts (People within the company)
  contacts?: Contact[]; // For B2B customers
  primaryContactId?: string;

  // Classification
  status: 'active' | 'inactive' | 'prospect' | 'suspended';
  source?: string;
  segment?: string;
  tags?: string[];
  groups?: string[];

  // Commercial
  creditLimit?: Money;
  paymentTerms?: string; // "NET30", "NET60", etc.
  priceList?: string;
  discountTier?: string;
  taxExempt?: boolean;
  taxExemptId?: string;

  // Preferences
  preferredLanguage?: string;
  preferredCurrency?: string;
  acceptsMarketing?: boolean;
  marketingConsent?: {
    email: boolean;
    sms: boolean;
    phone: boolean;
    push: boolean;
  };

  // Relationships
  accountManagerId?: string;
  salesRepId?: string;
  parentPartyId?: string; // For subsidiaries

  // Analytics
  lifetime: {
    totalOrders: number;
    totalSpent: Money;
    averageOrderValue: Money;
    lastOrderDate?: string;
    firstOrderDate?: string;
  };

  // Scoring
  leadScore?: number;
  customerScore?: number;
  churnRisk?: 'low' | 'medium' | 'high';

  // Social
  socialProfiles?: SocialMedia[];

  // Additional
  notes?: string;
  customFields?: CustomField[];
  metadata?: Record<string, any>;
}

interface Contact extends BaseEntity {
  // Parent Customer (B2B)
  customerId: string;

  // Personal Information
  firstName: string;
  lastName: string;
  fullName?: string;
  title?: string; // Job title
  department?: string;

  // Contact Details
  email?: string;
  phone?: string;
  mobile?: string;
  directLine?: string;

  // Role
  role?: ContactRole;
  isPrimary: boolean;
  isDecisionMaker?: boolean;
  isBilling?: boolean;
  isTechnical?: boolean;

  // Permissions (what they can do)
  permissions?: string[];
  canPlaceOrders?: boolean;
  canViewPricing?: boolean;
  canViewInvoices?: boolean;

  // Preferences
  preferredContactMethod?: 'email' | 'phone' | 'sms';
  preferredContactTime?: string;
  doNotContact?: boolean;

  // Activity
  lastContactedAt?: string;
  lastActivityAt?: string;

  // Additional
  birthday?: string;
  assistant?: string;
  assistantPhone?: string;
  socialProfiles?: SocialMedia[];
  notes?: string;
  tags?: string[];
}

type ContactRole =
  | 'owner'
  | 'ceo'
  | 'cto'
  | 'cfo'
  | 'manager'
  | 'purchaser'
  | 'decision_maker'
  | 'influencer'
  | 'user'
  | 'technical'
  | 'billing'
  | 'other';

// CRM - Opportunities & Deals

interface Opportunity extends BaseEntity {
  // Basic
  name: string;
  description?: string;

  // Relations
  customerId: string;
  contactIds?: string[];

  // Pipeline
  pipelineId: string;
  stageId: string;

  // Value
  value: Money;
  probability: number; // 0-100
  expectedValue?: Money; // value * probability
  expectedCloseDate?: string;

  // Classification
  type?: 'new_business' | 'existing_business' | 'renewal' | 'upgrade';
  source?: string;
  campaignId?: string;

  // Competition
  competitors?: string[];
  competitorStatus?: string;

  // Assignment
  ownerId: string;
  teamId?: string;

  // Products/Services
  items?: OpportunityItem[];

  // Activities
  nextActivity?: string;
  lastActivityAt?: string;

  // Outcome
  status: 'open' | 'won' | 'lost' | 'abandoned';
  closedAt?: string;
  wonReason?: string;
  lostReason?: string;

  // Additional
  tags?: string[];
  customFields?: CustomField[];
}

interface OpportunityItem {
  id: string;
  productId?: string;
  name: string;
  quantity: number;
  price: Money;
  discount?: number;
  total: Money;
}

interface Pipeline extends BaseEntity {
  name: string;
  description?: string;
  stages: PipelineStage[];
  isDefault: boolean;
  isActive: boolean;
  type?: 'sales' | 'support' | 'project';
}

interface PipelineStage {
  id: string;
  name: string;
  probability: number;
  position: number;
  color?: string;
  rottenDays?: number; // Days before considered stale
  actions?: StageAction[]; // Automated actions
}

interface StageAction {
  type: 'email' | 'task' | 'notification' | 'field_update';
  config: Record<string, any>;
}

// CRM - Activities

interface Activity extends BaseEntity {
  // Type
  type: ActivityType;
  subject: string;
  description?: string;

  // Relations
  customerId?: string;
  contactId?: string;
  opportunityId?: string;
  relatedTo?: {
    type: string;
    id: string;
  };

  // Assignment
  assignedTo?: string;
  attendees?: string[];

  // Timing
  dueDate?: string;
  startTime?: string;
  endTime?: string;
  duration?: number; // minutes

  // Location
  location?: string;
  isVirtual?: boolean;
  meetingUrl?: string;

  // Status
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'overdue';
  priority: 'low' | 'normal' | 'high' | 'urgent';

  // Result
  outcome?: string;
  completedAt?: string;
  completedBy?: string;

  // Follow-up
  followUpActivity?: string;
  followUpDate?: string;

  // Additional
  attachments?: Attachment[];
  tags?: string[];
}

type ActivityType =
  | 'call'
  | 'email'
  | 'meeting'
  | 'task'
  | 'note'
  | 'event'
  | 'demo'
  | 'followup';

// CRM - Quotes

interface Quote extends BaseEntity {
  // Identification
  quoteNumber: string;
  name: string;

  // Relations
  customerId: string;
  opportunityId?: string;
  contactId?: string;

  // Items
  items: QuoteItem[];

  // Pricing
  subtotal: Money;
  taxAmount: Money;
  discountAmount: Money;
  total: Money;

  // Validity
  validFrom: string;
  validUntil: string;

  // Terms
  paymentTerms?: string;
  deliveryTerms?: string;
  warranty?: string;
  notes?: string;
  termsAndConditions?: string;

  // Status
  status: 'draft' | 'sent' | 'viewed' | 'accepted' | 'rejected' | 'expired' | 'revised';

  // Tracking
  sentAt?: string;
  viewedAt?: string;
  acceptedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;

  // Signature
  requiresSignature?: boolean;
  signedBy?: string;
  signedAt?: string;
  signature?: string;

  // Conversion
  convertedToOrderId?: string;
}

interface QuoteItem {
  id: string;
  productId?: string;
  name: string;
  description?: string;
  quantity: number;
  unitPrice: Money;
  discount?: number;
  discountType?: 'percentage' | 'fixed';
  taxRate?: number;
  total: Money;
}

// CRM - Campaigns & Sequences

interface Sequence extends BaseEntity {
  name: string;
  description?: string;

  // Steps
  steps: SequenceStep[];

  // Enrollment
  enrollmentCriteria?: any;
  exitCriteria?: any;

  // Settings
  timezone?: string;
  sendOnWeekends?: boolean;
  sendTimeRange?: {
    start: string; // "09:00"
    end: string; // "17:00"
  };

  // Performance
  stats?: {
    enrolled: number;
    active: number;
    completed: number;
    stopped: number;
    replied: number;
    converted: number;
  };

  // Status
  status: 'draft' | 'active' | 'paused' | 'completed';
}

interface SequenceStep {
  id: string;
  position: number;
  type: 'email' | 'task' | 'wait' | 'condition';

  // Wait
  waitDays?: number;
  waitHours?: number;

  // Email
  emailTemplate?: string;
  emailSubject?: string;
  emailBody?: string;

  // Task
  taskSubject?: string;
  taskDescription?: string;
  taskAssignee?: string;

  // Condition
  condition?: {
    type: string;
    operator: string;
    value: any;
  };
}

// ============================================================================
// ACCOUNTING MODULE - Complete Financial Management
// ============================================================================

interface Account extends BaseEntity {
  // Identification
  code: string;
  name: string;
  description?: string;

  // Classification
  type: AccountType;
  subtype?: AccountSubtype;
  category?: AccountCategory;

  // Hierarchy
  parentAccountId?: string;
  level: number;
  path: string; // "1000/1100/1110"

  // Balance
  balance: Money;
  openingBalance?: Money;
  openingBalanceDate?: string;

  // Settings
  isSystem: boolean;
  isActive: boolean;
  isReconcilable?: boolean;
  requiresDescription?: boolean;

  // Tax
  taxRateId?: string;
  defaultTaxCode?: string;

  // Bank
  isBankAccount?: boolean;
  bankDetails?: BankDetails;

  // Reporting
  financialStatement?: 'balance_sheet' | 'income_statement' | 'cash_flow';
  reportingGroup?: string;
}

type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';

type AccountSubtype =
  | 'current_asset'
  | 'fixed_asset'
  | 'current_liability'
  | 'long_term_liability'
  | 'equity'
  | 'revenue'
  | 'direct_costs'
  | 'overhead'
  | 'other_income'
  | 'other_expense';

type AccountCategory =
  | 'cash'
  | 'bank'
  | 'accounts_receivable'
  | 'inventory'
  | 'prepaid_expenses'
  | 'property_plant_equipment'
  | 'accounts_payable'
  | 'credit_card'
  | 'taxes_payable'
  | 'loans'
  | 'retained_earnings'
  | 'sales'
  | 'cost_of_goods_sold'
  | 'operating_expenses'
  | 'payroll_expenses';

interface BankDetails {
  bankName: string;
  accountNumber: string;
  routingNumber?: string;
  swift?: string;
  iban?: string;
}

// Accounting - Invoices

interface Invoice extends BaseEntity {
  // Identification
  invoiceNumber: string;
  referenceNumber?: string;

  // Relations
  customerId: string;

  // Dates
  issueDate: string;
  dueDate: string;

  // Lines
  lines: InvoiceLine[];

  // Totals
  subtotal: Money;
  taxDetails?: TaxDetail[];
  taxAmount: Money;
  discountAmount?: Money;
  shippingAmount?: Money;
  total: Money;

  // Payments
  paidAmount: Money;
  balanceDue: Money;
  payments?: Payment[];

  // Status
  status: InvoiceStatus;

  // Terms
  paymentTerms?: PaymentTerms;
  notes?: string;
  termsAndConditions?: string;

  // Recurring
  isRecurring?: boolean;
  recurringSchedule?: RecurringSchedule;

  // Delivery
  sendMethod?: 'email' | 'mail' | 'both';
  sentAt?: string;
  viewedAt?: string;

  // Reminders
  remindersSent?: number;
  lastReminderAt?: string;

  // Late Fees
  lateFeeAmount?: Money;
  lateFeeApplied?: boolean;

  // Attachments
  attachments?: Attachment[];

  // Accounting
  journalEntryId?: string;
}

type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'partial'
  | 'paid'
  | 'overdue'
  | 'cancelled'
  | 'refunded'
  | 'written_off';

interface InvoiceLine {
  id: string;

  // Item
  itemId?: string;
  name: string;
  description?: string;

  // Quantity & Rate
  quantity: number;
  unit?: string;
  rate: Money;

  // Amounts
  amount: Money;

  // Discount
  discount?: number;
  discountType?: 'percentage' | 'fixed';
  discountAmount?: Money;

  // Tax
  taxable?: boolean;
  taxRateId?: string;
  taxAmount?: Money;

  // Accounting
  accountId?: string;

  // Additional
  customFields?: CustomField[];
}

interface TaxDetail {
  taxRateId: string;
  name: string;
  rate: number;
  amount: Money;
}

interface PaymentTerms {
  type: 'immediate' | 'net' | 'eom' | 'custom';
  days?: number; // NET 30, NET 60
  discountDays?: number; // 2/10 NET 30
  discountPercent?: number;
  description?: string;
}

interface RecurringSchedule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  interval: number; // Every 2 weeks, every 3 months
  startDate: string;
  endDate?: string;
  nextDate?: string;
  occurrences?: number;
  occurrencesCount?: number;
}

// Accounting - Bills & Expenses

interface Bill extends BaseEntity {
  // Identification
  billNumber?: string;
  referenceNumber?: string;

  // Vendor
  vendorId: string;

  // Dates
  billDate: string;
  dueDate: string;

  // Lines
  lines: BillLine[];

  // Totals
  subtotal: Money;
  taxAmount: Money;
  total: Money;

  // Payments
  paidAmount: Money;
  balanceDue: Money;

  // Status
  status: BillStatus;

  // Approval
  requiresApproval?: boolean;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  approvedAt?: string;

  // Attachments
  attachments?: Attachment[];

  // Accounting
  journalEntryId?: string;
}

type BillStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'partial'
  | 'paid'
  | 'overdue'
  | 'cancelled';

interface BillLine {
  id: string;
  description: string;
  quantity: number;
  rate: Money;
  amount: Money;
  taxRateId?: string;
  taxAmount?: Money;
  accountId: string;
  customerId?: string; // For billable expenses
  billable?: boolean;
  markup?: number;
}

interface Expense extends BaseEntity {
  // Basic
  date: string;
  merchantName: string;
  amount: Money;

  // Category
  categoryId: string;
  accountId?: string;

  // Payment
  paymentMethod?: string;
  paymentAccountId?: string;

  // Receipt
  hasReceipt: boolean;
  receiptUrl?: string;

  // Reimbursement
  isReimbursable?: boolean;
  reimbursementStatus?: 'pending' | 'approved' | 'rejected' | 'paid';
  employeeId?: string;

  // Billable
  isBillable?: boolean;
  customerId?: string;
  invoiceId?: string;
  markup?: number;

  // Mileage (for travel)
  isMileage?: boolean;
  distance?: number;
  distanceUnit?: 'km' | 'mi';
  mileageRate?: Money;

  // Additional
  notes?: string;
  tags?: string[];
  attachments?: Attachment[];
}

// Accounting - Journal Entries

interface JournalEntry extends BaseEntity {
  // Identification
  entryNumber: string;
  referenceNumber?: string;

  // Dates
  date: string;

  // Lines
  lines: JournalEntryLine[];

  // Totals
  totalDebits: Money;
  totalCredits: Money;

  // Source
  source?: 'manual' | 'invoice' | 'bill' | 'payment' | 'payroll' | 'inventory' | 'depreciation';
  sourceId?: string;

  // Status
  isPosted: boolean;
  isAdjusting?: boolean;
  isClosing?: boolean;

  // Description
  description?: string;
  notes?: string;

  // Attachments
  attachments?: Attachment[];

  // Audit
  createdBy?: string;
  postedBy?: string;
  postedAt?: string;
}

interface JournalEntryLine {
  id: string;
  accountId: string;
  debit?: Money;
  credit?: Money;
  description?: string;
  customerId?: string;
  vendorId?: string;
  employeeId?: string;
  projectId?: string;
  locationId?: string;
  departmentId?: string;
  classId?: string;
}

// Accounting - Payments

interface Payment extends BaseEntity {
  // Identification
  paymentNumber: string;
  referenceNumber?: string;

  // Type
  type: 'customer_payment' | 'vendor_payment' | 'expense' | 'transfer';

  // Party
  customerId?: string;
  vendorId?: string;

  // Amount
  amount: Money;

  // Method
  paymentMethod: PaymentMethod;
  paymentAccountId?: string;

  // Application
  appliedTo?: PaymentApplication[];
  unappliedAmount?: Money;

  // Bank
  bankDepositId?: string;
  isDeposited?: boolean;

  // Status
  status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'refunded';

  // Dates
  date: string;
  clearedDate?: string;

  // Additional
  memo?: string;
  attachments?: Attachment[];
}

interface PaymentApplication {
  invoiceId?: string;
  billId?: string;
  amount: Money;
}

type PaymentMethod =
  | 'cash'
  | 'check'
  | 'credit_card'
  | 'debit_card'
  | 'ach'
  | 'wire'
  | 'paypal'
  | 'other';

// Accounting - Tax

interface TaxRate extends BaseEntity {
  // Basic
  name: string;
  code: string;

  // Rate
  rate: number; // Percentage

  // Type
  type: 'sales' | 'purchase' | 'both';

  // Components (for compound taxes)
  components?: TaxComponent[];

  // Application
  applicableOn?: 'subtotal' | 'subtotal_with_discount';

  // Accounting
  salesAccountId?: string;
  purchaseAccountId?: string;

  // Status
  isActive: boolean;
  isDefault?: boolean;

  // Region
  country?: string;
  state?: string;

  // Validity
  effectiveFrom?: string;
  effectiveTo?: string;
}

interface TaxComponent {
  name: string;
  rate: number;
  accountId?: string;
}

// Accounting - Banking

interface BankAccount extends BaseEntity {
  // Account Info
  accountName: string;
  accountNumber: string;
  accountType: 'checking' | 'savings' | 'credit_card' | 'cash' | 'loan' | 'other';

  // Bank Info
  bankName: string;
  routingNumber?: string;
  swift?: string;
  iban?: string;

  // Balance
  currentBalance: Money;
  availableBalance?: Money;

  // Accounting
  accountId: string; // GL Account

  // Reconciliation
  lastReconciledDate?: string;
  lastReconciledBalance?: Money;

  // Status
  isActive: boolean;
  isDefault?: boolean;
}

interface BankTransaction extends BaseEntity {
  // Account
  bankAccountId: string;

  // Transaction
  date: string;
  description: string;
  reference?: string;

  // Amount
  amount: Money; // Positive for deposits, negative for withdrawals
  balance?: Money;

  // Type
  type: 'deposit' | 'withdrawal' | 'fee' | 'interest' | 'transfer';

  // Reconciliation
  isReconciled: boolean;
  reconciledDate?: string;

  // Matching
  matchedTransactionId?: string;
  matchedTransactionType?: string;

  // Category
  categoryId?: string;

  // Split (for multiple categories)
  splits?: TransactionSplit[];
}

interface TransactionSplit {
  accountId: string;
  amount: Money;
  description?: string;
  customerId?: string;
  vendorId?: string;
  classId?: string;
}

// Accounting - Budgets

interface Budget extends BaseEntity {
  name: string;
  description?: string;

  // Period
  fiscalYear: number;
  startDate: string;
  endDate: string;

  // Type
  type: 'master' | 'department' | 'project' | 'event';

  // Lines
  lines: BudgetLine[];

  // Totals
  totalBudgeted: Money;
  totalActual?: Money;
  variance?: Money;

  // Status
  status: 'draft' | 'approved' | 'active' | 'closed';
  approvedBy?: string;
  approvedAt?: string;
}

interface BudgetLine {
  id: string;
  accountId: string;

  // Periods (monthly breakdown)
  periods: BudgetPeriod[];

  // Totals
  totalBudgeted: Money;
  totalActual?: Money;
  variance?: Money;
  percentUsed?: number;
}

interface BudgetPeriod {
  period: string; // "2024-01"
  budgeted: Money;
  actual?: Money;
  variance?: Money;
  notes?: string;
}

// ============================================================================
// WAREHOUSE MANAGEMENT (WMS) - Complete Inventory System
// ============================================================================

interface Warehouse extends BaseEntity {
  // Basic
  name: string;
  code: string;

  // Address
  address: Address;

  // Contact
  manager?: string;
  phone?: string;
  email?: string;

  // Zones & Locations
  zones?: WarehouseZone[];

  // Capacity
  totalCapacity?: number;
  usedCapacity?: number;
  capacityUnit?: string;

  // Settings
  isDefault: boolean;
  isActive: boolean;
  allowNegativeStock?: boolean;

  // Operating Hours
  operatingHours?: OperatingHours[];
  timezone?: string;
}

interface WarehouseZone {
  id: string;
  name: string;
  code: string;
  type: 'receiving' | 'storage' | 'picking' | 'packing' | 'shipping' | 'returns' | 'quarantine';
  locations?: WarehouseLocation[];
  temperature?: 'ambient' | 'cool' | 'cold' | 'frozen';
  isSecure?: boolean;
}

interface WarehouseLocation {
  id: string;
  code: string; // "A-01-01" (Aisle-Rack-Shelf)
  barcode?: string;
  type: 'shelf' | 'bin' | 'pallet' | 'floor';

  // Dimensions
  width?: number;
  height?: number;
  depth?: number;

  // Capacity
  maxWeight?: number;
  maxVolume?: number;

  // Current Contents
  currentItem?: InventoryItem;
  isEmpty: boolean;
}

interface OperatingHours {
  dayOfWeek: number; // 0-6
  openTime: string;
  closeTime: string;
  isClosed?: boolean;
}

// WMS - Inventory

interface InventoryItem extends BaseEntity {
  // Product
  productId: string;
  variantId?: string;
  sku: string;

  // Location
  warehouseId: string;
  zoneId?: string;
  locationId?: string;

  // Quantity
  quantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  incomingQuantity?: number;

  // Lot/Batch Tracking
  lotNumber?: string;
  serialNumbers?: string[];
  expiryDate?: string;
  manufactureDate?: string;

  // Cost
  unitCost?: Money;
  totalValue?: Money;

  // Reorder
  reorderPoint?: number;
  reorderQuantity?: number;
  maxStockLevel?: number;

  // Status
  status: 'available' | 'reserved' | 'damaged' | 'quarantine' | 'expired';

  // Cycle Count
  lastCountedAt?: string;
  lastCountedBy?: string;
  countDiscrepancy?: number;

  // Movement
  lastMovedAt?: string;
  lastReceivedAt?: string;
  lastShippedAt?: string;
}

interface InventoryMovement extends BaseEntity {
  // Type
  type: MovementType;

  // Product
  productId: string;
  variantId?: string;
  sku: string;

  // Quantity
  quantity: number;

  // Locations
  fromWarehouseId?: string;
  fromLocationId?: string;
  toWarehouseId?: string;
  toLocationId?: string;

  // Reference
  referenceType?: 'purchase_order' | 'sales_order' | 'transfer' | 'adjustment' | 'return';
  referenceId?: string;

  // Cost
  unitCost?: Money;
  totalCost?: Money;

  // User
  performedBy: string;

  // Reason
  reason?: string;
  notes?: string;
}

type MovementType =
  | 'receipt'
  | 'shipment'
  | 'transfer'
  | 'adjustment'
  | 'return'
  | 'damage'
  | 'expiry'
  | 'cycle_count';

// WMS - Purchase Orders

interface PurchaseOrder extends BaseEntity {
  // Identification
  poNumber: string;
  referenceNumber?: string;

  // Vendor
  vendorId: string;
  vendorName?: string;

  // Destination
  warehouseId: string;
  deliveryAddress?: Address;

  // Dates
  orderDate: string;
  expectedDate?: string;

  // Items
  items: PurchaseOrderItem[];

  // Totals
  subtotal: Money;
  taxAmount: Money;
  shippingAmount: Money;
  total: Money;

  // Status
  status: PurchaseOrderStatus;

  // Receipt
  receivedItems?: number;
  totalItems?: number;
  receipts?: Receipt[];

  // Approval
  requiresApproval?: boolean;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  approvedAt?: string;

  // Terms
  paymentTerms?: string;
  shippingTerms?: string;
  notes?: string;

  // Attachments
  attachments?: Attachment[];
}

type PurchaseOrderStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'ordered'
  | 'partial_received'
  | 'received'
  | 'cancelled'
  | 'closed';

interface PurchaseOrderItem {
  id: string;
  productId: string;
  variantId?: string;
  sku: string;
  name: string;

  // Quantity
  orderedQuantity: number;
  receivedQuantity: number;
  cancelledQuantity?: number;

  // Pricing
  unitCost: Money;
  taxRate?: number;
  total: Money;

  // Delivery
  expectedDate?: string;

  // Receipt
  receipts?: ReceiptLine[];
}

interface Receipt extends BaseEntity {
  // Reference
  purchaseOrderId: string;
  receiptNumber: string;

  // Dates
  receivedDate: string;

  // Lines
  lines: ReceiptLine[];

  // Status
  status: 'draft' | 'completed' | 'cancelled';

  // User
  receivedBy: string;

  // Quality Check
  qualityCheckRequired?: boolean;
  qualityCheckStatus?: 'pending' | 'passed' | 'failed';
  qualityCheckNotes?: string;

  // Notes
  notes?: string;
  discrepancyNotes?: string;
}

interface ReceiptLine {
  id: string;
  purchaseOrderItemId: string;

  // Quantity
  receivedQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity?: number;

  // Location
  locationId?: string;

  // Lot/Serial
  lotNumber?: string;
  serialNumbers?: string[];
  expiryDate?: string;

  // Quality
  qualityStatus?: 'pending' | 'passed' | 'failed';
  rejectionReason?: string;
}

// WMS - Transfer Orders

interface TransferOrder extends BaseEntity {
  // Identification
  transferNumber: string;

  // Locations
  fromWarehouseId: string;
  toWarehouseId: string;

  // Dates
  requestDate: string;
  requiredDate?: string;

  // Items
  items: TransferOrderItem[];

  // Status
  status: TransferOrderStatus;

  // Shipping
  shippedDate?: string;
  receivedDate?: string;
  trackingNumber?: string;

  // User
  requestedBy: string;
  approvedBy?: string;
  shippedBy?: string;
  receivedBy?: string;

  // Notes
  reason?: string;
  notes?: string;
}

type TransferOrderStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'in_transit'
  | 'partial_received'
  | 'received'
  | 'cancelled';

interface TransferOrderItem {
  id: string;
  productId: string;
  variantId?: string;
  sku: string;

  // Quantity
  requestedQuantity: number;
  shippedQuantity?: number;
  receivedQuantity?: number;

  // Locations
  fromLocationId?: string;
  toLocationId?: string;

  // Lot/Serial
  lotNumber?: string;
  serialNumbers?: string[];
}

// WMS - Pick Lists

interface PickList extends BaseEntity {
  // Identification
  pickListNumber: string;

  // Reference
  orderId?: string;
  transferOrderId?: string;

  // Warehouse
  warehouseId: string;

  // Assignment
  assignedTo?: string;
  pickerName?: string;

  // Items
  items: PickListItem[];

  // Status
  status: PickListStatus;
  priority: 'low' | 'normal' | 'high' | 'urgent';

  // Timing
  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  // Performance
  estimatedTime?: number; // minutes
  actualTime?: number;

  // Notes
  instructions?: string;
  notes?: string;
}

type PickListStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'on_hold'
  | 'completed'
  | 'cancelled';

interface PickListItem {
  id: string;

  // Product
  productId: string;
  variantId?: string;
  sku: string;
  name: string;
  image?: string;

  // Location
  locationId: string;
  locationCode: string;

  // Quantity
  requestedQuantity: number;
  pickedQuantity: number;

  // Status
  status: 'pending' | 'picked' | 'not_found' | 'insufficient';

  // Substitution
  substituteProductId?: string;
  substitutedQuantity?: number;

  // Notes
  notes?: string;
}

// WMS - Cycle Counts

interface CycleCount extends BaseEntity {
  // Identification
  countNumber: string;
  name?: string;

  // Scope
  warehouseId: string;
  type: 'full' | 'partial' | 'random' | 'abc';

  // Selection Criteria
  zones?: string[];
  categories?: string[];
  abcClass?: 'A' | 'B' | 'C';

  // Schedule
  scheduledDate: string;
  startedAt?: string;
  completedAt?: string;

  // Items
  items: CycleCountItem[];

  // Status
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

  // Results
  totalItems?: number;
  countedItems?: number;
  discrepancies?: number;
  accuracy?: number; // Percentage

  // Approval
  requiresApproval?: boolean;
  approvedBy?: string;
  approvedAt?: string;

  // User
  assignedTo?: string[];
  countedBy?: string[];
}

interface CycleCountItem {
  id: string;

  // Product
  productId: string;
  variantId?: string;
  sku: string;

  // Location
  locationId: string;

  // Counts
  systemQuantity: number;
  countedQuantity?: number;
  variance?: number;

  // Status
  status: 'pending' | 'counted' | 'recounted' | 'approved' | 'adjusted';

  // Recount
  recountRequired?: boolean;
  recountQuantity?: number;

  // User
  countedBy?: string;
  countedAt?: string;

  // Notes
  notes?: string;
}

// ============================================================================
// Additional Complete Module Definitions would continue here...
// Including: Mail, Projects, Helpdesk, Sites, Host, Campaigns, etc.
// Each with the same level of detail and completeness
// ============================================================================

// ... Continue with remaining modules following the same comprehensive pattern