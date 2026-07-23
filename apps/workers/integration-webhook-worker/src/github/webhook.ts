/**
 * GitHub App Webhook Receiver — POST /webhooks/github
 *
 * Public route (no Clerk). Authenticated via HMAC-SHA256 (X-Hub-Signature-256)
 * against the App-level webhook secret. Resolves the workspace from the
 * installationId, then:
 *   - installation lifecycle  → updates connection status
 *   - projects_v2_item        → dispatches GithubProjectSyncWorkflow for the link
 *
 * Hosted here (not core-api) as part of consolidating GitHub onto app-api +
 * integration-webhook-worker.
 */

import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env } from '../index';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, schema, type TenantDatabase } from '../db';
import {
  getConnectionByInstallationId,
  getDecryptedWebhookSecret,
  updateConnectionStatus,
} from './connections';

const app = new Hono<{ Bindings: Env }>();

app.post('/github', async (c) => {
  const eventType = c.req.header('X-GitHub-Event');
  const deliveryId = c.req.header('X-GitHub-Delivery') || '';
  const signatureHeader = c.req.header('X-Hub-Signature-256');

  const rawBody = await c.req.arrayBuffer();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
  }

  const installationId = extractInstallationId(payload);
  if (!installationId) {
    return c.json({ received: true }, 202); // ping / no-installation events
  }

  const encryptionKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };
  if (!encryptionKey.v1 && !encryptionKey.v2) {
    console.error('[GitHub Webhook] DATABASE_ENCRYPTION_KEY not configured');
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
  }

  // Resolve workspace (clerkOrgId) from installationId — KV cache + master scan.
  let clerkOrgId: string | null = null;
  const cacheKey = `gh-install:${installationId}`;
  const cached = await c.env.WORKSPACE_CACHE.get(cacheKey);
  if (cached) {
    clerkOrgId = cached;
  } else {
    clerkOrgId = await resolveWorkspaceForInstallation(c.env, installationId);
    if (clerkOrgId) {
      await c.env.WORKSPACE_CACHE.put(cacheKey, clerkOrgId, { expirationTtl: 86400 });
    }
  }

  if (!clerkOrgId) {
    console.warn(`[GitHub Webhook] Unknown installation ${installationId} — ignoring`);
    return c.json({ received: true }, 202);
  }

  let tenantDb: TenantDatabase;
  try {
    tenantDb = await getTenantDbForWorkspace(c.env, clerkOrgId);
  } catch (err) {
    console.error(`[GitHub Webhook] Failed to get tenant DB for ${clerkOrgId}:`, err);
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
  }

  const connection = await getConnectionByInstallationId(tenantDb, installationId);
  if (!connection) {
    console.warn(`[GitHub Webhook] No connection for installation ${installationId}`);
    return c.json({ received: true }, 202);
  }

  // GitHub signs every delivery with the App-level webhook secret, so verify
  // against GITHUB_WEBHOOK_SECRET first; the per-connection secret is a fallback.
  const perConnectionSecret = await getDecryptedWebhookSecret(connection, encryptionKey);
  const secret = c.env.GITHUB_WEBHOOK_SECRET || perConnectionSecret;
  if (!secret) {
    console.error('[GitHub Webhook] No webhook secret available for verification');
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
  }

  const valid = await verifyWebhookSignature(rawBody, signatureHeader, secret);
  if (!valid) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
  }

  c.executionCtx.waitUntil(
    handleEvent(c.env, tenantDb, connection.workspaceId, eventType || '', deliveryId, payload, installationId).catch(
      (err) => console.error(`[GitHub Webhook] Unhandled error (${deliveryId}):`, err),
    ),
  );

  return c.json({ received: true }, 202);
});

// ── Event handling ───────────────────────────────────────────

async function handleEvent(
  env: Env,
  tenantDb: TenantDatabase,
  workspaceId: string,
  eventType: string,
  deliveryId: string,
  payload: Record<string, unknown>,
  installationId: number,
): Promise<void> {
  try {
    switch (eventType) {
      case 'installation': {
        const action = String(payload.action);
        if (action === 'deleted') {
          await updateConnectionStatus(tenantDb, installationId, 'revoked');
        } else if (action === 'suspend') {
          await updateConnectionStatus(tenantDb, installationId, 'suspended');
        } else if (action === 'unsuspend' || action === 'created') {
          await updateConnectionStatus(tenantDb, installationId, 'active');
        }
        break;
      }
      case 'projects_v2_item':
        await handleProjectsV2ItemEvent(env, tenantDb, workspaceId, deliveryId, payload);
        break;
      case 'projects_v2':
        console.log(`[GitHub Webhook] projects_v2 ${String(payload.action)} (delivery: ${deliveryId})`);
        break;
      case 'issues':
        await handleIssuesEvent(env, tenantDb, workspaceId, deliveryId, payload);
        break;
      default:
        console.log(`[GitHub Webhook] Unhandled event type: ${eventType} (delivery: ${deliveryId})`);
    }
  } catch (err) {
    console.error(`[GitHub Webhook] Error handling ${eventType} (${deliveryId}):`, err);
  }
}

async function handleProjectsV2ItemEvent(
  env: Env,
  tenantDb: TenantDatabase,
  workspaceId: string,
  deliveryId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const item = payload.projects_v2_item as { project_node_id?: string } | undefined;
  const projectNodeId = item?.project_node_id;
  if (!projectNodeId) {
    console.log(`[GitHub Webhook] projects_v2_item without project_node_id (delivery: ${deliveryId})`);
    return;
  }

  const [link] = await tenantDb
    .select({ id: schema.githubProjectLinks.id, syncDirection: schema.githubProjectLinks.syncDirection })
    .from(schema.githubProjectLinks)
    .where(
      and(
        eq(schema.githubProjectLinks.workspaceId, workspaceId),
        eq(schema.githubProjectLinks.projectV2NodeId, projectNodeId),
        isNull(schema.githubProjectLinks.deletedAt),
      ),
    )
    .limit(1);

  if (!link) {
    console.log(`[GitHub Webhook] Project ${projectNodeId} not linked in ${workspaceId}, skipping`);
    return;
  }
  if (link.syncDirection === 'outbound') {
    console.log(`[GitHub Webhook] Link ${link.id} is outbound-only, ignoring inbound item event`);
    return;
  }

  // Debounce: collapse a burst of projects_v2_item events into ONE sync per
  // minute per link. A full sync's own writes (creating issues, setting status)
  // fire more projects_v2_item webhooks — without this, that feedback loop spawns
  // hundreds of workflow instances. A per-minute bucket id makes duplicate
  // creates within the window throw (caught + skipped) so only one runs.
  const bucket = Math.floor(Date.now() / 60000);
  try {
    await env.GITHUB_PROJECT_SYNC.create({
      id: `github-project-sync-${link.id}-${bucket}`,
      params: { workspaceId, projectLinkId: link.id, inboundOnly: true },
    });
    console.log(`[GitHub Webhook] Dispatched project sync for link ${link.id} (bucket ${bucket}, delivery ${deliveryId})`);
  } catch {
    // Instance for this link+minute already exists → a sync is already queued/running.
    console.log(`[GitHub Webhook] Sync already queued for link ${link.id} (bucket ${bucket}), skipping delivery ${deliveryId}`);
  }
}

/**
 * An `issues` event (title/body/state edited in GitHub) → re-sync the affected
 * Project link inbound, so the change flows to the WeldFlow task. We resolve the
 * link via the sync-map (the issue must already be mapped to a task); unmapped
 * issues are covered by projects_v2_item when added to a board.
 */
async function handleIssuesEvent(
  env: Env,
  tenantDb: TenantDatabase,
  workspaceId: string,
  deliveryId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const issue = payload.issue as { node_id?: string; number?: number } | undefined;
  const repo = payload.repository as { id?: number } | undefined;
  const issueNodeId = issue?.node_id;
  if (!issueNodeId) {
    console.log(`[GitHub Webhook] issues event without issue node_id (delivery: ${deliveryId})`);
    return;
  }

  // Find the project link via the sync-map (by issue node id; fall back to number+repo).
  let [row] = await tenantDb
    .select({ projectLinkId: schema.githubIssueSyncMap.projectLinkId })
    .from(schema.githubIssueSyncMap)
    .where(
      and(
        eq(schema.githubIssueSyncMap.workspaceId, workspaceId),
        eq(schema.githubIssueSyncMap.issueNodeId, issueNodeId),
      ),
    )
    .limit(1);
  if (!row && issue?.number != null && repo?.id != null) {
    [row] = await tenantDb
      .select({ projectLinkId: schema.githubIssueSyncMap.projectLinkId })
      .from(schema.githubIssueSyncMap)
      .where(
        and(
          eq(schema.githubIssueSyncMap.workspaceId, workspaceId),
          eq(schema.githubIssueSyncMap.issueNumber, issue.number),
          eq(schema.githubIssueSyncMap.repoId, repo.id),
        ),
      )
      .limit(1);
  }
  if (!row) {
    console.log(`[GitHub Webhook] issue ${issueNodeId} not mapped, skipping (delivery: ${deliveryId})`);
    return;
  }

  const [link] = await tenantDb
    .select({ id: schema.githubProjectLinks.id, syncDirection: schema.githubProjectLinks.syncDirection })
    .from(schema.githubProjectLinks)
    .where(
      and(
        eq(schema.githubProjectLinks.id, row.projectLinkId),
        isNull(schema.githubProjectLinks.deletedAt),
      ),
    )
    .limit(1);
  if (!link || link.syncDirection === 'outbound') return;

  // Same per-minute bucket id as projects_v2_item → an issue edit + a board move
  // in the same minute collapse into a single inbound sync.
  const bucket = Math.floor(Date.now() / 60000);
  try {
    await env.GITHUB_PROJECT_SYNC.create({
      id: `github-project-sync-${link.id}-${bucket}`,
      params: { workspaceId, projectLinkId: link.id, inboundOnly: true },
    });
    console.log(`[GitHub Webhook] Dispatched inbound sync for issue ${issueNodeId} → link ${link.id} (delivery ${deliveryId})`);
  } catch {
    console.log(`[GitHub Webhook] Sync already queued for link ${link.id} (bucket ${bucket}), skipping issue ${issueNodeId}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function extractInstallationId(payload: Record<string, unknown>): number | null {
  const installation = payload.installation as { id?: number } | undefined;
  return installation?.id ?? null;
}

async function resolveWorkspaceForInstallation(env: Env, installationId: number): Promise<string | null> {
  try {
    const masterDb = getMasterDb(env);
    const workspaces = await masterDb
      .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
      .from(masterSchema.workspaces)
      .limit(500);

    for (const ws of workspaces) {
      if (!ws.clerkOrgId) continue;
      try {
        const tenantDb = await getTenantDbForWorkspace(env, ws.clerkOrgId);
        const [conn] = await tenantDb
          .select({ id: schema.githubConnections.id })
          .from(schema.githubConnections)
          .where(
            and(
              eq(schema.githubConnections.installationId, installationId),
              isNull(schema.githubConnections.deletedAt),
            ),
          )
          .limit(1);
        if (conn) return ws.clerkOrgId;
      } catch {
        // Skip workspaces whose DB fails to resolve.
      }
    }
    return null;
  } catch (err) {
    console.error('[GitHub Webhook] Failed to resolve workspace for installation:', err);
    return null;
  }
}

async function verifyWebhookSignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const receivedHex = signatureHeader.slice(prefix.length);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, rawBody);
  const expectedHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (receivedHex.length !== expectedHex.length) return false;
  let mismatch = 0;
  for (let i = 0; i < receivedHex.length; i++) {
    mismatch |= receivedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return mismatch === 0;
}

export { app as githubAppWebhookRoutes };
