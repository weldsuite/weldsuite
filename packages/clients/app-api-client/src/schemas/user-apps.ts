import { z } from 'zod';

/**
 * WeldApps — user-created apps.
 *
 * The manifest (`weldapp.json`) is authored by the weld CLI (or the
 * in-platform builder) and validated here on every upload. The same schema
 * is embedded in @weldsuite/cli so agents get identical validation offline.
 */

export const userAppCodeSchema = z
  .string()
  .min(3)
  .max(50)
  .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes, starting with a letter');

const scopeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_-]*:(\*|[a-z][a-z0-9_:-]*)$|^\*$/, 'scope must look like resource:action, resource:* or *');

export const agentToolActionSchema = z.object({
  type: z.enum(['storage.list', 'storage.create', 'storage.update', 'storage.delete', 'api.request']),
  /** Storage collection the tool operates on (storage.* actions). */
  collection: z.string().max(100).optional(),
  /** HTTP method + external-api path (api.request actions). */
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).optional(),
  path: z.string().max(500).optional(),
});

export const agentToolSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'lowercase snake_case'),
  description: z.string().min(1).max(1000),
  /** JSON Schema for the tool input. */
  parameters: z.record(z.unknown()).optional(),
  action: agentToolActionSchema,
});

// ---------------------------------------------------------------------------
// Lifecycle webhook URL safety (write-time Zod + dispatch-time fetch)
// ---------------------------------------------------------------------------

const BLOCKED_WEBHOOK_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
]);

function isBlockedWebhookHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_WEBHOOK_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;

  // Reject literal IPs (loopback / private / link-local / metadata / public).
  // Lifecycle webhooks must use a DNS hostname; dispatch uses redirect:'manual'.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (host.includes(':')) return true;

  return false;
}

/**
 * True when `raw` is safe to use as an app lifecycle webhook destination.
 * Requires public https, no credentials, DNS hostnames only (no IP literals),
 * and rejects loopback / metadata / .local / .internal hosts.
 */
export function isSafeAppLifecycleWebhookUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return !isBlockedWebhookHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export const appLifecycleWebhookUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine(isSafeAppLifecycleWebhookUrl, {
    message:
      'webhookUrl must be a public https URL with a DNS hostname (no private, link-local, loopback, metadata, or IP-literal hosts)',
  });

export const userAppManifestSchema = z.object({
  code: userAppCodeSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(),
  category: z.string().max(50).optional(),
  version: z
    .string()
    .max(20)
    .regex(/^\d+\.\d+\.\d+$/, 'semver (e.g. 1.0.0)'),
  entrypoint: z.string().max(255).optional(),
  scopes: z.array(scopeSchema).max(50).default([]),
  collections: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9_-]*$/, 'lowercase letters, digits, dashes, underscores'),
        description: z.string().max(500).optional(),
      }),
    )
    .max(50)
    .optional(),
  agentTools: z.array(agentToolSchema).max(50).optional(),
  pricing: z
    .object({
      type: z.enum(['free', 'subscription']),
      monthlyPrice: z.number().min(0).max(10000).optional(),
      currency: z.string().length(3).optional(),
    })
    .optional(),
  websiteUrl: z.string().url().max(2000).optional(),
  privacyUrl: z.string().url().max(2000).optional(),
  screenshots: z.array(z.string().url().max(2000)).max(8).optional(),
  webhookUrl: appLifecycleWebhookUrlSchema.optional(),
  /** Reserved — v1 renders on the web platform only. */
  mobile: z.boolean().optional(),
});

export type UserAppManifestInput = z.infer<typeof userAppManifestSchema>;

// ---------------------------------------------------------------------------
// Management API (app-api /api/user-apps)
// ---------------------------------------------------------------------------

export const createUserAppSchema = z.object({
  code: userAppCodeSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(),
  category: z.string().max(50).optional(),
  websiteUrl: z.string().url().max(2000).optional(),
  privacyUrl: z.string().url().max(2000).optional(),
  screenshots: z.array(z.string().url().max(2000)).max(8).optional(),
  webhookUrl: appLifecycleWebhookUrlSchema.optional(),
});

export const updateUserAppSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(),
  category: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
  websiteUrl: z.string().url().max(2000).nullable().optional(),
  privacyUrl: z.string().url().max(2000).nullable().optional(),
  screenshots: z.array(z.string().url().max(2000)).max(8).optional(),
  webhookUrl: appLifecycleWebhookUrlSchema.nullable().optional(),
});

/** Register or heartbeat a per-developer preview URL (`weld app dev`). */
export const upsertUserAppDevSessionSchema = z.object({
  url: z.string().url().max(2000),
  /**
   * Clerk user id that should see the preview in the platform iframe.
   * Required when the caller is a workspace API key (no user on the session).
   */
  userId: z.string().min(1).max(255).optional(),
});

/** Submit an app for public-store review. */
export const submitUserAppSchema = z.object({
  notes: z.string().max(2000).optional(),
});

/** Review decision (platform staff). */
export const reviewUserAppSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  notes: z.string().max(2000).optional(),
});

/** Create a version: manifest + uploaded files manifest-of-files. Files are
 *  uploaded as multipart alongside this JSON payload. */
export const createUserAppVersionSchema = z.object({
  manifest: userAppManifestSchema,
  changelog: z.string().max(5000).optional(),
});

export const installUserAppSchema = z.object({
  /** Scopes the admin consents to — must cover the manifest's requested scopes. */
  grantedScopes: z.array(scopeSchema).max(50).default([]),
});

export const consentUserAppScopesSchema = z.object({
  /** Pending scopes being approved after an update requested new ones. */
  approvedScopes: z.array(scopeSchema).max(50),
});

// ---------------------------------------------------------------------------
// App storage (external-api /v1/app-storage)
// ---------------------------------------------------------------------------

export const appRecordCreateSchema = z.object({
  data: z.record(z.unknown()),
});

export const appRecordUpdateSchema = z.object({
  data: z.record(z.unknown()),
});

export const appRecordListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  /** jsonb containment filter, e.g. {"status":"open"} (JSON-encoded). */
  filter: z.string().optional(),
});

export const appKvSetSchema = z.object({
  value: z.unknown(),
});

// ---------------------------------------------------------------------------
// Preview URL allowlist (`weld app dev`)
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return (
    host.endsWith('.trycloudflare.com') ||
    host.endsWith('.ngrok-free.app') ||
    host.endsWith('.ngrok.app') ||
    host.endsWith('.ngrok.io') ||
    host.endsWith('.pages.dev')
  );
}

/**
 * True when `raw` is a URL the iframe host may load instead of the R2 bundle.
 * Loopback (http or https) and a short list of HTTPS tunnel / preview hosts.
 */
export function isAllowedDevSessionUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host);
  if (parsed.protocol === 'http:') return loopback;
  if (parsed.protocol !== 'https:') return false;
  return hostnameAllowed(host);
}

/** How long a preview session stays valid without a CLI heartbeat. */
export const DEV_SESSION_TTL_MS = 5 * 60 * 1000;
