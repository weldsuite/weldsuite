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

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
  filters?: Record<string, unknown>;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext?: boolean;
  hasPrev?: boolean;
}

export interface PaginatedResponse<T = unknown> {
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
  metadata?: Record<string, unknown>;
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
