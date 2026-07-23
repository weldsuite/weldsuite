/**
 * Internal types for the realtime worker.
 * Client-facing protocol types are in @weldsuite/realtime/types.
 */

export interface Env {
  WORKSPACE_HUB: DurableObjectNamespace;
  CONVERSATION_ROOM: DurableObjectNamespace;
  CHAT_ROOM: DurableObjectNamespace;
  WHITEBOARD_ROOM: DurableObjectNamespace;
  DOCUMENT_ROOM: DurableObjectNamespace;
  SUPPORT_ROOM: DurableObjectNamespace;
  CLERK_JWT_KEY: string;
  CLERK_ISSUER: string;
  /** Admin Clerk JWT public key (PEM) — for verifying admin app tokens */
  ADMIN_CLERK_JWT_KEY?: string;
  WIDGET_TOKEN_SECRET: string;
  /** Master DB connection string (Neon). Required for persisting presence
   *  offline from the WorkspaceHub alarm. */
  DATABASE_URL_MASTER?: string;
  /** Neon API key — used to resolve tenant DB URLs on cache miss. */
  NEON_API_KEY?: string;
  /** Optional AES-256-GCM key for decrypting stored tenant DB URIs. */
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  /** Shared KV namespace for workspace URL caching (same binding as api-worker). */
  WORKSPACE_CACHE?: KVNamespace;
  /** Shared secret for authenticating /publish/* calls from non-binding callers (e.g. the admin Next.js app on Vercel). */
  REALTIME_INTERNAL_SECRET?: string;
}

export interface AuthInfo {
  userId: string;
  userName: string;
  workspaceId: string;
  role: string;
  type: 'agent' | 'customer';
  /** For customers: the specific conversation they can access */
  conversationId?: string;
  /** For customers: the widget ID */
  widgetId?: string;
}

export interface WorkspacePermissions {
  /** Topic patterns the user can subscribe to. '*' means all. */
  subscribe: string[];
}

export interface RoomPermissions {
  canPublish: boolean;
  role: string;
}

/** Publish request body from workers via service binding */
export interface WorkspacePublishRequest {
  workspaceId: string;
  topic: string;
  event: string;
  data: unknown;
  userId: string;
}

/** Headers used to pass auth info from the Worker to DOs */
export const AUTH_HEADERS = {
  USER_ID: 'x-rt-user-id',
  USER_NAME: 'x-rt-user-name',
  ROLE: 'x-rt-role',
  TYPE: 'x-rt-type',
  CAN_PUBLISH: 'x-rt-can-publish',
  SUBSCRIBE_TOPICS: 'x-rt-subscribe-topics',
  WORKSPACE_ID: 'x-rt-workspace-id',
} as const;
