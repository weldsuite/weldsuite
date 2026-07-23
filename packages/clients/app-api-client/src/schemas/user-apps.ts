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
});

export const updateUserAppSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(),
  category: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
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
