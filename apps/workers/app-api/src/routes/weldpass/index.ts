/**
 * WeldPass routes — /api/weldpass/*, encrypted secret vaults with push sync to
 * Cloudflare Workers, Cloudflare Pages and Vercel.
 *
 * Permissions (see packages/core/permissions/src/catalog.ts):
 *   secrets:read    list keys, metadata, sync targets, versions
 *   secrets:reveal  decrypt a value; export an environment
 *   secrets:create  add secrets and vault projects
 *   secrets:update  edit and restore secrets
 *   secrets:delete  delete secrets
 *   secrets:sync    push an environment to a deploy target
 *   secrets:manage  environments, sync targets, provider tokens, audit log
 *
 * `read` and `reveal` are deliberately separate, so a developer can manage the
 * inventory without ever reading production credentials.
 *
 * Registered as EXEMPT in _event-coverage.test.ts: WeldPass keeps its own audit
 * trail (`weldpass_audit_events`) rather than publishing to the entity-event
 * bus. That bus feeds workflows, analytics and AI agents, and neither secret
 * metadata nor production credential names belong in any of them.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { schema } from '../../db';
import { auditContextFrom, recordAudit } from '../../services/weldpass/audit';
import {
  createCredential,
  deleteCredential,
  listCredentials,
  requireCredential,
  updateCredential,
  verifyCredential,
} from '../../services/weldpass/credentials';
import { parseDotenv, renderDotenv } from '../../services/weldpass/dotenv';
import { listProviders, redeployNotice } from '../../services/weldpass/providers';
import {
  deleteSecret,
  importSecrets,
  listSecretKeys,
  listSecrets,
  listVersions,
  readEnvironmentValues,
  requireSecret,
  restoreVersion,
  revealSecret,
  upsertSecret,
} from '../../services/weldpass/secrets';
import {
  createSyncTarget,
  deleteSyncTarget,
  listSyncRuns,
  listSyncTargets,
  pushAutoTargets,
  pushToTarget,
  requireSyncTarget,
  updateSyncTarget,
} from '../../services/weldpass/sync';
import {
  createEnvironment,
  createProject,
  deleteEnvironment,
  deleteProject,
  findProjectBySlug,
  listEnvironments,
  listProjects,
  requireEnvironment,
  requireProject,
  slugify,
  updateEnvironment,
  updateProject,
} from '../../services/weldpass/vault';
import { environmentFor, keyring, toWeldPassErrorResponse, vaultFor } from './helpers';
import { syncTargetConfigSchema } from './sync-config';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const SECRETS_BASE = '/projects/:projectId/environments/:environmentId/secrets';

/**
 * Error boundary for the whole WeldPass surface.
 *
 * The services throw typed domain errors (vault not found, unusable secret key,
 * provider failure, undecryptable vault) and this turns them into the standard
 * envelope, so the handlers stay free of repetitive try/catch.
 *
 * It has to be `onError`, not a `use('*')` try/catch: Hono's compose hands a
 * thrown error to the app's error handler directly, so an upstream middleware's
 * `await next()` never sees it. A sub-app's `onError` does survive
 * `parent.route()` — and takes precedence over the parent's — which is why the
 * router can own this rather than leaning on app-api's global handler. That
 * precedence also means anything *not* ours has to get the same treatment the
 * global handler would give it, hence the fallback below.
 */
app.onError((err, c) => {
  const response = toWeldPassErrorResponse(err, c);
  if (response) return response;

  console.error('[weldpass] unhandled error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }, 500);
});

// ---------------------------------------------------------------------------
// Schemas (Zod v3, per the monorepo rule)
// ---------------------------------------------------------------------------

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(60).optional(),
  description: z.string().max(2000).nullish(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).nullish(),
});

const createEnvironmentSchema = z.object({
  name: z.string().min(1).max(60),
  slug: z.string().min(1).max(40).optional(),
  isProduction: z.boolean().optional(),
});

const updateEnvironmentSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  isProduction: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const upsertSecretSchema = z.object({
  key: z.string().min(1).max(255),
  value: z.string().max(64 * 1024),
  note: z.string().max(1000).nullish(),
});

const patchSecretSchema = z.object({
  value: z
    .string()
    .max(64 * 1024)
    .optional(),
  note: z.string().max(1000).nullish(),
});

const importSchema = z.object({
  /** Raw `.env` text. */
  content: z.string().max(1024 * 1024),
  /** Remove keys in this environment that the file does not mention. */
  replace: z.boolean().optional(),
});

const restoreSchema = z.object({ version: z.number().int().min(1) });

const credentialMetadataSchema = z.object({
  accountId: z.string().max(100).optional(),
  teamId: z.string().max(100).optional(),
});

const createCredentialSchema = z.object({
  provider: z.enum(['cloudflare_workers', 'cloudflare_pages', 'vercel']),
  name: z.string().min(1).max(100),
  token: z.string().min(1).max(4096),
  metadata: credentialMetadataSchema.optional(),
});

const updateCredentialSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  token: z.string().min(1).max(4096).optional(),
  metadata: credentialMetadataSchema.optional(),
});

const verifyCredentialSchema = z.object({ config: syncTargetConfigSchema });

const createTargetSchema = z.object({
  environmentId: z.string().min(1).max(30),
  credentialId: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  config: syncTargetConfigSchema,
  autoSync: z.boolean().optional(),
  prune: z.boolean().optional(),
});

const updateTargetSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  credentialId: z.string().min(1).max(30).optional(),
  config: syncTargetConfigSchema.optional(),
  autoSync: z.boolean().optional(),
  prune: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

app.get('/providers', requirePermission('secrets:read'), (c) => success(c, listProviders()));

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

app.get('/projects', requirePermission('secrets:read'), async (c) => {
  const db = c.get('tenantDb');
  const projects = await listProjects(db, c.get('workspaceId'));

  const withEnvironments = await Promise.all(
    projects.map(async (project) => {
      const environments = await listEnvironments(db, project.id);
      const keys = await listSecretKeys(
        db,
        environments.map((environment) => environment.id),
      );
      return {
        ...project,
        environments: environments.map((environment) => ({
          ...environment,
          secretCount: keys.get(environment.id)?.length ?? 0,
        })),
      };
    }),
  );

  return success(c, withEnvironments);
});

app.post(
  '/projects',
  requirePermission('secrets:create', 'secrets:manage'),
  zValidator('json', createProjectSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');
    const body = c.req.valid('json');
    const userId = c.get('userId');

    const slug = slugify(body.slug ?? body.name);
    if (await findProjectBySlug(db, workspaceId, slug)) {
      return error.conflict(c, `A project with the slug "${slug}" already exists.`);
    }

    const { project, environments } = await createProject(db, workspaceId, keyring(c), {
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
      createdBy: userId,
    });

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      actorId: userId,
      action: 'project.created',
      targetKey: project.slug,
    });

    return success(c, { ...project, environments }, 201);
  },
);

app.get('/projects/:projectId', requirePermission('secrets:read'), async (c) => {
  const db = c.get('tenantDb');
  const project = await requireProject(db, c.get('workspaceId'), c.req.param('projectId'));
  const environments = await listEnvironments(db, project.id);
  const keys = await listSecretKeys(
    db,
    environments.map((environment) => environment.id),
  );

  return success(c, {
    ...project,
    environments: environments.map((environment) => ({
      ...environment,
      secretCount: keys.get(environment.id)?.length ?? 0,
    })),
  });
});

app.patch(
  '/projects/:projectId',
  requirePermission('secrets:update', 'secrets:manage'),
  zValidator('json', updateProjectSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const projectId = c.req.param('projectId');
    const project = await updateProject(
      db,
      c.get('workspaceId'),
      projectId,
      c.req.valid('json'),
    );

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId,
      actorId: c.get('userId'),
      action: 'project.updated',
      targetKey: project.slug,
    });

    return success(c, project);
  },
);

app.delete(
  '/projects/:projectId',
  requirePermission('secrets:delete', 'secrets:manage'),
  async (c) => {
    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');
    const projectId = c.req.param('projectId');
    const project = await requireProject(db, workspaceId, projectId);

    await deleteProject(db, workspaceId, projectId);
    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId,
      actorId: c.get('userId'),
      action: 'project.deleted',
      targetKey: project.slug,
    });

    return noContent(c);
  },
);

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

app.get(
  '/projects/:projectId/environments',
  requirePermission('secrets:read'),
  async (c) => {
    const db = c.get('tenantDb');
    const project = await requireProject(db, c.get('workspaceId'), c.req.param('projectId'));
    return success(c, await listEnvironments(db, project.id));
  },
);

app.post(
  '/projects/:projectId/environments',
  requirePermission('secrets:manage'),
  zValidator('json', createEnvironmentSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const project = await requireProject(db, c.get('workspaceId'), c.req.param('projectId'));
    const body = c.req.valid('json');

    const slug = slugify(body.slug ?? body.name);
    const existing = await listEnvironments(db, project.id);
    if (existing.some((environment) => environment.slug === slug)) {
      return error.conflict(c, `This project already has an environment named "${slug}".`);
    }

    const environment = await createEnvironment(db, project.id, body);
    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: environment.id,
      actorId: c.get('userId'),
      action: 'environment.created',
      targetKey: environment.slug,
    });

    return success(c, environment, 201);
  },
);

app.patch(
  '/projects/:projectId/environments/:environmentId',
  requirePermission('secrets:manage'),
  zValidator('json', updateEnvironmentSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const project = await requireProject(db, c.get('workspaceId'), c.req.param('projectId'));
    const environment = await updateEnvironment(
      db,
      project.id,
      c.req.param('environmentId'),
      c.req.valid('json'),
    );

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: environment.id,
      actorId: c.get('userId'),
      action: 'environment.updated',
      targetKey: environment.slug,
    });

    return success(c, environment);
  },
);

app.delete(
  '/projects/:projectId/environments/:environmentId',
  requirePermission('secrets:manage'),
  async (c) => {
    const db = c.get('tenantDb');
    const project = await requireProject(db, c.get('workspaceId'), c.req.param('projectId'));
    const environmentId = c.req.param('environmentId');

    await deleteEnvironment(db, project.id, environmentId);
    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId,
      actorId: c.get('userId'),
      action: 'environment.deleted',
    });

    return noContent(c);
  },
);

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

app.get(SECRETS_BASE, requirePermission('secrets:read'), async (c) => {
  const { db, environment } = await environmentFor(c);
  return success(c, await listSecrets(db, environment.id));
});

app.post(
  SECRETS_BASE,
  requirePermission('secrets:create', 'secrets:manage'),
  zValidator('json', upsertSecretSchema),
  async (c) => {
    const { db, project, environment, kek } = await environmentFor(c);
    const body = c.req.valid('json');
    const userId = c.get('userId');

    const result = await upsertSecret(db, kek, {
      projectId: project.id,
      environmentId: environment.id,
      key: body.key,
      value: body.value,
      note: body.note ?? null,
      actorId: userId,
    });

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: environment.id,
      secretId: result.secret.id,
      actorId: userId,
      action: result.created ? 'secret.created' : 'secret.updated',
      targetKey: body.key,
      metadata: { changed: result.changed },
    });

    const autoSync = result.changed
      ? await runAutoSync(c, project.id, environment.id, kek)
      : [];

    return success(
      c,
      { secret: result.secret, created: result.created, autoSync },
      result.created ? 201 : 200,
    );
  },
);

app.patch(
  `${SECRETS_BASE}/:secretId`,
  requirePermission('secrets:update', 'secrets:manage'),
  zValidator('json', patchSecretSchema),
  async (c) => {
    const { db, project, environment, kek } = await environmentFor(c);
    const body = c.req.valid('json');
    const userId = c.get('userId');

    if (body.value === undefined && body.note === undefined) {
      return error.badRequest(c, 'Provide a value, a note, or both.');
    }

    const existing = await requireSecret(db, environment.id, c.req.param('secretId'));

    // A note-only edit still has to re-seal, because the value is only ever
    // written whole — so the current value is read back first.
    const value = body.value ?? (await revealSecret(db, kek, environment.id, existing.id)).value;

    const result = await upsertSecret(db, kek, {
      projectId: project.id,
      environmentId: environment.id,
      key: existing.key,
      value,
      note: body.note,
      actorId: userId,
    });

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: environment.id,
      secretId: existing.id,
      actorId: userId,
      action: 'secret.updated',
      targetKey: existing.key,
      metadata: { changed: result.changed, valueChanged: body.value !== undefined },
    });

    const autoSync = result.changed
      ? await runAutoSync(c, project.id, environment.id, kek)
      : [];

    return success(c, { secret: result.secret, autoSync });
  },
);

app.get(`${SECRETS_BASE}/:secretId/reveal`, requirePermission('secrets:reveal'), async (c) => {
  const { db, project, environment, kek } = await environmentFor(c);
  const { secret, value } = await revealSecret(db, kek, environment.id, c.req.param('secretId'));

  await recordAudit(db, auditContextFrom(c.req.raw.headers), {
    projectId: project.id,
    environmentId: environment.id,
    secretId: secret.id,
    actorId: c.get('userId'),
    action: 'secret.revealed',
    targetKey: secret.key,
  });

  return success(c, { ...secret, value });
});

app.get(`${SECRETS_BASE}/:secretId/versions`, requirePermission('secrets:read'), async (c) => {
  const { db, environment } = await environmentFor(c);
  const secret = await requireSecret(db, environment.id, c.req.param('secretId'));
  return success(c, await listVersions(db, secret.id));
});

app.post(
  `${SECRETS_BASE}/:secretId/restore`,
  requirePermission('secrets:update', 'secrets:manage'),
  zValidator('json', restoreSchema),
  async (c) => {
    const { db, project, environment, kek } = await environmentFor(c);
    const { version } = c.req.valid('json');
    const userId = c.get('userId');

    const secret = await restoreVersion(
      db,
      environment.id,
      c.req.param('secretId'),
      version,
      userId,
    );

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: environment.id,
      secretId: secret.id,
      actorId: userId,
      action: 'secret.restored',
      targetKey: secret.key,
      metadata: { restoredFrom: version },
    });

    const autoSync = await runAutoSync(c, project.id, environment.id, kek);
    return success(c, { secret, autoSync });
  },
);

app.delete(
  `${SECRETS_BASE}/:secretId`,
  requirePermission('secrets:delete', 'secrets:manage'),
  async (c) => {
    const { db, project, environment, kek } = await environmentFor(c);
    const userId = c.get('userId');

    const secret = await deleteSecret(db, environment.id, c.req.param('secretId'), userId);

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: environment.id,
      secretId: secret.id,
      actorId: userId,
      action: 'secret.deleted',
      targetKey: secret.key,
    });

    // A deleted key only disappears from a target if that target prunes; the
    // auto-sync still runs so the remaining values stay in step.
    await runAutoSync(c, project.id, environment.id, kek);
    return noContent(c);
  },
);

app.post(
  `${SECRETS_BASE}/import`,
  requirePermission('secrets:create', 'secrets:manage'),
  zValidator('json', importSchema),
  async (c) => {
    const { db, project, environment, kek } = await environmentFor(c);
    const body = c.req.valid('json');
    const userId = c.get('userId');

    const parsed = parseDotenv(body.content);
    if (Object.keys(parsed.values).length === 0) {
      return error.badRequest(c, 'No variables found in that file.', { skipped: parsed.skipped });
    }

    const result = await importSecrets(db, kek, {
      projectId: project.id,
      environmentId: environment.id,
      values: parsed.values,
      actorId: userId,
    });

    const removed: string[] = [];
    if (body.replace) {
      for (const existing of await listSecrets(db, environment.id)) {
        if (!(existing.key in parsed.values)) {
          await deleteSecret(db, environment.id, existing.id, userId);
          removed.push(existing.key);
        }
      }
    }

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: environment.id,
      actorId: userId,
      action: 'secrets.imported',
      metadata: {
        created: result.created.length,
        updated: result.updated.length,
        unchanged: result.unchanged.length,
        removed: removed.length,
        skippedLines: parsed.skipped.length,
      },
    });

    const autoSync = await runAutoSync(c, project.id, environment.id, kek);
    return success(c, { ...result, removed, skipped: parsed.skipped, autoSync });
  },
);

app.get(`${SECRETS_BASE}/export`, requirePermission('secrets:reveal'), async (c) => {
  const { db, project, environment, kek } = await environmentFor(c);
  const values = await readEnvironmentValues(db, kek, environment.id);

  await recordAudit(db, auditContextFrom(c.req.raw.headers), {
    projectId: project.id,
    environmentId: environment.id,
    actorId: c.get('userId'),
    action: 'secret.exported',
    metadata: { keyCount: Object.keys(values).length, format: c.req.query('format') ?? 'json' },
  });

  if (c.req.query('format') === 'dotenv') {
    return c.text(renderDotenv(values), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${project.slug}.${environment.slug}.env"`,
    });
  }

  return success(c, values);
});

// ---------------------------------------------------------------------------
// Provider credentials
// ---------------------------------------------------------------------------

app.get('/projects/:projectId/credentials', requirePermission('secrets:manage'), async (c) => {
  const { db, project } = await vaultFor(c);
  return success(c, await listCredentials(db, project.id));
});

app.post(
  '/projects/:projectId/credentials',
  requirePermission('secrets:manage'),
  zValidator('json', createCredentialSchema),
  async (c) => {
    const { db, project, kek } = await vaultFor(c);
    const body = c.req.valid('json');
    const userId = c.get('userId');

    const credential = await createCredential(db, kek, {
      projectId: project.id,
      provider: body.provider,
      name: body.name,
      token: body.token,
      metadata: body.metadata,
      actorId: userId,
    });

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      actorId: userId,
      action: 'credential.created',
      targetKey: credential.name,
      metadata: { provider: credential.provider },
    });

    return success(c, credential, 201);
  },
);

app.patch(
  '/projects/:projectId/credentials/:credentialId',
  requirePermission('secrets:manage'),
  zValidator('json', updateCredentialSchema),
  async (c) => {
    const { db, project, kek } = await vaultFor(c);
    const body = c.req.valid('json');

    const credential = await updateCredential(db, kek, {
      projectId: project.id,
      credentialId: c.req.param('credentialId'),
      name: body.name,
      token: body.token,
      metadata: body.metadata,
    });

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      actorId: c.get('userId'),
      action: 'credential.updated',
      targetKey: credential.name,
      metadata: { tokenReplaced: body.token !== undefined },
    });

    return success(c, credential);
  },
);

app.post(
  '/projects/:projectId/credentials/:credentialId/verify',
  requirePermission('secrets:manage'),
  zValidator('json', verifyCredentialSchema),
  async (c) => {
    const { db, project, kek } = await vaultFor(c);

    const result = await verifyCredential(
      db,
      kek,
      project.id,
      c.req.param('credentialId'),
      c.req.valid('json').config,
    );

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      actorId: c.get('userId'),
      action: 'credential.verified',
      metadata: { ok: result.ok },
    });

    return success(c, result);
  },
);

app.delete(
  '/projects/:projectId/credentials/:credentialId',
  requirePermission('secrets:manage'),
  async (c) => {
    const { db, project } = await vaultFor(c);
    const credentialId = c.req.param('credentialId');
    const credential = await requireCredential(db, project.id, credentialId);

    const { detachedTargets } = await deleteCredential(db, project.id, credentialId);

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      actorId: c.get('userId'),
      action: 'credential.deleted',
      targetKey: credential.name,
      metadata: { detachedTargets },
    });

    return noContent(c);
  },
);

// ---------------------------------------------------------------------------
// Sync targets
// ---------------------------------------------------------------------------

app.get('/projects/:projectId/sync-targets', requirePermission('secrets:read'), async (c) => {
  const { db, project } = await vaultFor(c);
  const targets = await listSyncTargets(db, project.id, c.req.query('environmentId'));
  return success(
    c,
    targets.map((target) => ({ ...target, redeployNotice: redeployNotice(target.config) })),
  );
});

app.post(
  '/projects/:projectId/sync-targets',
  requirePermission('secrets:manage'),
  zValidator('json', createTargetSchema),
  async (c) => {
    const { db, project } = await vaultFor(c);
    const body = c.req.valid('json');
    const userId = c.get('userId');

    // Both references have to belong to this project, or a target could be
    // pointed at another vault's credential by id.
    const environment = await requireEnvironment(db, project.id, body.environmentId);
    const credential = await requireCredential(db, project.id, body.credentialId);

    if (credential.provider !== body.config.provider) {
      return error.badRequest(
        c,
        `That credential is for ${credential.provider}, but the target is configured for ${body.config.provider}.`,
      );
    }

    const target = await createSyncTarget(db, {
      projectId: project.id,
      environmentId: environment.id,
      credentialId: credential.id,
      provider: body.config.provider,
      name: body.name,
      config: body.config,
      autoSync: body.autoSync,
      prune: body.prune,
      actorId: userId,
    });

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: environment.id,
      actorId: userId,
      action: 'sync_target.created',
      targetKey: target.name,
      metadata: { provider: target.provider, autoSync: target.autoSync, prune: target.prune },
    });

    return success(c, { ...target, redeployNotice: redeployNotice(target.config) }, 201);
  },
);

app.patch(
  '/projects/:projectId/sync-targets/:targetId',
  requirePermission('secrets:manage'),
  zValidator('json', updateTargetSchema),
  async (c) => {
    const { db, project } = await vaultFor(c);
    const body = c.req.valid('json');
    const existing = await requireSyncTarget(db, project.id, c.req.param('targetId'));

    if (body.credentialId) {
      const credential = await requireCredential(db, project.id, body.credentialId);
      const provider = body.config?.provider ?? existing.provider;
      if (credential.provider !== provider) {
        return error.badRequest(
          c,
          `That credential is for ${credential.provider}, but the target is configured for ${provider}.`,
        );
      }
    }

    if (body.config && body.config.provider !== existing.provider) {
      return error.badRequest(c, 'A target cannot change provider — create a new target instead.');
    }

    const target = await updateSyncTarget(db, project.id, existing.id, body);

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: target.environmentId,
      actorId: c.get('userId'),
      action: 'sync_target.updated',
      targetKey: target.name,
    });

    return success(c, { ...target, redeployNotice: redeployNotice(target.config) });
  },
);

app.delete(
  '/projects/:projectId/sync-targets/:targetId',
  requirePermission('secrets:manage'),
  async (c) => {
    const { db, project } = await vaultFor(c);
    const targetId = c.req.param('targetId');
    const target = await requireSyncTarget(db, project.id, targetId);

    await deleteSyncTarget(db, project.id, targetId);
    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: target.environmentId,
      actorId: c.get('userId'),
      action: 'sync_target.deleted',
      targetKey: target.name,
    });

    return noContent(c);
  },
);

/** What a push would send, without decrypting anything. */
app.get(
  '/projects/:projectId/sync-targets/:targetId/preview',
  requirePermission('secrets:read'),
  async (c) => {
    const { db, project } = await vaultFor(c);
    const target = await requireSyncTarget(db, project.id, c.req.param('targetId'));
    const keys = await listSecretKeys(db, [target.environmentId]);

    return success(c, {
      targetId: target.id,
      environmentId: target.environmentId,
      keys: keys.get(target.environmentId) ?? [],
      prune: target.prune,
      redeployNotice: redeployNotice(target.config),
    });
  },
);

app.post(
  '/projects/:projectId/sync-targets/:targetId/push',
  requirePermission('secrets:sync', 'secrets:manage'),
  async (c) => {
    const { db, project, kek } = await vaultFor(c);
    const userId = c.get('userId');

    const outcome = await pushToTarget(db, kek, {
      projectId: project.id,
      targetId: c.req.param('targetId'),
      trigger: 'manual',
      actorId: userId,
    });

    await recordAudit(db, auditContextFrom(c.req.raw.headers), {
      projectId: project.id,
      environmentId: outcome.target.environmentId,
      actorId: userId,
      action: outcome.run.status === 'failed' ? 'sync.failed' : 'sync.pushed',
      targetKey: outcome.target.name,
      metadata: {
        provider: outcome.target.provider,
        pushed: outcome.run.pushed,
        removed: outcome.run.removed,
        failed: outcome.run.failed,
      },
    });

    // A failed push is a reported outcome, not a transport error — the run row
    // exists either way and the client renders both from the same shape.
    return success(c, {
      run: outcome.run,
      target: { ...outcome.target, redeployNotice: redeployNotice(outcome.target.config) },
    });
  },
);

app.get('/projects/:projectId/sync-runs', requirePermission('secrets:read'), async (c) => {
  const { db, project } = await vaultFor(c);
  const limit = Number.parseInt(c.req.query('limit') ?? '25', 10);

  return success(
    c,
    await listSyncRuns(db, project.id, {
      targetId: c.req.query('targetId'),
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 25,
    }),
  );
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/**
 * Reading the trail needs `secrets:manage`, not `secrets:read`: it shows who
 * revealed which key and when, which is exactly the map an attacker with a
 * low-privilege account would want.
 */
app.get('/projects/:projectId/audit', requirePermission('secrets:manage'), async (c) => {
  const { db, project } = await vaultFor(c);
  const t = schema.weldpassAuditEvents;

  const rawLimit = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

  const cursorValue = c.req.query('cursor');
  const before = cursorValue ? new Date(cursorValue) : null;
  const validCursor = before && !Number.isNaN(before.getTime()) ? before : null;

  const rows = await db
    .select({
      id: t.id,
      environmentId: t.environmentId,
      secretId: t.secretId,
      actorId: t.actorId,
      action: t.action,
      targetKey: t.targetKey,
      metadata: t.metadata,
      ip: t.ip,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(
      validCursor
        ? and(eq(t.projectId, project.id), lt(t.createdAt, validCursor))
        : eq(t.projectId, project.id),
    )
    .orderBy(desc(t.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null;

  // The trail is append-only and unbounded, so the count is the page size — a
  // full count would scan the whole table on every request.
  return list(c, page, cursorPagination(page.length, hasMore, cursor));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Push auto-sync targets after a write. Failures are reported in the response
 * rather than thrown: the secret is already saved, and losing that write
 * because Vercel was briefly down would be the wrong trade.
 */
async function runAutoSync(
  c: Parameters<typeof environmentFor>[0],
  projectId: string,
  environmentId: string,
  kek: Uint8Array<ArrayBuffer>,
) {
  try {
    const outcomes = await pushAutoTargets(c.get('tenantDb'), kek, {
      projectId,
      environmentId,
      actorId: c.get('userId'),
    });
    return outcomes.map((outcome) => ({
      targetId: outcome.target.id,
      name: outcome.target.name,
      status: outcome.run.status,
      pushed: outcome.run.pushed,
      error: outcome.run.error,
    }));
  } catch (err) {
    console.error('[weldpass] auto-sync failed', err);
    return [];
  }
}

export { app as weldpassRoutes };
