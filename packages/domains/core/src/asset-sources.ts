/**
 * Asset sources: importing managed devices from Microsoft Intune into the
 * asset register (the ready-made `asset` custom object, ADR DESK-016).
 *
 * The customer connects their own Entra app registration (tenant id, client id,
 * client secret; application permission `DeviceManagementManagedDevices.Read.All`
 * with admin consent), so there is no WeldSuite-wide Microsoft app. app-api
 * manages the sources (`/api/asset-sources`); desk-api's minute cron runs the
 * imports (`runAssetImportStep`), found through the due index (kind
 * `asset_import`), so a workspace without a source is never opened.
 *
 * An import is a run in bounded steps. A step gets a token, reads ONE Graph
 * page, loads that page's mappings in one query and writes at most
 * `ASSET_IMPORT_MAX_WRITES` records; then it saves where it stopped in
 * `asset_sources.sync_state` and the next tick continues. The tenant DB is
 * Neon HTTP, where every query is a subrequest, so a step has to stay small.
 * Resuming is safe: a device that was already written has its mapping and
 * checksum, so a repeated device counts as unchanged.
 *
 * One step at a time: a step takes a lease on the run (`leaseUntil` in the
 * sync state, a compare-and-set) before it does anything, and gives it up with
 * its last write. A tick that finds the run leased does nothing; a step that
 * died leaves the lease to expire (`ASSET_IMPORT_STEP_LEASE_MS`).
 *
 * The last check-in is not part of the checksum: devices check in several
 * times a day, and a record write (its queries, its `updated` event) per
 * device per run is more than a larger fleet's import can do. A step keeps the
 * check-in of the devices it leaves unwritten current with one statement on
 * the field's value column instead: no record write, no event.
 *
 * Matching: a device maps to its record through `integration_entity_mappings`
 * (connection = the source, external type `intune_device`, external id = the
 * managedDevice id, internal type = the object's entity key). No mapping: a
 * record with the same serial number that this source has not mapped yet is
 * adopted, otherwise a record is created. Devices that disappear from Intune
 * are left alone.
 *
 * Field ownership: device facts (name, serial number, manufacturer, model, OS,
 * compliance, last check-in, primary user, Intune id) are written on every
 * change (a newer check-in alone is not one, see above); `asset_type`,
 * `status` and the `owner` link only when the record is created, so a
 * person's corrections are never overwritten. A fact the device does not
 * report is not written (it never clears a value a person entered).
 *
 * Only `login.microsoftonline.com` and `graph.microsoft.com` are ever called.
 * The client secret never reaches a log, an error or a result.
 */

import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  assetSources,
  customFieldDefinitions,
  customFieldValues,
  customObjectLinks,
  customObjectRecords,
  customObjectRelations,
  integrationEntityMappings,
  people,
} from '@weldsuite/db/schema';
import type {
  AssetSource,
  AssetSourceRunStats,
  AssetSourceSyncState,
  IntuneAssetSourceConfig,
} from '@weldsuite/db/schema';
import type { TenantDb } from '@weldsuite/db/lib/any-db';
import type { IdGenerator } from '@weldsuite/db/lib/mail-contacts';
import { decryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import {
  createRecord,
  getCustomObjectBySlug,
  updateRecord,
  type CustomObjectRow,
} from '@weldsuite/db/lib/custom-objects';
import { generateId as defaultGenerateId } from '@weldsuite/worker-kit/id';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';

// ============================================================================
// Constants
// ============================================================================

export const ASSET_OBJECT_SLUG = 'asset';
/** `external_entity_type` of an Intune device in `integration_entity_mappings`. */
export const INTUNE_DEVICE_ENTITY_TYPE = 'intune_device';
/**
 * Record writes (creates and updates) in one step. Reading and skipping
 * unchanged devices is free. A write is about fifteen queries, and the step
 * shares its cron invocation, and that invocation's subrequest limit, with the
 * SLA and report sweeps: twenty writes leave them most of it.
 */
export const ASSET_IMPORT_MAX_WRITES = 20;
/** A run that has not finished after this long is stopped. */
export const ASSET_IMPORT_MAX_RUN_MS = 24 * 60 * 60_000;
/**
 * How long a step holds the run. Well over what a step takes (two calls to
 * Microsoft and twenty record writes), short enough that a step that died does
 * not hold the import up for long.
 */
export const ASSET_IMPORT_STEP_LEASE_MS = 5 * 60_000;
export const ASSET_IMPORT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;

export const INTUNE_TOKEN_HOST = 'login.microsoftonline.com';
export const INTUNE_GRAPH_HOST = 'graph.microsoft.com';
export const INTUNE_DEVICES_URL = `https://${INTUNE_GRAPH_HOST}/v1.0/deviceManagement/managedDevices`;

// ============================================================================
// Errors
// ============================================================================

export const ASSET_SOURCE_ERROR_CODES = [
  'invalid_secret',
  'secret_expired',
  'tenant_not_found',
  'app_not_found',
  'permission_missing',
  'throttled',
  'unreachable',
  'sign_in_failed',
  'asset_register_missing',
] as const;
export type AssetSourceErrorCode = (typeof ASSET_SOURCE_ERROR_CODES)[number];

export const ASSET_SOURCE_ERROR_MESSAGES: Record<AssetSourceErrorCode, string> = {
  invalid_secret:
    'Microsoft rejected the client secret. Check that you copied the secret Value, not the Secret ID.',
  secret_expired: 'The client secret has expired. Create a new one in the Entra admin center and replace it here.',
  tenant_not_found: 'Microsoft could not find this tenant. Check the Directory (tenant) ID.',
  app_not_found:
    'The application was not found in this tenant. Check the Application (client) ID and that the app registration is in this directory.',
  permission_missing:
    'Microsoft refused access to the devices. Add the DeviceManagementManagedDevices.Read.All application permission, grant admin consent, and make sure the tenant has an Intune licence.',
  throttled: 'Microsoft asked us to slow down. The import continues shortly.',
  unreachable: 'Microsoft could not be reached. The import tries again on its next run.',
  sign_in_failed: 'Microsoft did not accept the sign-in. Check the tenant id, the client id and the client secret.',
  asset_register_missing: 'The asset register is not set up. Set it up before importing devices.',
};

export class AssetSourceError extends Error {
  readonly code: AssetSourceErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: AssetSourceErrorCode, message?: string, retryAfterSeconds?: number) {
    super(message ?? ASSET_SOURCE_ERROR_MESSAGES[code]);
    this.name = 'AssetSourceError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function toAssetSourceError(err: unknown): AssetSourceError {
  if (err instanceof AssetSourceError) return err;
  return new AssetSourceError('unreachable');
}

/** `lastError` is stored as `<code>: <message>`; the code lets the UI show its own wording. */
export function formatAssetSourceError(err: AssetSourceError): string {
  return `${err.code}: ${err.message}`;
}

export function parseAssetSourceError(stored: string | null): { code: AssetSourceErrorCode | null; message: string | null } {
  if (!stored) return { code: null, message: null };
  const sep = stored.indexOf(': ');
  const code = sep > 0 ? stored.slice(0, sep) : '';
  if ((ASSET_SOURCE_ERROR_CODES as readonly string[]).includes(code)) {
    return { code: code as AssetSourceErrorCode, message: stored.slice(sep + 2) };
  }
  return { code: null, message: stored };
}

// ============================================================================
// Validation of what goes into a URL
// ============================================================================

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** An Entra tenant is a GUID or a verified domain name; nothing else may reach the token URL. */
export function isValidEntraTenantId(value: string): boolean {
  return GUID.test(value) || HOSTNAME.test(value);
}

/** Only Graph itself, over https, without credentials or a port: the `@odata.nextLink` of a page. */
export function isGraphUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === INTUNE_GRAPH_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

// ============================================================================
// Microsoft: token and devices
// ============================================================================

export type FetchLike = typeof fetch;

function retryAfterOf(response: Response): number {
  const raw = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(raw, MAX_RETRY_AFTER_SECONDS);
}

async function jsonOf(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Error code of a token refusal: Microsoft's `error_codes` decide, never the free text. */
function tokenErrorCode(body: Record<string, unknown> | null): AssetSourceErrorCode {
  const codes = Array.isArray(body?.error_codes) ? (body.error_codes as unknown[]).map(Number) : [];
  if (codes.includes(7000222)) return 'secret_expired';
  if (codes.includes(7000215) || codes.includes(7000218)) return 'invalid_secret';
  if (codes.includes(90002)) return 'tenant_not_found';
  if (codes.includes(700016)) return 'app_not_found';
  return 'sign_in_failed';
}

async function request(url: string, init: RequestInit, fetcher: FetchLike): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      // A redirect would carry the token to another host.
      redirect: 'manual',
      signal: AbortSignal.timeout(ASSET_IMPORT_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AssetSourceError('unreachable');
  }
}

/** Client-credentials token for Microsoft Graph. */
export async function intuneToken(
  config: IntuneAssetSourceConfig,
  secret: string,
  fetcher: FetchLike = fetch,
): Promise<string> {
  if (!isValidEntraTenantId(config.tenantId)) throw new AssetSourceError('tenant_not_found');
  const response = await request(
    `https://${INTUNE_TOKEN_HOST}/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: secret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }).toString(),
    },
    fetcher,
  );

  if (response.status === 429 || response.status === 503) {
    throw new AssetSourceError('throttled', undefined, retryAfterOf(response));
  }
  if (!response.ok) {
    if (response.status >= 500) throw new AssetSourceError('unreachable');
    throw new AssetSourceError(tokenErrorCode(await jsonOf(response)));
  }
  const body = await jsonOf(response);
  const token = body?.access_token;
  if (typeof token !== 'string' || token === '') throw new AssetSourceError('sign_in_failed');
  return token;
}

export type IntuneDevice = Record<string, unknown>;

export interface IntunePage {
  devices: IntuneDevice[];
  /** The `@odata.nextLink`, verbatim; null on the last page. */
  nextLink: string | null;
}

/** One page of managed devices: the first when `link` is null, otherwise the link a page gave. */
export async function fetchIntunePage(
  token: string,
  link: string | null,
  fetcher: FetchLike = fetch,
): Promise<IntunePage> {
  const url = link ?? INTUNE_DEVICES_URL;
  if (!isGraphUrl(url)) throw new AssetSourceError('unreachable', 'Microsoft sent a link to another host; the import was stopped.');

  const response = await request(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, fetcher);
  if (response.status === 429 || response.status === 503) {
    throw new AssetSourceError('throttled', undefined, retryAfterOf(response));
  }
  if (response.status === 401 || response.status === 403) throw new AssetSourceError('permission_missing');
  if (!response.ok) throw new AssetSourceError('unreachable');

  const body = await jsonOf(response);
  const value = body?.value;
  if (!Array.isArray(value)) throw new AssetSourceError('unreachable');
  // An entry that is not an object becomes a device without an id: it counts
  // as failed, in its place on the page, instead of stopping the whole import.
  const devices = value.map((entry): IntuneDevice =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as IntuneDevice) : {},
  );
  const next = body?.['@odata.nextLink'];
  if (typeof next === 'string' && next !== '') {
    if (!isGraphUrl(next)) throw new AssetSourceError('unreachable', 'Microsoft sent a link to another host; the import was stopped.');
    return { devices, nextLink: next };
  }
  return { devices, nextLink: null };
}

export type AssetSourceTestResult =
  | { ok: true; deviceCount: number }
  | { ok: false; code: AssetSourceErrorCode; message: string };

/** Token plus the first page; saves nothing and never throws. `deviceCount` is that page's, not the total. */
export async function testAssetSource(
  config: IntuneAssetSourceConfig,
  secret: string,
  fetcher: FetchLike = fetch,
): Promise<AssetSourceTestResult> {
  try {
    const token = await intuneToken(config, secret, fetcher);
    const page = await fetchIntunePage(token, null, fetcher);
    return { ok: true, deviceCount: page.devices.length };
  } catch (err) {
    const failure = toAssetSourceError(err);
    return { ok: false, code: failure.code, message: failure.message };
  }
}

// ============================================================================
// Mapping a device to asset fields
// ============================================================================

export const COMPLIANCE_OPTIONS = [
  { value: 'compliant', label: 'Compliant' },
  { value: 'noncompliant', label: 'Non-compliant' },
  { value: 'in_grace_period', label: 'In grace period' },
  { value: 'conflict', label: 'Conflict' },
  { value: 'error', label: 'Error' },
  { value: 'config_manager', label: 'Managed by Configuration Manager' },
  { value: 'unknown', label: 'Unknown' },
];

const COMPLIANCE_BY_STATE: Record<string, string> = {
  compliant: 'compliant',
  noncompliant: 'noncompliant',
  ingraceperiod: 'in_grace_period',
  conflict: 'conflict',
  error: 'error',
  configmanager: 'config_manager',
};

export function mapCompliance(state: unknown): string {
  return COMPLIANCE_BY_STATE[String(state ?? '').toLowerCase()] ?? 'unknown';
}

// The names a desktop model goes by, in two expressions: the plain words, and the ones that need a look around them.
const DESKTOP_WORD = /imac|optiplex|thinkcentre|prodesk|elitedesk|desktop|tower/i;
const DESKTOP_MAC_OR_NUC = /mac ?mini|mac ?studio|mac ?pro(?![a-z])|\bnuc(?![a-z])/i;

function isDesktopModel(model: string): boolean {
  return DESKTOP_WORD.test(model) || DESKTOP_MAC_OR_NUC.test(model);
}

/** Asset type of a new record, from the operating system and the model. */
export function assetTypeFor(operatingSystem: string | null, model: string | null): string {
  const os = (operatingSystem ?? '').toLowerCase();
  const hardware = model ?? '';
  if (os.includes('android')) return 'phone';
  if (os.includes('ipados') || /(^|[^a-z])ios([^a-z]|$)/.test(os)) {
    return hardware.trim().toLowerCase().startsWith('ipad') ? 'tablet' : 'phone';
  }
  if (os.includes('windows') || os.includes('macos') || os.includes('mac os') || os.includes('linux')) {
    return isDesktopModel(hardware) ? 'desktop' : 'laptop';
  }
  return 'other';
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Graph reports "never" as 0001-01-01; anything before 1970 is not a check-in. */
function checkIn(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || time < 0) return null;
  return new Date(time).toISOString();
}

export interface MappedDevice {
  /** The managedDevice id. */
  externalId: string;
  serialNumber: string | null;
  /** Email the owner is looked up by (`emailAddress`, else `userPrincipalName`). */
  userEmail: string | null;
  /** Every device fact by field slug; null where the device reports nothing. */
  values: Record<string, string | null>;
  /** The record's own data on creation only. */
  createdOnly: { asset_type: string; status: string };
}

/** The managedDevice as asset fields. Throws when it has no id. */
export function mapIntuneDevice(device: IntuneDevice): MappedDevice {
  const id = text(device.id);
  if (!id) throw new Error('A device without an id cannot be imported');
  const serialNumber = text(device.serialNumber);
  const operatingSystem = text(device.operatingSystem);
  const model = text(device.model);
  const upn = text(device.userPrincipalName);
  const email = text(device.emailAddress);

  const values: Record<string, string | null> = {
    name: text(device.deviceName) ?? text(device.managedDeviceName) ?? serialNumber ?? id,
    serial_number: serialNumber,
    manufacturer: text(device.manufacturer),
    model,
    operating_system: operatingSystem,
    os_version: text(device.osVersion),
    compliance: mapCompliance(device.complianceState),
    last_check_in: checkIn(device.lastSyncDateTime),
    primary_user: upn ?? email,
    intune_device_id: id,
  };
  return {
    externalId: id,
    serialNumber,
    userEmail: (email ?? upn)?.toLowerCase() ?? null,
    values,
    createdOnly: { asset_type: assetTypeFor(operatingSystem, model), status: 'in_use' },
  };
}

/** The field the last check-in is kept in. */
const CHECK_IN_SLUG = 'last_check_in';

/** SHA-256 (hex) of the values as `JSON.stringify` writes them. */
async function sha256Hex(values: Record<string, string | null>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 (hex) of the imported values a change shows in: every fact but the
 * last check-in. A device with the same checksum is not written again; its
 * check-in is kept current without a record write (`refreshCheckIns`).
 */
export async function deviceChecksum(values: Record<string, string | null>): Promise<string> {
  return sha256Hex(Object.fromEntries(Object.entries(values).filter(([slug]) => slug !== CHECK_IN_SLUG)));
}

/**
 * The checksum as it was taken while the last check-in was part of it: over
 * every value, with `checkIn` as the check-in. Mappings written then still
 * carry one; a step recognises it and replaces it (`isChecksumOfOldKind`).
 */
export async function deviceChecksumWithCheckIn(
  values: Record<string, string | null>,
  checkIn: string | null,
): Promise<string> {
  return sha256Hex({ ...values, [CHECK_IN_SLUG]: checkIn });
}

/** The non-empty facts: what a write sends. */
function factsOf(values: Record<string, string | null>): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const [slug, value] of Object.entries(values)) if (value !== null) facts[slug] = value;
  return facts;
}

// ============================================================================
// Fields the import adds to the object
// ============================================================================

interface ImportField {
  slug: string;
  name: string;
  fieldType: 'text' | 'single_select' | 'date';
  options?: { label: string; value: string }[];
}

export const ASSET_IMPORT_FIELDS: readonly ImportField[] = [
  { slug: 'manufacturer', name: 'Manufacturer', fieldType: 'text' },
  { slug: 'model', name: 'Model', fieldType: 'text' },
  { slug: 'operating_system', name: 'Operating system', fieldType: 'text' },
  { slug: 'os_version', name: 'OS version', fieldType: 'text' },
  { slug: 'compliance', name: 'Compliance', fieldType: 'single_select', options: COMPLIANCE_OPTIONS },
  { slug: 'last_check_in', name: 'Last check-in', fieldType: 'date' },
  { slug: 'primary_user', name: 'Primary user', fieldType: 'text' },
  { slug: 'intune_device_id', name: 'Intune device ID', fieldType: 'text' },
];

export interface CreatedFieldDefinition {
  id: string;
  entityType: string;
  name: string;
  slug: string;
  fieldType: string;
  options?: { label: string; value: string }[];
  required: boolean;
  sortOrder: number;
}

/**
 * Add the fields the import writes that the object does not have yet, once:
 * a field that exists (made by the template, by hand or by an earlier import)
 * is left as it is. Returns the definitions it created, for their events.
 */
export async function ensureAssetImportFields(
  db: TenantDb,
  entityKey: string,
  options: { generateId?: IdGenerator; now?: Date } = {},
): Promise<CreatedFieldDefinition[]> {
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? new Date();
  const existing = await db
    .select({ slug: customFieldDefinitions.slug, sortOrder: customFieldDefinitions.sortOrder })
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.entityType, entityKey), isNull(customFieldDefinitions.deletedAt)));
  const taken = new Set(existing.map((row) => row.slug));
  let sortOrder = existing.reduce((max, row) => Math.max(max, row.sortOrder ?? 0), -1) + 1;

  const created: CreatedFieldDefinition[] = [];
  for (const field of ASSET_IMPORT_FIELDS) {
    if (taken.has(field.slug)) continue;
    const definition: CreatedFieldDefinition = {
      id: generateId('cfld'),
      entityType: entityKey,
      name: field.name,
      slug: field.slug,
      fieldType: field.fieldType,
      ...(field.options ? { options: field.options } : {}),
      required: false,
      sortOrder: sortOrder++,
    };
    try {
      await db.insert(customFieldDefinitions).values({
        id: definition.id,
        entityType: entityKey,
        name: definition.name,
        slug: definition.slug,
        fieldType: definition.fieldType,
        options: field.options ?? null,
        required: false,
        sortOrder: definition.sortOrder,
        createdAt: now,
        updatedAt: now,
      });
      created.push(definition);
    } catch (err) {
      // Another step (or a person) added it between the read and the insert.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return created;
}

// ============================================================================
// Scheduling
// ============================================================================

// The next scheduled import after a run (one interval after it ended, or none
// when the schedule is off) is set by `endRun`, in the UPDATE that ends the run.

/** When the sweep next has work for a source: now while a run is under way, else its schedule. */
export function assetSourceDueAt(
  source: Pick<AssetSource, 'enabled' | 'nextSyncAt' | 'syncState'>,
  now: Date,
): Date | null {
  if (source.syncState) return now;
  if (source.enabled && source.nextSyncAt) return source.nextSyncAt;
  return null;
}

/** Make the due-index sweep look at this workspace (`clerkOrgId`) no later than `at`. Best-effort. */
export function markAssetImportDue(
  d1: D1Database | undefined,
  clerkOrgId: string | null | undefined,
  at: Date | null | undefined,
): Promise<void> {
  if (!at) return Promise.resolve();
  return markWorkspaceDue(d1, 'asset_import', clerkOrgId, at);
}

// ============================================================================
// The row as the API shows it
// ============================================================================

export interface AssetSourceView {
  id: string;
  type: AssetSource['type'];
  name: string;
  objectSlug: string;
  config: IntuneAssetSourceConfig;
  hasSecret: boolean;
  enabled: boolean;
  intervalHours: number;
  nextSyncAt: string | null;
  lastStatus: AssetSource['lastStatus'];
  lastSyncAt: string | null;
  lastError: string | null;
  lastErrorCode: AssetSourceErrorCode | null;
  lastStats: AssetSourceRunStats | null;
  progress: { startedAt: string; stats: AssetSourceRunStats; startedById: string | null } | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** No `secretEncrypted`, a `hasSecret` flag in its place: safe for responses, events and logs. */
export function assetSourceView(row: AssetSource): AssetSourceView {
  const error = parseAssetSourceError(row.lastError);
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    objectSlug: row.objectSlug,
    config: { tenantId: row.config.tenantId, clientId: row.config.clientId },
    hasSecret: row.secretEncrypted !== null,
    enabled: row.enabled,
    intervalHours: row.intervalHours,
    nextSyncAt: iso(row.nextSyncAt),
    lastStatus: row.lastStatus,
    lastSyncAt: iso(row.lastSyncAt),
    lastError: error.message,
    lastErrorCode: error.code,
    lastStats: row.lastStats ?? null,
    progress: row.syncState
      ? { startedAt: row.syncState.startedAt, stats: row.syncState.stats, startedById: row.syncState.startedById ?? null }
      : null,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ============================================================================
// Running an import
// ============================================================================

export interface AssetImportEvents {
  /** A record was created or updated (only called when the object has events on). */
  record?: (event: { action: 'created' | 'updated'; entityKey: string; recordId: string; data: Record<string, unknown> }) => void | Promise<void>;
  /** A field definition was added to the object. */
  field?: (definition: CreatedFieldDefinition) => void | Promise<void>;
}

export interface AssetImportContext {
  db: TenantDb;
  keyring: EncryptionKeyring;
  /** Injected in tests; Microsoft is called through it. */
  fetch?: FetchLike;
  now?: Date;
  generateId?: IdGenerator;
  /** Record writes per step; default {@link ASSET_IMPORT_MAX_WRITES}. */
  maxWrites?: number;
  events?: AssetImportEvents;
}

export interface AssetImportStepResult {
  /** The run ended (finished or failed); the source row is settled. */
  done: boolean;
  /** Microsoft asked to wait: do not continue before this many seconds. */
  retryAfterSeconds?: number;
  /**
   * Another step holds the run (the one of an earlier tick is still at work):
   * this one did nothing, and the run is still under way.
   */
  busy?: boolean;
  /** The source as stored after the step. */
  source: AssetSource;
}

function zeroStats(): AssetSourceRunStats {
  return { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };
}

/**
 * Start an import by hand or on schedule. Returns the updated source, or null
 * when a run is already under way (nothing is changed then).
 */
export async function startAssetImport(
  db: TenantDb,
  source: Pick<AssetSource, 'id'>,
  options: { now?: Date; startedById?: string | null } = {},
): Promise<AssetSource | null> {
  const now = options.now ?? new Date();
  const state: AssetSourceSyncState = {
    startedAt: now.toISOString(),
    nextLink: null,
    offset: 0,
    stats: zeroStats(),
    startedById: options.startedById ?? null,
  };
  const [row] = await db
    .update(assetSources)
    .set({ syncState: state, lastStatus: 'running', lastError: null, updatedAt: now })
    .where(and(eq(assetSources.id, source.id), isNull(assetSources.syncState)))
    .returning();
  return row ?? null;
}

/** A step at work: the run as its claim returned it, and the lease the claim took. */
interface StepRun {
  ctx: AssetImportContext;
  /** The source as stored when the step claimed the run. */
  source: AssetSource;
  state: AssetSourceSyncState;
  now: Date;
  /** The `leaseUntil` this step wrote: its writes go through only while the row still carries it. */
  lease: string;
}

/** The row still carries this step's lease. */
const leasedBy = (lease: string): SQL => sql`${assetSources.syncState}->>'leaseUntil' = ${lease}`;

/**
 * Take the run for one step: a compare-and-set that goes through only while no
 * other step holds a lease that has not run out. The step then works from the
 * row the claim returns, not from what its caller read earlier. Null: another
 * step is at work, or no run is under way any more.
 */
async function claimStep(ctx: AssetImportContext, id: string, now: Date): Promise<StepRun | null> {
  const lease = new Date(now.getTime() + ASSET_IMPORT_STEP_LEASE_MS).toISOString();
  const [source] = await ctx.db
    .update(assetSources)
    .set({ syncState: sql`jsonb_set(${assetSources.syncState}, '{leaseUntil}', to_jsonb(${lease}::text))` })
    .where(
      and(
        eq(assetSources.id, id),
        sql`jsonb_typeof(${assetSources.syncState}) = 'object'`,
        // ISO times of one form order as text; no lease reads as the empty string.
        sql`coalesce(${assetSources.syncState}->>'leaseUntil', '') collate "C" <= ${now.toISOString()}`,
      ),
    )
    .returning();
  const state = source?.syncState;
  return source && state ? { ctx, source, state, now, lease } : null;
}

/** The state as the next step finds it: without this step's lease. */
function withoutLease(state: AssetSourceSyncState): AssetSourceSyncState {
  const next = { ...state };
  delete next.leaseUntil;
  return next;
}

/**
 * The step's last write found the run no longer its own (its lease ran out and
 * another step took over, or the source was deleted): this step settles nothing.
 */
function lostRun(run: StepRun): AssetImportStepResult {
  return { done: false, source: run.source };
}

/** Save where the run stands; the lease goes with the write. */
async function saveState(run: StepRun, next: AssetSourceSyncState): Promise<AssetImportStepResult> {
  const saved = await run.ctx.db
    .update(assetSources)
    .set({ syncState: next, updatedAt: run.now })
    .where(and(eq(assetSources.id, run.source.id), leasedBy(run.lease)))
    .returning({ id: assetSources.id });
  if (saved.length === 0) return lostRun(run);
  return { done: false, source: { ...run.source, syncState: next } };
}

/** Give the lease up and leave everything else as it is: a throttled step waits. */
async function releaseLease(run: StepRun): Promise<void> {
  await run.ctx.db
    .update(assetSources)
    .set({ syncState: sql`${assetSources.syncState} - 'leaseUntil'` })
    .where(and(eq(assetSources.id, run.source.id), leasedBy(run.lease)));
}

/**
 * The run is over, finished or failed. The next scheduled import comes from
 * the row's own `enabled` and `interval_hours` as they are when this is
 * written, not as the step read them: the schedule may have been switched on,
 * or its interval changed, while the step ran.
 */
async function endRun(
  run: StepRun,
  stats: AssetSourceRunStats,
  failure: AssetSourceError | null,
): Promise<AssetImportStepResult> {
  const { now } = run;
  const [row] = await run.ctx.db
    .update(assetSources)
    .set({
      syncState: null,
      lastSyncAt: now,
      lastStatus: failure ? 'failed' : 'ok',
      lastError: failure ? formatAssetSourceError(failure) : null,
      lastStats: stats,
      nextSyncAt: sql`case when ${assetSources.enabled} then ${now.toISOString()}::timestamp + ${assetSources.intervalHours} * interval '1 hour' else null end`,
      updatedAt: now,
    })
    .where(and(eq(assetSources.id, run.source.id), leasedBy(run.lease)))
    .returning();
  return row ? { done: true, source: row } : lostRun(run);
}

async function openSecret(source: AssetSource, keyring: EncryptionKeyring): Promise<string> {
  if (!source.secretEncrypted) throw new AssetSourceError('invalid_secret', 'No client secret is stored; enter it again.');
  try {
    return await decryptField(source.secretEncrypted, keyring);
  } catch {
    throw new AssetSourceError('invalid_secret', 'The stored client secret cannot be read; enter it again.');
  }
}

type RecordRow = typeof customObjectRecords.$inferSelect;
type MappingRow = typeof integrationEntityMappings.$inferSelect;

/**
 * Do one bounded step of the run under way (`source.syncState`). Never throws
 * for a problem with Microsoft or with one device: those end the run as
 * `failed` (or, when throttled, wait). A thrown error is a tenant DB failure;
 * the run stays as it was and a later tick repeats the step, once the lease
 * this one took has run out.
 *
 * The step takes the run's lease before it does anything. When another step
 * holds it, this one does nothing and answers `busy` (not done), so two ticks
 * never import the same devices at once.
 */
export async function runAssetImportStep(ctx: AssetImportContext, source: AssetSource): Promise<AssetImportStepResult> {
  const now = ctx.now ?? new Date();
  if (!source.syncState) return { done: true, source };

  const run = await claimStep(ctx, source.id, now);
  if (!run) return { done: false, busy: true, source };

  if (now.getTime() - Date.parse(run.state.startedAt) > ASSET_IMPORT_MAX_RUN_MS) {
    const failure = new AssetSourceError('throttled', 'The import did not finish within 24 hours and was stopped. It starts again on schedule.');
    return endRun(run, run.state.stats, failure);
  }

  try {
    return await step(run);
  } catch (err) {
    if (!(err instanceof AssetSourceError)) throw err;
    if (err.code === 'throttled') {
      await releaseLease(run);
      return {
        done: false,
        retryAfterSeconds: err.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
        source: { ...run.source, syncState: withoutLease(run.state) },
      };
    }
    return endRun(run, run.state.stats, err);
  }
}

async function step(run: StepRun): Promise<AssetImportStepResult> {
  const { ctx, source, now } = run;
  const state = withoutLease(run.state);
  const { db } = ctx;
  const generateId = ctx.generateId ?? defaultGenerateId;
  const maxWrites = ctx.maxWrites ?? ASSET_IMPORT_MAX_WRITES;

  const object = await getCustomObjectBySlug(db, source.objectSlug);
  if (!object) throw new AssetSourceError('asset_register_missing');
  const entityKey = object.entityKey;

  // Microsoft first: a refusal or a throttle leaves the tenant data untouched.
  const secret = await openSecret(source, ctx.keyring);
  const token = await intuneToken(source.config, secret, ctx.fetch);
  const page = await fetchIntunePage(token, state.nextLink ?? null, ctx.fetch);

  for (const created of await ensureAssetImportFields(db, entityKey, { generateId, now })) {
    await ctx.events?.field?.(created);
  }

  const userId = state.startedById ?? source.createdById ?? 'system';
  const stats: AssetSourceRunStats = { ...state.stats };
  let index = state.offset ?? 0;
  const { mappings, records } = await loadMappedRecords(db, source, entityKey, page.devices.slice(index));

  const job: DeviceJob = {
    ctx,
    db,
    source,
    object,
    entityKey,
    userId,
    generateId,
    now,
    mappings,
    records,
    claimed: new Set(),
    lookups: await prepareLookups(db, entityKey),
    checkIns: new Map(),
    replaced: new Map(),
  };
  let writes = 0;

  while (index < page.devices.length && writes < maxWrites) {
    const device = page.devices[index]!;
    index += 1;
    stats.total += 1;
    try {
      const outcome = await importDevice(job, device);
      stats[outcome] += 1;
      if (outcome !== 'unchanged') writes += 1;
    } catch {
      stats.failed += 1;
      writes += 1;
    }
  }

  // What the step owes the devices it did not write: neither counts as a write.
  await refreshCheckIns(job);
  await replaceChecksums(job);

  if (index < page.devices.length) {
    // Stopped inside the page: the next step reads it again from `index`.
    return saveState(run, { ...state, nextLink: state.nextLink ?? null, offset: index, stats });
  }
  if (page.nextLink) return saveState(run, { ...state, nextLink: page.nextLink, offset: 0, stats });
  return endRun(run, stats, null);
}

/** The devices' mappings, and the records they point to, in one query each. */
async function loadMappedRecords(
  db: TenantDb,
  source: AssetSource,
  entityKey: string,
  devices: IntuneDevice[],
): Promise<{ mappings: Map<string, MappingRow>; records: Map<string, RecordRow> }> {
  const ids = devices.flatMap((device) => {
    const id = text(device.id);
    return id ? [id] : [];
  });
  const mappings = new Map<string, MappingRow>();
  if (ids.length > 0) {
    const rows = await db
      .select()
      .from(integrationEntityMappings)
      .where(
        and(
          eq(integrationEntityMappings.connectionId, source.id),
          eq(integrationEntityMappings.externalEntityType, INTUNE_DEVICE_ENTITY_TYPE),
          inArray(integrationEntityMappings.externalEntityId, ids),
        ),
      );
    for (const row of rows) mappings.set(row.externalEntityId, row);
  }
  const records = new Map<string, RecordRow>();
  if (mappings.size > 0) {
    const rows = await db
      .select()
      .from(customObjectRecords)
      .where(
        and(
          eq(customObjectRecords.entityKey, entityKey),
          inArray(customObjectRecords.id, [...mappings.values()].map((row) => row.internalEntityId)),
        ),
      );
    for (const row of rows) records.set(row.id, row);
  }
  return { mappings, records };
}

/** The value column the last check-in is kept in, by the type of its field. */
type CheckInColumn = 'date' | 'text';

interface Lookups {
  serialFieldId: string | null;
  /** The live `last_check_in` field, when its type keeps the check-in as a date or as plain text. */
  checkInField: { id: string; column: CheckInColumn } | null;
  ownerLink: typeof customObjectLinks.$inferSelect | null;
}

/** The import adds the field as a date; one made by hand may be text. Any other type is left to the record writes. */
function checkInColumnOf(fieldType: string): CheckInColumn | null {
  if (fieldType === 'date') return 'date';
  return fieldType === 'text' || fieldType === 'textarea' ? 'text' : null;
}

async function prepareLookups(db: TenantDb, entityKey: string): Promise<Lookups> {
  const fields = await db
    .select({ id: customFieldDefinitions.id, slug: customFieldDefinitions.slug, fieldType: customFieldDefinitions.fieldType })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.entityType, entityKey),
        inArray(customFieldDefinitions.slug, ['serial_number', CHECK_IN_SLUG]),
        isNull(customFieldDefinitions.deletedAt),
      ),
    );
  const serial = fields.find((field) => field.slug === 'serial_number');
  const checkIn = fields.find((field) => field.slug === CHECK_IN_SLUG);
  const checkInColumn = checkIn ? checkInColumnOf(checkIn.fieldType) : null;
  const [ownerLink] = await db
    .select()
    .from(customObjectLinks)
    .where(
      and(
        eq(customObjectLinks.sourceEntityKey, entityKey),
        eq(customObjectLinks.slug, 'owner'),
        isNull(customObjectLinks.deletedAt),
      ),
    )
    .limit(1);
  return {
    serialFieldId: serial?.id ?? null,
    checkInField: checkIn && checkInColumn ? { id: checkIn.id, column: checkInColumn } : null,
    ownerLink: ownerLink ?? null,
  };
}

interface DeviceJob {
  ctx: AssetImportContext;
  db: TenantDb;
  source: AssetSource;
  object: CustomObjectRow;
  entityKey: string;
  userId: string;
  generateId: IdGenerator;
  now: Date;
  mappings: Map<string, MappingRow>;
  records: Map<string, RecordRow>;
  /** Records this run has already tied to a device (adoption must not take them twice). */
  claimed: Set<string>;
  lookups: Lookups;
  /** The last check-in of each device this step left unwritten, by its (live) record. */
  checkIns: Map<string, string>;
  /** The checksum to put in place of one of the old kind, by mapping id. */
  replaced: Map<string, string>;
  /** The check-ins the page's records hold, read once, when a checksum first differs. */
  storedCheckIns?: Map<string, string>;
}

type DeviceOutcome = 'created' | 'updated' | 'unchanged';

async function importDevice(job: DeviceJob, device: IntuneDevice): Promise<DeviceOutcome> {
  const mapped = mapIntuneDevice(device);
  const checksum = await deviceChecksum(mapped.values);
  const mapping = job.mappings.get(mapped.externalId);
  return mapping ? importMapped(job, mapped, mapping, checksum) : importUnmapped(job, mapped, checksum);
}

async function emitRecord(job: DeviceJob, action: 'created' | 'updated', data: Record<string, unknown>): Promise<void> {
  if (!job.object.enableEvents) return;
  await job.ctx.events?.record?.({ action, entityKey: job.entityKey, recordId: String(data.id), data });
}

/**
 * A check-in the value column takes as it is written: `toISOString()` of a
 * four-digit year. (A later year has a sign and six digits, which Postgres
 * does not read; a record write refuses it too.)
 */
function isStorableCheckIn(checkIn: string): boolean {
  return checkIn.length === 24;
}

/** A device this source imported before: written again only when a fact other than the last check-in changed. */
async function importMapped(
  job: DeviceJob,
  mapped: MappedDevice,
  mapping: MappingRow,
  checksum: string,
): Promise<DeviceOutcome> {
  const { db, now } = job;
  const record = job.records.get(mapping.internalEntityId);
  // A record a person deleted stays deleted; the import does not bring it back.
  if (!record || record.deletedAt) return 'unchanged';

  if (mapping.syncChecksum === checksum || (await isChecksumOfOldKind(job, mapped, mapping, checksum))) {
    const checkIn = mapped.values[CHECK_IN_SLUG];
    if (checkIn && isStorableCheckIn(checkIn)) job.checkIns.set(record.id, checkIn);
    return 'unchanged';
  }

  const updated = await updateRecord(db, job.object, record, { fields: factsOf(mapped.values) }, job.userId, job.generateId);
  await db
    .update(integrationEntityMappings)
    .set({ syncChecksum: checksum, lastSyncedAt: now, updatedAt: now })
    .where(eq(integrationEntityMappings.id, mapping.id));
  job.mappings.set(mapped.externalId, { ...mapping, syncChecksum: checksum });
  // The write carried the check-in and the checksum: nothing is left to settle for this record.
  job.checkIns.delete(record.id);
  job.replaced.delete(mapping.id);
  await emitRecord(job, 'updated', { ...updated });
  return 'updated';
}

/**
 * Whether the mapping carries a checksum of the old kind (taken with the last
 * check-in) of these same facts: with the check-in the record holds, with the
 * one the device reports now, or with none. Then nothing but the check-in
 * differs, and the checksum is replaced at the end of the step instead of the
 * record being rewritten: the first import after the checksum changed does not
 * write every device once.
 */
async function isChecksumOfOldKind(
  job: DeviceJob,
  mapped: MappedDevice,
  mapping: MappingRow,
  checksum: string,
): Promise<boolean> {
  job.storedCheckIns ??= await loadStoredCheckIns(job);
  const candidates = new Set<string | null>([
    job.storedCheckIns.get(mapping.internalEntityId) ?? null,
    mapped.values[CHECK_IN_SLUG] ?? null,
    null,
  ]);
  for (const checkIn of candidates) {
    if ((await deviceChecksumWithCheckIn(mapped.values, checkIn)) === mapping.syncChecksum) {
      job.replaced.set(mapping.id, checksum);
      job.mappings.set(mapped.externalId, { ...mapping, syncChecksum: checksum });
      return true;
    }
  }
  return false;
}

/** The last check-in each live record of the page holds, as the import wrote it (ISO). One query. */
async function loadStoredCheckIns(job: DeviceJob): Promise<Map<string, string>> {
  const stored = new Map<string, string>();
  const field = job.lookups.checkInField;
  const ids = [...job.records.values()].filter((record) => !record.deletedAt).map((record) => record.id);
  if (!field || ids.length === 0) return stored;
  const rows = await job.db
    .select({ recordId: customFieldValues.entityId, date: customFieldValues.valueDate, text: customFieldValues.valueText })
    .from(customFieldValues)
    .where(
      and(
        eq(customFieldValues.fieldId, field.id),
        eq(customFieldValues.entityType, job.entityKey),
        inArray(customFieldValues.entityId, ids),
      ),
    );
  for (const row of rows) {
    const value = field.column === 'date' ? row.date?.toISOString() : row.text;
    if (value) stored.set(row.recordId, value);
  }
  return stored;
}

/** The value column of each kind of check-in field, and the check-in as that column takes it. */
const CHECK_IN_SQL: Record<CheckInColumn, { column: SQL; value: SQL }> = {
  date: { column: sql.raw('value_date'), value: sql.raw('x.check_in::timestamp') },
  text: { column: sql.raw('value_text'), value: sql.raw('x.check_in') },
};

/**
 * Keep the last check-in of the devices this step left unwritten current: one
 * statement on the field's value column, only where the stored value differs.
 * No record is written (its `updatedAt` stays), no event goes out, and it does
 * not count against the step's writes. A record that has no value yet gets it
 * with its next write.
 */
async function refreshCheckIns(job: DeviceJob): Promise<void> {
  const field = job.lookups.checkInField;
  if (!field || job.checkIns.size === 0) return;
  const rows = JSON.stringify([...job.checkIns].map(([record_id, check_in]) => ({ record_id, check_in })));
  const { column, value } = CHECK_IN_SQL[field.column];
  await job.db.execute(sql`
    update custom_field_values as v
       set ${column} = ${value}, updated_at = ${job.now.toISOString()}::timestamp
      from jsonb_to_recordset(${rows}::jsonb) as x(record_id text, check_in text)
     where v.field_id = ${field.id}
       and v.entity_type = ${job.entityKey}
       and v.entity_id = x.record_id
       and v.${column} is distinct from ${value}`);
}

/** Put the checksum without the check-in in place of each one of the old kind this step recognised: one statement. */
async function replaceChecksums(job: DeviceJob): Promise<void> {
  if (job.replaced.size === 0) return;
  const rows = JSON.stringify([...job.replaced].map(([id, checksum]) => ({ id, checksum })));
  await job.db.execute(sql`
    update integration_entity_mappings as m
       set sync_checksum = x.checksum, updated_at = ${job.now.toISOString()}::timestamp
      from jsonb_to_recordset(${rows}::jsonb) as x(id text, checksum text)
     where m.id = x.id`);
}

/** A device this source has not imported yet: a record with its serial number is adopted, else one is created. */
async function importUnmapped(job: DeviceJob, mapped: MappedDevice, checksum: string): Promise<DeviceOutcome> {
  const { db, source, object, entityKey, userId, generateId, now, mappings, claimed, lookups } = job;
  const facts = factsOf(mapped.values);

  const adoptable = await findAdoptableRecord(db, source, entityKey, mapped.serialNumber, lookups, claimed);
  if (adoptable) {
    claimed.add(adoptable.id);
    const updated = await updateRecord(db, object, adoptable, { fields: facts }, userId, generateId);
    await insertMapping(db, source, entityKey, mapped.externalId, adoptable.id, checksum, now, generateId, mappings);
    await emitRecord(job, 'updated', { ...updated });
    return 'updated';
  }

  const created = await createRecord(
    db,
    object,
    { fields: { ...facts, ...mapped.createdOnly } },
    userId,
    generateId,
  );
  claimed.add(created.id);
  await insertMapping(db, source, entityKey, mapped.externalId, created.id, checksum, now, generateId, mappings);
  await attachOwner(db, lookups, entityKey, created.id, mapped.userEmail, userId, now, generateId);
  await emitRecord(job, 'created', { ...created });
  return 'created';
}

async function insertMapping(
  db: TenantDb,
  source: AssetSource,
  entityKey: string,
  externalId: string,
  recordId: string,
  checksum: string,
  now: Date,
  generateId: IdGenerator,
  mappings: Map<string, MappingRow>,
): Promise<void> {
  const [row] = await db
    .insert(integrationEntityMappings)
    .values({
      id: generateId('iem'),
      connectionId: source.id,
      externalEntityType: INTUNE_DEVICE_ENTITY_TYPE,
      externalEntityId: externalId,
      internalEntityType: entityKey,
      internalEntityId: recordId,
      syncChecksum: checksum,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (row) mappings.set(externalId, row);
}

/** A live record with this serial number that no device of this source is mapped to yet (oldest first). */
async function findAdoptableRecord(
  db: TenantDb,
  source: AssetSource,
  entityKey: string,
  serial: string | null,
  lookups: Lookups,
  claimed: Set<string>,
): Promise<RecordRow | null> {
  if (!serial || !lookups.serialFieldId) return null;
  const candidates = await db
    .select({ record: customObjectRecords })
    .from(customFieldValues)
    .innerJoin(customObjectRecords, eq(customObjectRecords.id, customFieldValues.entityId))
    .where(
      and(
        eq(customFieldValues.fieldId, lookups.serialFieldId),
        eq(customFieldValues.entityType, entityKey),
        eq(customFieldValues.valueText, serial),
        eq(customObjectRecords.entityKey, entityKey),
        isNull(customObjectRecords.deletedAt),
      ),
    )
    .orderBy(asc(customObjectRecords.createdAt), asc(customObjectRecords.id));
  const free = candidates.map((row) => row.record).filter((record) => !claimed.has(record.id));
  if (free.length === 0) return null;

  const mapped = await db
    .select({ id: integrationEntityMappings.internalEntityId })
    .from(integrationEntityMappings)
    .where(
      and(
        eq(integrationEntityMappings.connectionId, source.id),
        eq(integrationEntityMappings.externalEntityType, INTUNE_DEVICE_ENTITY_TYPE),
        inArray(integrationEntityMappings.internalEntityId, free.map((record) => record.id)),
      ),
    );
  const taken = new Set(mapped.map((row) => row.id));
  return free.find((record) => !taken.has(record.id)) ?? null;
}

/** The `owner` link to the one person with the device user's email; none or several: no owner. */
async function attachOwner(
  db: TenantDb,
  lookups: Lookups,
  entityKey: string,
  recordId: string,
  email: string | null,
  userId: string,
  now: Date,
  generateId: IdGenerator,
): Promise<void> {
  const link = lookups.ownerLink;
  if (!link || !email) return;
  const matches = await db
    .select({ id: people.id })
    .from(people)
    .where(and(isNull(people.deletedAt), sql`lower(${people.email}) = ${email}`))
    .limit(2);
  if (matches.length !== 1) return;
  await db.insert(customObjectRelations).values({
    id: generateId('corl'),
    linkId: link.id,
    sourceEntityKey: entityKey,
    sourceId: recordId,
    targetEntityKey: link.targetEntityKey,
    targetId: matches[0]!.id,
    createdBy: userId,
    createdAt: now,
  });
}

