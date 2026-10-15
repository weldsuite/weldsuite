/**
 * Brazilian fiscal documents (NF-e / NFS-e) of invoices and credit notes,
 * issued through Focus NFe: /api/fiscal-documents.
 *
 *   GET  /settings            provider, environment, whether a token is stored, webhook state
 *   PUT  /settings            environment, Focus company token (sealed, never returned), NFS-e standard;
 *                             registers the provider webhooks for the environment
 *   GET  /                    documents, filtered by ?sourceType= &sourceId= &status= &kind=
 *   GET  /:id                 one document with its request and response payloads
 *   POST /issue               { invoiceId } issue the NF-e (goods) or NFS-e (services) of a finalized invoice
 *   POST /:id/refresh         ask the provider for the current status
 *   POST /:id/cancel          { reason } cancel an authorized document (15 to 255 characters)
 *   POST /:id/correction      { text } carta de correção on an authorized NF-e (15 to 1000 characters)
 *
 * Only entities of a jurisdiction with fiscal documents (Brazil) can use any
 * of it. Issue, refresh, cancel and correct need invoices:update; the settings
 * need accounts:read / accounts:update. Every mutation is written to the
 * accounting audit log and published as a `fiscal_document` entity event.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { resolveEntityId } from '../../lib/entity-context';
import { fiscalErrorResponse, FiscalDocumentError } from '../../services/br-fiscal/errors';
import {
  cancelFiscalDocument,
  correctFiscalDocument,
  fiscalDocumentEventData,
  getFiscalDocument,
  issueFiscalDocument,
  listFiscalDocuments,
  refreshFiscalDocument,
  requireFiscalEntity,
  type FiscalDocumentRow,
} from '../../services/br-fiscal/fiscal-documents';
import { FiscalProviderError, FocusClient, FOCUS_BASE_URLS } from '../../services/br-fiscal/focus-client';
import {
  FISCAL_ENVIRONMENTS,
  FISCAL_WEBHOOK_EVENTS,
  fiscalEnvironmentOf,
  fiscalSettingsOf,
  focusClientFor,
  readFiscalCredentials,
  registerFiscalWebhooks,
  removeFiscalWebhooks,
  sealFiscalCredentials,
  type FiscalCredentials,
  type FiscalEntitySettings,
} from '../../services/br-fiscal/settings';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type EntityRow = typeof schema.entities.$inferSelect;

const updateSettingsSchema = z.object({
  environment: z.enum(['homologacao', 'producao']),
  /** The Focus NFe company token of `environment`. null removes the stored one; omitted keeps it. */
  token: z.string().trim().min(8).max(200).nullable().optional(),
  /** Services: the national NFS-e (default) or the municipality's own system. */
  nfseStandard: z.enum(['nacional', 'municipal']).optional(),
  /** NFS-e Nacional DPS series; null resets it to 1. */
  dpsSeries: z.number().int().min(1).max(49_999).nullable().optional(),
  /** Simples Nacional ICMS credit rate printed on NF-e (CSOSN 101), percent; null removes it. */
  simplesCreditRate: z.number().min(0).max(20).nullable().optional(),
  /** Municipal NFS-e: the municipality's own service code; null removes it. */
  codigoTributarioMunicipio: z.string().trim().max(20).nullable().optional(),
});

const issueSchema = z.object({ invoiceId: z.string().min(1).max(30) });
const cancelSchema = z.object({ reason: z.string().trim().min(15).max(255) });
const correctionSchema = z.object({ text: z.string().trim().min(15).max(1000) });

/** The accounting entity of the request, which must be in a jurisdiction with fiscal documents. */
async function requireEntity(c: AppContext, db: Database): Promise<EntityRow> {
  const entityId = await resolveEntityId(c, db);
  if (!entityId) {
    throw new FiscalDocumentError('No accounting entity resolved. Set X-Accounting-Entity-Id or configure a default entity.');
  }
  return requireFiscalEntity(db, entityId);
}

/** What the document list shows: the payloads (request body, provider answer) stay on the detail view. */
function documentSummary(doc: FiscalDocumentRow) {
  const { requestPayload, responsePayload, ...rest } = doc;
  return rest;
}

async function settingsPayload(entity: EntityRow, env: Env) {
  const settings = fiscalSettingsOf(entity);
  const environment = fiscalEnvironmentOf(settings);
  let credentials: FiscalCredentials = {};
  let credentialsReadable = true;
  try {
    credentials = await readFiscalCredentials(entity, env);
  } catch (err) {
    if (!(err instanceof FiscalDocumentError)) throw err;
    credentialsReadable = false;
  }
  const webhook = settings.fiscalWebhook?.[environment];
  return {
    entityId: entity.id,
    provider: 'focus_nfe' as const,
    environment,
    environments: FISCAL_ENVIRONMENTS,
    hasCredentials: Boolean(credentials[environment]),
    credentialEnvironments: FISCAL_ENVIRONMENTS.filter((e) => Boolean(credentials[e])),
    credentialsReadable,
    nfseStandard: settings.nfseStandard ?? 'nacional',
    dpsSeries: settings.dpsSeries ?? null,
    simplesCreditRate: settings.simplesCreditRate ?? null,
    codigoTributarioMunicipio: settings.codigoTributarioMunicipio ?? null,
    webhook: {
      registered: Boolean(webhook && webhook.hooks.length > 0),
      events: webhook?.hooks.map((h) => h.event) ?? [],
      supportedEvents: FISCAL_WEBHOOK_EVENTS,
      registeredAt: webhook?.registeredAt ?? null,
    },
    providerUrl: FOCUS_BASE_URLS[environment],
  };
}

async function auditAndPublish(
  c: AppContext,
  db: Database,
  doc: FiscalDocumentRow,
  action: 'created' | 'updated' | 'cancelled',
  auditAction: string,
  changes?: Record<string, { old: unknown; new: unknown }>,
) {
  await writeAccountingAudit(c, db, {
    accountingEntityId: doc.entityId,
    entityType: 'fiscal_document',
    entityId: doc.id,
    action: auditAction,
    changes,
  });
  publishEntityEvent({ c, entityType: 'fiscal_document', entityId: doc.id, action, data: fiscalDocumentEventData(doc) });
}

// GET /settings
app.get('/settings', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireEntity(c, db);
    return success(c, await settingsPayload(entity, c.env));
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/fiscal-documents] get settings failed:', err);
    return error.internal(c, 'Failed to fetch the fiscal settings');
  }
});

type SettingsUpdate = z.infer<typeof updateSettingsSchema>;

/** The state a settings update builds up before it is saved. */
interface PendingSettings {
  entity: EntityRow;
  /** The stored settings. */
  settings: FiscalEntitySettings;
  /** The settings being saved. */
  nextSettings: FiscalEntitySettings;
  credentials: FiscalCredentials;
  environment: SettingsUpdate['environment'];
  warnings: string[];
  webhookUrl: string | null;
}

async function readCredentialsForUpdate(entity: EntityRow, env: Env, token: SettingsUpdate['token']): Promise<FiscalCredentials> {
  try {
    return await readFiscalCredentials(entity, env);
  } catch (err) {
    // An unreadable blob is replaced by the token being entered now.
    if (!(err instanceof FiscalDocumentError) || token === undefined) throw err;
    return {};
  }
}

/** The stored settings with the non-credential fields of the update applied. */
function applySettingsUpdate(settings: FiscalEntitySettings, data: SettingsUpdate): FiscalEntitySettings {
  const nextSettings: FiscalEntitySettings = { ...settings, fiscalProvider: 'focus_nfe', fiscalEnvironment: data.environment };
  if (data.nfseStandard) nextSettings.nfseStandard = data.nfseStandard;
  for (const key of ['dpsSeries', 'simplesCreditRate', 'codigoTributarioMunicipio'] as const) {
    const value = data[key];
    if (value === null || value === '') delete nextSettings[key];
    else if (value !== undefined) (nextSettings as Record<string, unknown>)[key] = value;
  }
  return nextSettings;
}

/**
 * Stores a new Focus token for the environment after Focus accepted it, and
 * registers the provider webhooks. Returns the error response when the update
 * cannot go ahead, null otherwise.
 */
async function storeToken(c: AppContext, pending: PendingSettings, token: string): Promise<Response | null> {
  const { entity, settings, nextSettings, credentials, environment, warnings } = pending;
  const client = new FocusClient({ token, environment });
  // The hooks list doubles as the check that Focus accepts the token.
  try {
    await client.listHooks();
  } catch (err) {
    if (err instanceof FiscalProviderError && err.isAuthFailure) {
      return error.badRequest(c, 'Focus NFe rejected this token. Copy the company token of the matching environment.');
    }
    throw err;
  }
  credentials[environment] = token;
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  try {
    const registered = await registerFiscalWebhooks({
      client,
      env: c.env,
      orgId,
      entityId: entity.id,
      environment,
      baseUrl: c.env.BOOKS_API_URL || new URL(c.req.url).origin,
      previous: settings.fiscalWebhook?.[environment],
    });
    nextSettings.fiscalWebhook = { ...settings.fiscalWebhook, [environment]: registered.config };
    pending.webhookUrl = registered.url;
    warnings.push(...registered.failures.map((f) => `Webhook not registered for ${f}`));
  } catch (err) {
    if (!(err instanceof FiscalProviderError)) throw err;
    // The token works, the hooks do not: issuing still works, statuses then need a manual refresh.
    warnings.push(`The webhooks could not be registered (${err.detail}). Use refresh on a document to fetch its status.`);
  }
  return null;
}

/** Removes the environment's token and its provider webhooks. */
async function removeToken(env: Env, pending: PendingSettings): Promise<void> {
  const { entity, settings, nextSettings, credentials, environment } = pending;
  let client = null;
  try {
    client = await focusClientFor(entity, env, environment);
  } catch (err) {
    if (!(err instanceof FiscalDocumentError)) throw err;
  }
  await removeFiscalWebhooks(client, env, settings.fiscalWebhook?.[environment]);
  delete credentials[environment];
  const remaining = { ...settings.fiscalWebhook };
  delete remaining[environment];
  nextSettings.fiscalWebhook = remaining;
}

// PUT /settings
app.put('/settings', requirePermission('accounts:update'), zValidator('json', updateSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireEntity(c, db);
    const settings = fiscalSettingsOf(entity);
    const previousEnvironment = fiscalEnvironmentOf(settings);
    const environment = data.environment;

    const credentials = await readCredentialsForUpdate(entity, c.env, data.token);
    const nextSettings = applySettingsUpdate(settings, data);
    const pending: PendingSettings = { entity, settings, nextSettings, credentials, environment, warnings: [], webhookUrl: null };

    if (typeof data.token === 'string') {
      const rejected = await storeToken(c, pending, data.token);
      if (rejected) return rejected;
    } else if (data.token === null) {
      await removeToken(c.env, pending);
    }
    const { warnings, webhookUrl } = pending;

    const credentialsChanged = data.token !== undefined;
    const sealed = credentialsChanged ? await sealFiscalCredentials(credentials, c.env) : undefined;
    await db
      .update(schema.entities)
      .set({
        jurisdictionSettings: nextSettings as Record<string, unknown>,
        ...(credentialsChanged ? { fiscalCredentialsEncrypted: sealed } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.entities.id, entity.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'accounting_entity',
      entityId: entity.id,
      action: 'fiscal_settings',
      changes: {
        fiscalEnvironment: { old: previousEnvironment, new: environment },
        fiscalCredentialsChanged: { old: null, new: credentialsChanged },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'accounting_entity',
      entityId: entity.id,
      action: 'updated',
      data: { id: entity.id, fiscalEnvironment: environment },
    });

    const updated: EntityRow = {
      ...entity,
      jurisdictionSettings: nextSettings as Record<string, unknown>,
      ...(credentialsChanged ? { fiscalCredentialsEncrypted: sealed ?? null } : {}),
    };
    return success(c, { ...(await settingsPayload(updated, c.env)), webhookUrl, warnings });
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/fiscal-documents] update settings failed:', err instanceof Error ? err.message : 'unknown error');
    return error.internal(c, 'Failed to update the fiscal settings');
  }
});

// GET / — documents of the entity, or of one invoice (?sourceType=invoice&sourceId=...)
app.get('/', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const page = Math.max(Number.parseInt(c.req.query('page') || '1', 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(c.req.query('pageSize') || '25', 10) || 25, 1), 100);
  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list: not an error.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));
    const { rows, totalCount } = await listFiscalDocuments(
      db,
      entityId,
      {
        sourceType: c.req.query('sourceType') || undefined,
        sourceId: c.req.query('sourceId') || undefined,
        status: c.req.query('status') || undefined,
        kind: c.req.query('kind') || undefined,
      },
      { limit: pageSize, offset: (page - 1) * pageSize },
    );
    return list(c, rows.map(documentSummary), cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[books-api/fiscal-documents] list failed:', err);
    return error.internal(c, 'Failed to fetch fiscal documents');
  }
});

// GET /:id
app.get('/:id', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.notFound(c, 'Fiscal document', c.req.param('id'));
    return success(c, await getFiscalDocument(db, entityId, c.req.param('id')));
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/fiscal-documents] get failed:', err);
    return error.internal(c, 'Failed to fetch the fiscal document');
  }
});

// POST /issue
app.post('/issue', requirePermission('invoices:update'), zValidator('json', issueSchema), async (c) => {
  const db = c.get('tenantDb');
  const { invoiceId } = c.req.valid('json');
  try {
    const entity = await requireEntity(c, db);
    const { document } = await issueFiscalDocument(db, c.env, { entityId: entity.id, invoiceId, userId: c.get('userId') });
    await auditAndPublish(c, db, document, 'created', 'issued', { status: { old: null, new: document.status } });
    return success(c, document, 201);
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/fiscal-documents] issue failed:', err);
    return error.internal(c, 'Failed to issue the fiscal document');
  }
});

// POST /:id/refresh
app.post('/:id/refresh', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireEntity(c, db);
    const doc = await getFiscalDocument(db, entity.id, c.req.param('id'));
    const { document, changed, previousStatus } = await refreshFiscalDocument(db, c.env, doc);
    if (changed) {
      await auditAndPublish(c, db, document, document.status === 'cancelled' ? 'cancelled' : 'updated', 'refreshed', {
        status: { old: previousStatus, new: document.status },
      });
    }
    return success(c, document);
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/fiscal-documents] refresh failed:', err);
    return error.internal(c, 'Failed to refresh the fiscal document');
  }
});

// POST /:id/cancel
app.post('/:id/cancel', requirePermission('invoices:update'), zValidator('json', cancelSchema), async (c) => {
  const db = c.get('tenantDb');
  const { reason } = c.req.valid('json');
  try {
    const entity = await requireEntity(c, db);
    const doc = await getFiscalDocument(db, entity.id, c.req.param('id'));
    const document = await cancelFiscalDocument(db, c.env, doc, reason);
    await auditAndPublish(c, db, document, 'cancelled', 'cancelled', {
      status: { old: doc.status, new: document.status },
      cancelReason: { old: null, new: reason },
    });
    return success(c, document);
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/fiscal-documents] cancel failed:', err);
    return error.internal(c, 'Failed to cancel the fiscal document');
  }
});

// POST /:id/correction — carta de correção (NF-e)
app.post('/:id/correction', requirePermission('invoices:update'), zValidator('json', correctionSchema), async (c) => {
  const db = c.get('tenantDb');
  const { text } = c.req.valid('json');
  try {
    const entity = await requireEntity(c, db);
    const doc = await getFiscalDocument(db, entity.id, c.req.param('id'));
    const { document, correction } = await correctFiscalDocument(db, c.env, doc, text);
    await auditAndPublish(c, db, document, 'updated', 'corrected', { correction: { old: null, new: { number: correction.number } } });
    return success(c, { document, correction });
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/fiscal-documents] correction failed:', err);
    return error.internal(c, 'Failed to send the correction');
  }
});

export const fiscalDocumentsRoutes = app;
