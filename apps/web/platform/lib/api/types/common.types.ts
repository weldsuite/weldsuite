/**
 * Common Types
 * Shared across all applications
 */

// ============================================================================
// Base Types
// ============================================================================

export interface BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  updatedBy?: string;
  version?: number;
  isDeleted?: boolean;
  deletedAt?: Date;
  deletedBy?: string;
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
  latitude?: number;
  longitude?: number;
}

export interface Money {
  amount: number;
  currency: string;
  formatted?: string;
}

export interface DateRange {
  start: Date;
  end: Date;
}

interface TimeRange {
  start: string; // "HH:mm"
  end: string;   // "HH:mm"
}

interface ContactInfo {
  name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
}

export interface Attachment {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  url: string;
  uploadedAt: Date;
  uploadedBy?: string;
}

// ============================================================================
// API Types
// ============================================================================

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: ApiError;
  message?: string;
  timestamp?: Date;
  requestId?: string;
}

interface ApiError {
  code: string;
  message: string;
  details?: any;
  field?: string;
  timestamp?: Date;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
  filters?: Record<string, any>;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext?: boolean;
  hasPrev?: boolean;
}

export interface PaginatedResponse<T = any> {
  items: T[];
  meta: PaginationMeta;
}

// ============================================================================
// User & Auth Types
// ============================================================================

export interface User extends BaseEntity {
  email: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  avatar?: string;
  phone?: string;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  twoFactorEnabled?: boolean;
  lastLoginAt?: Date;
  preferences?: UserPreferences;
  metadata?: Record<string, any>;
}

interface UserPreferences {
  language?: string;
  timezone?: string;
  dateFormat?: string;
  currency?: string;
  theme?: 'light' | 'dark' | 'system';
  notifications?: NotificationPreferences;
}

interface NotificationPreferences {
  email?: boolean;
  push?: boolean;
  sms?: boolean;
  desktop?: boolean;
}

type UserRole = 'admin' | 'manager' | 'user' | 'viewer' | 'guest';
type UserStatus = 'active' | 'inactive' | 'suspended' | 'pending';

interface AuthSession {
  user: User;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  workspaceId?: string;
}

interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
  tokenType: string;
}

// ============================================================================
// Workspace Types
// ============================================================================

export interface Workspace extends BaseEntity {
  name: string;
  slug: string;
  description?: string;
  logo?: string;
  ownerId: string;
  plan?: 'free' | 'business' | 'scale' | 'enterprise';
  status: 'active' | 'suspended' | 'cancelled';
  settings?: WorkspaceSettings;
  limits?: WorkspaceLimits;
  memberCount?: number;
}

interface WorkspaceSettings {
  defaultCurrency?: string;
  defaultLanguage?: string;
  timezone?: string;
  dateFormat?: string;
  fiscalYearStart?: number; // month
  weekStart?: number; // 0 = Sunday, 1 = Monday
}

interface WorkspaceLimits {
  maxUsers?: number;
  maxStorage?: number; // bytes
  maxProjects?: number;
  maxTransactions?: number;
}

interface WorkspaceMember extends BaseEntity {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  permissions?: string[];
  joinedAt: Date;
  invitedBy?: string;
  status: 'active' | 'invited' | 'suspended';
}

type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';

// ============================================================================
// Audit Types
// ============================================================================

interface AuditLog extends BaseEntity {
  entityType: string;
  entityId: string;
  action: AuditAction;
  userId: string;
  userName?: string;
  workspaceId?: string;
  changes?: AuditChange[];
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

interface AuditChange {
  field: string;
  oldValue: any;
  newValue: any;
}

type AuditAction = 'create' | 'update' | 'delete' | 'view' | 'export' | 'import' | 'login' | 'logout';

// ============================================================================
// Notification Types
// ============================================================================

interface Notification extends BaseEntity {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: any;
  read: boolean;
  readAt?: Date;
  actionUrl?: string;
  priority?: 'high' | 'medium' | 'low';
  expiresAt?: Date;
}

type NotificationType =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'task'
  | 'reminder'
  | 'mention'
  | 'comment'
  | 'approval'
  | 'system';

// ============================================================================
// File & Media Types
// ============================================================================

export interface File extends BaseEntity {
  name: string;
  path: string;
  url?: string;
  mimeType: string;
  size: number;
  storage?: 'local' | 's3' | 'gcs' | 'azure';
  bucket?: string;
  metadata?: FileMetadata;
  thumbnailUrl?: string;
  isPublic?: boolean;
}

interface FileMetadata {
  width?: number;
  height?: number;
  duration?: number;
  format?: string;
  encoding?: string;
  checksum?: string;
}

// ============================================================================
// Search & Filter Types
// ============================================================================

interface SearchParams {
  query: string;
  fields?: string[];
  fuzzy?: boolean;
  highlight?: boolean;
  limit?: number;
  offset?: number;
}

interface FilterOperator {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'like' | 'between' | 'exists';
  value: any;
}

interface SortOption {
  field: string;
  order: 'asc' | 'desc';
}

// ============================================================================
// Analytics Types
// ============================================================================

interface Metric {
  name: string;
  value: number;
  unit?: string;
  change?: number;
  changeType?: 'increase' | 'decrease' | 'stable';
  period?: DateRange;
}

interface ChartData {
  labels: string[];
  datasets: ChartDataset[];
}

interface ChartDataset {
  label: string;
  data: number[];
  color?: string;
  backgroundColor?: string;
}

// ============================================================================
// Settings Types
// ============================================================================

interface Setting extends BaseEntity {
  key: string;
  value: any;
  type: 'string' | 'number' | 'boolean' | 'json' | 'array';
  category?: string;
  description?: string;
  isPublic?: boolean;
  isEditable?: boolean;
  validation?: any;
}

// ============================================================================
// Export Types
// ============================================================================

interface ExportRequest {
  format: 'csv' | 'xlsx' | 'pdf' | 'json';
  fields?: string[];
  filters?: FilterOperator[];
  sort?: SortOption[];
  dateRange?: DateRange;
}

interface ExportJob extends BaseEntity {
  type: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  fileUrl?: string;
  error?: string;
  completedAt?: Date;
  expiresAt?: Date;
}