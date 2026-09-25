/**
 * Shared types for the WeldSuite app bridge protocol.
 *
 * PROTOCOL SYNC WARNING: the message shapes below (`weldapp:ready`,
 * `weldapp:init`, `weldapp:request`, `weldapp:response`, `weldapp:event`,
 * `weldapp:notify`) are implemented by the platform host
 * (`apps/web/platform/app/weldapps/host/`) and the CLI local shell
 * (`packages/sdk/cli/src/local-shell/`). Any change here must be mirrored on
 * both host sides and vice versa.
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
 * Token bundle returned by the host on a legacy `getToken` request.
 * `tokenExpiresAt` is an ISO-8601 timestamp; epoch milliseconds are also
 * accepted defensively.
 *
 * Protocol 2 hosts never put a token in the iframe: API requests are proxied
 * through the host (see {@link BridgeFetchRequest}).
 */
export interface WeldTokenInfo {
  token: string;
  tokenExpiresAt: string | number;
  apiBaseUrl: string;
}

/** Where this app instance is rendered by the host. */
export type WeldSurface = 'page' | 'modal';

/**
 * Platform design tokens pushed by the host so apps render with the exact
 * suite palette, radius and font instead of a copied approximation.
 */
export interface WeldDesignTokens {
  /** Suite token values keyed by name without the `--wui-` prefix (`primary`, `radius`, …). */
  vars: Record<string, string>;
  /** CSS `font-family` of the platform body text. */
  fontFamily?: string;
  /** Stylesheet URL that loads {@link fontFamily} (Google Fonts only). */
  fontStylesheet?: string;
}

/** Payload of the host's `weldapp:init` handshake reply. */
export interface InitPayload {
  appCode: string;
  theme: WeldTheme;
  locale: WeldLocale;
  apiBaseUrl: string;
  /**
   * Legacy (protocol 1) hosts put a workspace-scoped token here. Protocol 2
   * hosts send `null` and proxy API requests instead, so no credential ever
   * enters the sandbox.
   */
  token: string | null;
  tokenExpiresAt: string | number | null;
  user: WeldAppUser;
  /**
   * App-relative path from the platform URL (`/` or `/products`), derived from
   * `/apps/{code}{path}`. Apps use this (and `route` events) instead of building
   * their own sidebar.
   */
  path?: string;
  /**
   * Set by the CLI local shell (`weld app dev`) so the SDK keeps in-memory
   * app-storage while still using the real postMessage bridge for toast /
   * navigate / theme. Production platform hosts never set this.
   */
  localPreview?: boolean;
  /** Bridge protocol spoken by the host. Absent means 1 (token in init). */
  protocol?: number;
  /** Platform design tokens (protocol 2). Updated via `designTokens` events. */
  designTokens?: WeldDesignTokens;
  /** Where the host renders this instance. Absent means `page`. */
  surface?: WeldSurface;
  /** Set when {@link surface} is `modal`: what the opener passed to `openModal`. */
  modal?: { title?: string; params?: unknown };
}

/** Methods the app can invoke on the host. */
export type BridgeRequestMethod =
  | 'getToken'
  | 'navigate'
  | 'toast'
  | 'fetch'
  | 'setBreadcrumbs'
  | 'setDirty'
  | 'confirm'
  | 'openModal'
  | 'closeModal';

/** Push events apps can subscribe to with `bridge.on()`. */
export type BridgeEventName = 'theme' | 'locale' | 'route';

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

/** Host → app: push event (theme / locale / route / design tokens). */
export type EventMessage =
  | {
      type: 'weldapp:event';
      event: BridgeEventName;
      payload: { value: string };
    }
  | {
      type: 'weldapp:event';
      event: 'designTokens';
      payload: { value: WeldDesignTokens };
    };

/** Global shortcut the SDK hands to the host (e.g. Cmd/Ctrl+K). */
export interface ShortcutPayload {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** App → host: fire-and-forget notification (no response). */
export type NotifyMessage =
  | { type: 'weldapp:notify'; event: 'mounted' }
  | { type: 'weldapp:notify'; event: 'shortcut'; payload: ShortcutPayload };

export type HostMessage = InitMessage | ResponseMessage | EventMessage;
export type AppMessage = ReadyMessage | RequestMessage | NotifyMessage;

/**
 * `fetch` request payload: the host performs the call with the member's
 * platform session and returns the response. `path` is relative to the API
 * the app targets (`/v1/...` for community apps).
 */
export interface BridgeFetchRequest {
  method: string;
  path: string;
  headers: [string, string][];
  body: string | ArrayBuffer | null;
}

/** `fetch` response payload. */
export interface BridgeFetchResponse {
  status: number;
  statusText?: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

/** One app-level breadcrumb; `path` is app-relative (`/orders/42`). */
export interface WeldBreadcrumb {
  label: string;
  path?: string;
}

/** Options for a host-rendered confirmation dialog. */
export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  destructive?: boolean;
}

/** Options for a host-rendered modal showing another route of this app. */
export interface OpenModalOptions {
  /** App-relative route rendered inside the modal. */
  path: string;
  title?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Structured-cloneable data handed to the modal instance as `init.modal.params`. */
  params?: unknown;
}

/** How a modal opened with `openModal` ended. */
export interface ModalResult<T = unknown> {
  /** True when the user closed it (Escape, backdrop, close button). */
  dismissed: boolean;
  /** Value the modal passed to `closeModal(result)`. */
  result?: T;
}

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

/** Subset of a `/v1/products` row used by commerce WeldApps. */
export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  sku?: string | null;
  status?: string | null;
  price?: string | number | null;
  currency?: string | null;
  imageUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Create body for `/v1/products` (name + slug required). */
export interface CreateProductInput {
  name: string;
  slug: string;
  description?: string;
  sku?: string;
  status?: string;
  price?: string | number;
  currency?: string;
  imageUrl?: string;
  [key: string]: unknown;
}

export type UpdateProductInput = Partial<CreateProductInput>;

export interface ProductListOptions extends ResourceListOptions {
  /** Filter by product status (e.g. `active`, `draft`). */
  status?: string;
}

export interface ProductsClient {
  list(options?: ProductListOptions): Promise<ListResponse<ProductSummary>>;
  get(id: string): Promise<SingleResponse<ProductSummary>>;
  create(input: CreateProductInput): Promise<ProductSummary>;
  update(id: string, input: UpdateProductInput): Promise<ProductSummary>;
  remove(id: string): Promise<void>;
}
