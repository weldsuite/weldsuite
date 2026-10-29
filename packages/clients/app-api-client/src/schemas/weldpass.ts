/**
 * WeldPass secret vaults — response schemas for `/api/weldpass/projects/*`
 * and `/providers`, matching the interfaces in `domains/weldpass.ts`. The
 * conformance suite validates every answer of both backends against these
 * (`@weldsuite/worker-kit/testing/conformance-schemas`). Zod v3.
 *
 * No schema here carries a secret value except `weldpassRevealedSecretSchema`
 * and the export map, the two answers gated on `secrets:reveal`.
 */

import { z } from 'zod';

const timestamp = z.string();

export const weldpassProviderIdSchema = z.enum(['cloudflare_workers', 'cloudflare_pages', 'vercel']);

export const weldpassProviderSchema = z.object({ id: weldpassProviderIdSchema, label: z.string() });

export const weldpassEnvironmentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  slug: z.string(),
  isProduction: z.boolean(),
  sortOrder: z.number().int(),
  /** Present on project reads; absent on the flat environments list. */
  secretCount: z.number().int().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

/** A project without its environments (the update answer). */
export const weldpassProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  rootKeyVersion: z.string(),
  createdBy: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const weldpassProjectSchema = weldpassProjectSummarySchema.extend({
  environments: z.array(weldpassEnvironmentSchema),
});

export const weldpassSecretSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  key: z.string(),
  note: z.string().nullable(),
  version: z.number().int(),
  valueLength: z.number().int(),
  valueHint: z.string().nullable(),
  checksum: z.string(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const weldpassRevealedSecretSchema = weldpassSecretSchema.extend({ value: z.string() });

export const weldpassSecretVersionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  action: z.string(),
  checksum: z.string(),
  createdBy: z.string().nullable(),
  createdAt: timestamp,
});

export const weldpassAutoSyncOutcomeSchema = z.object({
  targetId: z.string(),
  name: z.string(),
  status: z.string(),
  pushed: z.number().int(),
  error: z.string().nullable(),
});

export const weldpassSecretWriteSchema = z.object({
  secret: weldpassSecretSchema,
  created: z.boolean().optional(),
  autoSync: z.array(weldpassAutoSyncOutcomeSchema),
});

const lineNote = z.object({ line: z.number().int(), reason: z.string() });

export const weldpassImportResultSchema = z.object({
  created: z.array(z.string()),
  updated: z.array(z.string()),
  unchanged: z.array(z.string()),
  removed: z.array(z.string()),
  skipped: z.array(lineNote),
  autoSync: z.array(weldpassAutoSyncOutcomeSchema),
});

/** `GET …/secrets/export` as JSON: key → value. */
export const weldpassExportSchema = z.record(z.string());

export const weldpassCredentialSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: weldpassProviderIdSchema,
  name: z.string(),
  metadata: z.object({ accountId: z.string().optional(), teamId: z.string().optional() }),
  lastVerifiedAt: timestamp.nullable(),
  lastVerifyError: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const weldpassVerifyResultSchema = z.object({
  ok: z.boolean(),
  identity: z.string().optional(),
  message: z.string().optional(),
});

export const weldpassSyncTargetConfigSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('cloudflare_workers'), accountId: z.string(), scriptName: z.string() }),
  z.object({
    provider: z.literal('cloudflare_pages'),
    accountId: z.string(),
    projectName: z.string(),
    environment: z.enum(['production', 'preview']),
  }),
  z.object({
    provider: z.literal('vercel'),
    projectId: z.string(),
    teamId: z.string().optional(),
    targets: z.array(z.enum(['production', 'preview', 'development'])),
  }),
]);

export const weldpassSyncTargetSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  credentialId: z.string(),
  provider: weldpassProviderIdSchema,
  name: z.string(),
  config: weldpassSyncTargetConfigSchema,
  autoSync: z.boolean(),
  prune: z.boolean(),
  status: z.string(),
  lastSyncedAt: timestamp.nullable(),
  lastSyncedCount: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  redeployNotice: z.string().nullable(),
});

export const weldpassSyncPreviewSchema = z.object({
  targetId: z.string(),
  environmentId: z.string(),
  keys: z.array(z.string()),
  prune: z.boolean(),
  redeployNotice: z.string().nullable(),
});

export const weldpassSyncRunSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  environmentId: z.string(),
  status: z.string(),
  trigger: z.string(),
  pushed: z.number().int(),
  removed: z.number().int(),
  failed: z.number().int(),
  error: z.string().nullable(),
  details: z.array(
    z.object({
      key: z.string(),
      action: z.enum(['pushed', 'removed', 'skipped', 'failed']),
      message: z.string().optional(),
    }),
  ),
  triggeredBy: z.string().nullable(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
});

export const weldpassPushResultSchema = z.object({
  run: weldpassSyncRunSchema,
  target: weldpassSyncTargetSchema,
});

export const weldpassAuditEventSchema = z.object({
  id: z.string(),
  environmentId: z.string().nullable(),
  secretId: z.string().nullable(),
  actorId: z.string(),
  action: z.string(),
  targetKey: z.string().nullable(),
  metadata: z.record(z.unknown()),
  ip: z.string().nullable(),
  createdAt: timestamp,
});
