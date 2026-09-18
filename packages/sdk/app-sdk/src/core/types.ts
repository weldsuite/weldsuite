/**
 * Shared types for the WeldSuite app bridge protocol.
 *
 * PROTOCOL SYNC WARNING: the message shapes below (`weldapp:ready`,
 * `weldapp:init`, `weldapp:request`, `weldapp:response`, `weldapp:event`)
 * are implemented by the platform host iframe wrapper. Any change here must
 * be mirrored on the host side in `apps/web/platform` and vice versa.
 */

/** Theme values delivered by the WeldSuite host. */
export type WeldTheme = 'light' | 'dark';

/** Locale code delivered by the host (currently `en` or `nl`). */
export type WeldLocale = string;

/** The workspace member currently viewing the app. */
export interface WeldAppUser {
  id: string;
  name: string;
  imageUrl?: string;
}

/**
 * Token bundle returned by the host on init and on every `getToken` request.
 * `tokenExpiresAt` is an ISO-8601 timestamp; epoch milliseconds are also
 * accepted defensively.
 */
export interface WeldTokenInfo {
  token: string;
  tokenExpiresAt: string | number;
  apiBaseUrl: string;
}

/** Payload of the host's `weldapp:init` handshake reply. */
export interface InitPayload {
  appCode: string;
  theme: WeldTheme;
  locale: WeldLocale;
  apiBaseUrl: string;
  token: string;
  tokenExpiresAt: string | number;
  user: WeldAppUser;
  /**
   * Set by the CLI local shell (`weld app dev`) so the SDK keeps in-memory
   * app-storage while still using the real postMessage bridge for toast /
   * navigate / theme. Production platform hosts never set this.
   */
  localPreview?: boolean;
}

/** Methods the app can invoke on the host. */
export type BridgeRequestMethod = 'getToken' | 'navigate' | 'toast';

/** Push events the host can send to the app. */
export type BridgeEventName = 'theme' | 'locale';

/** App → host: sent once on boot to start the handshake. */
export interface ReadyMessage {
  type: 'weldapp:ready';
}

/** Host → app: handshake reply carrying the full init payload. */
export interface InitMessage {
  type: 'weldapp:init';
  payload: InitPayload;
}

/** App → host: correlated request. */
export interface RequestMessage {
  type: 'weldapp:request';
  id: string;
  method: BridgeRequestMethod;
  payload?: unknown;
}

/** Host → app: correlated response. */
export interface ResponseMessage {
  type: 'weldapp:response';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message: string };
}

/** Host → app: push event (theme / locale changes). */
export interface EventMessage {
  type: 'weldapp:event';
  event: BridgeEventName;
  payload: { value: string };
}

export type HostMessage = InitMessage | ResponseMessage | EventMessage;
export type AppMessage = ReadyMessage | RequestMessage;

/** Toast variants supported by the host shell. */
export type ToastVariant = 'default' | 'success' | 'error' | 'warning';

// ---------------------------------------------------------------------------
// external-api response envelopes
// ---------------------------------------------------------------------------

/** `{ data: T }` — single-resource envelope. */
export interface SingleResponse<T> {
  data: T;
}

export interface ListPagination {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

/** `{ data: T[], pagination }` — list envelope with cursor pagination. */
export interface ListResponse<T> {
  data: T[];
  pagination: ListPagination;
}

/** A stored app-storage record. The document itself lives under `data`. */
export interface AppRecord<T = Record<string, unknown>> {
  id: string;
  data: T;
  createdAt?: string;
  updatedAt?: string;
}

/** Options for listing app-storage records. */
export interface RecordListOptions {
  limit?: number;
  cursor?: string;
  /** jsonb containment filter, e.g. `{ status: 'open' }`. Serialized as a JSON query param. */
  filter?: Record<string, unknown>;
}

/** Typed accessor for one app-storage collection. */
export interface RecordsClient<T extends Record<string, unknown> = Record<string, unknown>> {
  list(options?: RecordListOptions): Promise<ListResponse<AppRecord<T>>>;
  create(data: T): Promise<AppRecord<T>>;
  get(id: string): Promise<AppRecord<T>>;
  /** PATCH semantics on the API replace the whole document with `data`. */
  update(id: string, data: T): Promise<AppRecord<T>>;
  remove(id: string): Promise<void>;
}

/** Key-value store accessor. */
export interface KvClient {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Subset of a `/v1/people` row the scaffolded apps typically display. */
export interface PersonSummary {
  id: string;
  displayName?: string | null;
  fullName?: string | null;
  email?: string | null;
}

/** Subset of a `/v1/tickets` row. */
export interface TicketSummary {
  id: string;
  subject?: string | null;
  status?: string | null;
}

export interface ResourceListOptions {
  limit?: number;
  cursor?: string;
  search?: string;
}

export interface PeopleClient {
  list(options?: ResourceListOptions): Promise<ListResponse<PersonSummary>>;
  get(id: string): Promise<SingleResponse<PersonSummary>>;
}

export interface TicketsClient {
  list(options?: ResourceListOptions): Promise<ListResponse<TicketSummary>>;
  get(id: string): Promise<SingleResponse<TicketSummary>>;
}
