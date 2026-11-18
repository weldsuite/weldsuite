import { z } from 'zod';

/**
 * Asset sources: device management systems the asset register imports from
 * (`/api/asset-sources`). Today one type: Microsoft Intune, through the
 * customer's own Entra app registration. The client secret is write-only; rows
 * carry `hasSecret`.
 */

export const ASSET_SOURCE_TYPES = ['intune'] as const;
export const ASSET_SOURCE_RUN_STATUSES = ['running', 'ok', 'failed'] as const;
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
  'run_timeout',
] as const;
export const ASSET_SOURCE_MIN_INTERVAL_HOURS = 1;
export const ASSET_SOURCE_MAX_INTERVAL_HOURS = 168;
export const ASSET_SOURCE_DEFAULT_INTERVAL_HOURS = 24;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** An Entra tenant is a directory id (GUID) or a verified domain name. */
export function isEntraTenantId(value: string): boolean {
  return GUID.test(value) || HOSTNAME.test(value);
}

export const assetSourceTypeSchema = z.enum(ASSET_SOURCE_TYPES);
export const assetSourceRunStatusSchema = z.enum(ASSET_SOURCE_RUN_STATUSES);
export const assetSourceErrorCodeSchema = z.enum(ASSET_SOURCE_ERROR_CODES);

export const intuneConfigSchema = z.object({
  /** Directory (tenant) id, or a verified domain of the tenant. */
  tenantId: z.string().trim().refine(isEntraTenantId, 'Not a tenant id or domain name'),
  /** Application (client) id of the app registration. */
  clientId: z.string().trim().min(1).max(255),
});

const intervalHours = z.number().int().min(ASSET_SOURCE_MIN_INTERVAL_HOURS).max(ASSET_SOURCE_MAX_INTERVAL_HOURS);
const secret = z.string().trim().min(1).max(2048);

export const createAssetSourceSchema = z.object({
  type: assetSourceTypeSchema.default('intune'),
  name: z.string().trim().min(1).max(255),
  config: intuneConfigSchema,
  /** Write-only: the client secret Value of the app registration. */
  secret,
  enabled: z.boolean().default(true),
  intervalHours: intervalHours.default(ASSET_SOURCE_DEFAULT_INTERVAL_HOURS),
});

export const updateAssetSourceSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  /** A different tenant or application needs a new `secret` with it. */
  config: intuneConfigSchema.optional(),
  /** Omitted: keep the stored secret. */
  secret: secret.optional(),
  enabled: z.boolean().optional(),
  intervalHours: intervalHours.optional(),
});

/** `POST /test`: try a connection that is not saved yet. */
export const testAssetSourceSchema = z.object({
  config: intuneConfigSchema,
  secret,
});

/** `POST /:id/test`: the saved connection, optionally with a replacement secret or config. */
export const testSavedAssetSourceSchema = z.object({
  config: intuneConfigSchema.optional(),
  secret: secret.optional(),
});

export const assetSourceStatsSchema = z
  .object({
    total: z.number().int(),
    created: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
    failed: z.number().int(),
  })
  .strict();

/** An import under way. */
export const assetSourceProgressSchema = z
  .object({
    startedAt: z.string(),
    stats: assetSourceStatsSchema,
    startedById: z.string().nullable(),
  })
  .strict();

/** An asset source as the API answers it. Never carries the secret. */
export const assetSourceSchema = z
  .object({
    id: z.string(),
    type: assetSourceTypeSchema,
    name: z.string(),
    objectSlug: z.string(),
    config: z.object({ tenantId: z.string(), clientId: z.string() }).strict(),
    hasSecret: z.boolean(),
    enabled: z.boolean(),
    intervalHours: z.number().int(),
    nextSyncAt: z.string().nullable(),
    /** `running` while an import is under way; otherwise how the last one ended. Null before the first. */
    lastStatus: assetSourceRunStatusSchema.nullable(),
    lastSyncAt: z.string().nullable(),
    /** Human message of the last failure. */
    lastError: z.string().nullable(),
    /** Stable code of the last failure, for wording of your own. */
    lastErrorCode: assetSourceErrorCodeSchema.nullable(),
    lastStats: assetSourceStatsSchema.nullable(),
    progress: assetSourceProgressSchema.nullable(),
    createdById: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

/** `POST /test` and `POST /:id/test`: always HTTP 200; a refused connection is `ok: false`. */
export const assetSourceTestResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), deviceCount: z.number().int() }).strict(),
  z.object({ ok: z.literal(false), code: assetSourceErrorCodeSchema, message: z.string() }).strict(),
]);

export type AssetSourceType = z.infer<typeof assetSourceTypeSchema>;
export type AssetSourceRunStatus = z.infer<typeof assetSourceRunStatusSchema>;
export type AssetSourceErrorCode = z.infer<typeof assetSourceErrorCodeSchema>;
export type IntuneConfig = z.infer<typeof intuneConfigSchema>;
export type CreateAssetSourceInput = z.input<typeof createAssetSourceSchema>;
export type UpdateAssetSourceInput = z.infer<typeof updateAssetSourceSchema>;
export type TestAssetSourceInput = z.infer<typeof testAssetSourceSchema>;
export type TestSavedAssetSourceInput = z.infer<typeof testSavedAssetSourceSchema>;
export type AssetSourceStats = z.infer<typeof assetSourceStatsSchema>;
export type AssetSourceProgress = z.infer<typeof assetSourceProgressSchema>;
export type AssetSource = z.infer<typeof assetSourceSchema>;
export type AssetSourceTestResult = z.infer<typeof assetSourceTestResultSchema>;
