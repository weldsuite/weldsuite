/**
 * Shared types for WeldSuite mobile apps
 */

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string | { title: string; message: string; details?: unknown };
  message?: string;
}

export interface PaginatedResponse<T> {
  data?: T[];
  items?: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages?: number;
    hasNext?: boolean;
    hasPrev?: boolean;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
}

export interface InstalledApp {
  id: string;
  workspaceId: string;
  appCode: string;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
  status: string;
  displayOrder: number;
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  email?: string;
  picture?: string;
  role: string;
  status?: string;
  joinedAt?: string;
}

export interface Workspace {
  id: string;
  clerkOrgId: string;
  name: string;
  slug: string;
  imageUrl?: string | null;
  planId?: string | null;
  isActive: boolean;
  createdAt?: string;
}

export interface WorkspaceWithMembership extends Workspace {
  role: string;
  membershipStatus: string;
}

export interface ModuleChannelPreferences {
  enabled: boolean;
  inApp: boolean;
  email: boolean;
  push: boolean;
  desktop: boolean;
}

export interface ModulePreferencesMap {
  helpdesk?: ModuleChannelPreferences;
  crm?: ModuleChannelPreferences;
  wms?: ModuleChannelPreferences;
  commerce?: ModuleChannelPreferences;
  mail?: ModuleChannelPreferences;
  projects?: ModuleChannelPreferences;
  parcel?: ModuleChannelPreferences;
  task?: ModuleChannelPreferences;
}

export interface NotificationPreferences {
  id?: string;
  userId?: string;
  workspaceId?: string;
  doNotDisturb: boolean;
  soundEnabled: boolean;
  modulePreferences: ModulePreferencesMap;
  defaultInApp: boolean;
  defaultEmail: boolean;
  defaultPush: boolean;
  defaultDesktop: boolean;
  createdAt?: string;
  updatedAt?: string;
}
