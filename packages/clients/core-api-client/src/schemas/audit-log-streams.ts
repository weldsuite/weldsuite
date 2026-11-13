import { z } from 'zod';

/**
 * Audit log streams: destinations a workspace's audit events are pushed to
 * (`/api/audit-log-streams`). The token is write-only; rows carry `hasToken`.
 */

export const AUDIT_LOG_STREAM_TYPES = ['splunk_hec', 'http'] as const;
export const AUDIT_LOG_STREAM_STATUSES = ['active', 'paused', 'disabled'] as const;
export const AUDIT_LOG_STREAM_FORMATS = ['json', 'ndjson'] as const;
/** Streams a workspace may have; the next create answers 409. */
export const MAX_AUDIT_LOG_STREAMS = 5;

export const auditLogStreamTypeSchema = z.enum(AUDIT_LOG_STREAM_TYPES);
export const auditLogStreamStatusSchema = z.enum(AUDIT_LOG_STREAM_STATUSES);

/** An HTTP header name: letters, digits and hyphens. */
const headerName = z.string().trim().regex(/^[A-Za-z0-9-]{1,100}$/, 'Not a valid header name');

export const auditLogStreamSettingsSchema = z.object({
  /** Splunk index, source, sourcetype and host of the events. */
  index: z.string().trim().min(1).max(255).optional(),
  source: z.string().trim().min(1).max(255).optional(),
  sourcetype: z.string().trim().min(1).max(255).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  /** `http`: the header the token is sent in. Default `Authorization`. */
  authHeader: headerName.optional(),
  /** `http`: `{ "events": [...] }` (default) or one JSON object per line. */
  format: z.enum(AUDIT_LOG_STREAM_FORMATS).optional(),
});

export const createAuditLogStreamSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: auditLogStreamTypeSchema,
  /** https only, no credentials, no private address (checked by the API). */
  url: z.string().trim().min(1).max(2048),
  /** Write-only. The HEC token, or the value of the auth header, as the collector expects it. */
  token: z.string().min(1).max(2048).nullish(),
  settings: auditLogStreamSettingsSchema.nullish(),
});

export const updateAuditLogStreamSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  type: auditLogStreamTypeSchema.optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  /** Omitted: keep the stored token. `null`: remove it. A string: replace it. */
  token: z.string().min(1).max(2048).nullable().optional(),
  /** Replaces the settings; `null` clears them. */
  settings: auditLogStreamSettingsSchema.nullable().optional(),
  /** `active` also clears the failure count and the last error; `disabled` is set by the platform only. */
  status: z.enum(['active', 'paused']).optional(),
});

/** An audit log stream as the API answers it. Never carries the token. */
export const auditLogStreamSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: auditLogStreamTypeSchema,
  url: z.string(),
  hasToken: z.boolean(),
  settings: auditLogStreamSettingsSchema.nullable(),
  status: auditLogStreamStatusSchema,
  /** The last audit row delivered (its time, to the millisecond), null before the first delivery. */
  cursorCreatedAt: z.string().nullable(),
  lastDeliveredAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  deliveredCount: z.number().int(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `POST /:id/test`: what the destination answered to one synthetic event. */
export const auditLogStreamTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
});

export type AuditLogStreamType = z.infer<typeof auditLogStreamTypeSchema>;
export type AuditLogStreamStatus = z.infer<typeof auditLogStreamStatusSchema>;
export type AuditLogStreamSettings = z.infer<typeof auditLogStreamSettingsSchema>;
export type CreateAuditLogStreamInput = z.infer<typeof createAuditLogStreamSchema>;
export type UpdateAuditLogStreamInput = z.infer<typeof updateAuditLogStreamSchema>;
export type AuditLogStream = z.infer<typeof auditLogStreamSchema>;
export type AuditLogStreamTestResult = z.infer<typeof auditLogStreamTestResultSchema>;
