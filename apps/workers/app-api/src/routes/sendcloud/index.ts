/**
 * Sendcloud integration — /api/sendcloud.
 *
 * Workspace-scoped connection to the merchant's own Sendcloud account
 * (API v3, Basic auth with public + secret keys). Cached sender addresses
 * and shipping options (parcel types) live on
 * `workspace_settings.customSettings.sendcloud`.
 *
 * Permissions: integrations:read|picklists:read (GET) /
 * integrations:create|integrations:update (mutations).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  sendcloudConnectSchema,
  updateSendcloudSettingsSchema,
} from '@weldsuite/app-api-client/schemas/sendcloud';
import type { EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { createSendcloudClient, SendcloudError } from '../../services/sendcloud/client';
import {
  applySendcloudPatches,
  decryptSecret,
  encryptSecret,
  getSendcloudSettings,
  saveSendcloudSettings,
  syncSendcloudCatalog,
  toPublicSettings,
} from '../../services/sendcloud/settings';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function keyringFromEnv(env: Env): EncryptionKeyring {
  return { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
}

function mapSendcloudHttp(c: Parameters<typeof error.badRequest>[0], err: unknown, fallback: string) {
  if (err instanceof SendcloudError) {
    if (err.code === 'UNAUTHORIZED') return error.unauthorized(c, err.message);
    if (err.code === 'PAYMENT_REQUIRED') {
      return c.json({ error: { code: 'PAYMENT_REQUIRED', message: err.message, details: err.details } }, 402);
    }
    if (err.code === 'NOT_FOUND') return error.notFound(c, 'Sendcloud resource');
    if (err.code === 'VALIDATION') return error.badRequest(c, err.message, err.details);
    return error.internal(c, err.message);
  }
  console.error(`[app-api/sendcloud] ${fallback}:`, err);
  return error.internal(c, fallback);
}

async function buildClient(
  stored: Awaited<ReturnType<typeof getSendcloudSettings>>,
  keyring: EncryptionKeyring,
) {
  const publicKey = stored.publicKey;
  const secretKey = await decryptSecret(stored.secretKey, keyring);
  if (!publicKey || !secretKey) return null;
  return createSendcloudClient({ publicKey, secretKey });
}

app.get('/', requirePermission('integrations:read', 'picklists:read'), async (c) => {
  try {
    const stored = await getSendcloudSettings(c.get('tenantDb'), c.get('workspaceId'));
    return success(c, toPublicSettings(stored));
  } catch (err) {
    return mapSendcloudHttp(c, err, 'Failed to load Sendcloud settings');
  }
});

app.put(
  '/connect',
  requirePermission('integrations:create', 'integrations:update'),
  zValidator('json', sendcloudConnectSchema),
  async (c) => {
    const { publicKey, secretKey } = c.req.valid('json');
    try {
      const client = createSendcloudClient({ publicKey, secretKey });
      const keyring = keyringFromEnv(c.env);
      const current = await getSendcloudSettings(c.get('tenantDb'), c.get('workspaceId'));
      const synced = await syncSendcloudCatalog(
        {
          ...current,
          publicKey,
          secretKey: await encryptSecret(secretKey, keyring),
        },
        client,
      );
      await saveSendcloudSettings(c.get('tenantDb'), c.get('workspaceId'), synced);
      return success(c, toPublicSettings(synced));
    } catch (err) {
      return mapSendcloudHttp(c, err, 'Failed to connect Sendcloud');
    }
  },
);

app.post('/sync', requirePermission('integrations:create', 'integrations:update'), async (c) => {
  try {
    const keyring = keyringFromEnv(c.env);
    const stored = await getSendcloudSettings(c.get('tenantDb'), c.get('workspaceId'));
    const client = await buildClient(stored, keyring);
    if (!client) return error.badRequest(c, 'Sendcloud is not connected');
    const synced = await syncSendcloudCatalog(stored, client);
    await saveSendcloudSettings(c.get('tenantDb'), c.get('workspaceId'), synced);
    return success(c, toPublicSettings(synced));
  } catch (err) {
    return mapSendcloudHttp(c, err, 'Failed to sync Sendcloud catalog');
  }
});

app.patch(
  '/',
  requirePermission('integrations:create', 'integrations:update'),
  zValidator('json', updateSendcloudSettingsSchema),
  async (c) => {
    try {
      const stored = await getSendcloudSettings(c.get('tenantDb'), c.get('workspaceId'));
      if (!stored.publicKey || !stored.secretKey) {
        return error.badRequest(c, 'Sendcloud is not connected');
      }
      const next = applySendcloudPatches(stored, c.req.valid('json'));
      await saveSendcloudSettings(c.get('tenantDb'), c.get('workspaceId'), next);
      return success(c, toPublicSettings(next));
    } catch (err) {
      return mapSendcloudHttp(c, err, 'Failed to update Sendcloud settings');
    }
  },
);

app.delete('/', requirePermission('integrations:create', 'integrations:update'), async (c) => {
  try {
    await saveSendcloudSettings(c.get('tenantDb'), c.get('workspaceId'), {
      senders: [],
      methods: [],
    });
    return noContent(c);
  } catch (err) {
    return mapSendcloudHttp(c, err, 'Failed to disconnect Sendcloud');
  }
});

app.get(
  '/labels/:parcelId',
  requirePermission('integrations:read', 'picklists:read'),
  async (c) => {
    const parcelId = Number(c.req.param('parcelId'));
    if (!Number.isFinite(parcelId)) return error.badRequest(c, 'Invalid parcel id');
    try {
      const keyring = keyringFromEnv(c.env);
      const stored = await getSendcloudSettings(c.get('tenantDb'), c.get('workspaceId'));
      const client = await buildClient(stored, keyring);
      if (!client) return error.badRequest(c, 'Sendcloud is not connected');
      const doc = await client.getParcelDocument(parcelId);
      return new Response(doc.bytes, {
        status: 200,
        headers: {
          'Content-Type': doc.contentType,
          'Content-Disposition': `inline; filename="sendcloud-label-${parcelId}.pdf"`,
        },
      });
    } catch (err) {
      return mapSendcloudHttp(c, err, 'Failed to fetch shipping label');
    }
  },
);

export const sendcloudRoutes = app;
