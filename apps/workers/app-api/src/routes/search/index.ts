/**
 * Federated Search Route
 *
 * POST /api/search
 *
 * Validates input, gates by permissions (the orchestrator silently drops
 * disallowed types), and fans out to per-entity search functions.
 *
 * Ported from apps/core-api/src/routes/search.ts during the core-api → app-api
 * migration. Read-only: no entity mutations, so no requirePermission() gate on
 * the collection — any authenticated user can call it and results are filtered
 * per-type via the permission registry in services/search.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ensurePermissionsResolved, requirePermission } from '@weldsuite/permissions/server';
import { hasAnyPermission } from '@weldsuite/permissions';
import { searchInputSchema, reindexInputSchema } from '@weldsuite/app-api-client/schemas/search';
import { createEmbedder, backfillBatch, initialBackfillCursor } from '../../services/search/indexer';
import type { Env, Variables } from '../../types';
import { error } from '../../lib/response';
import { runSearch, getPermittedTypes, type PermissionLike } from '../../services/search';
import { understandQuery, applyPermittedTypes } from '../../services/search/query-understanding';
import { resolveAiMetering } from '../../services/ai/billing';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', zValidator('json', searchInputSchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId') ?? '';

  // Resolve permissions inline — search has no requirePermission() gate (any
  // authenticated user can call it; results are filtered per-type below).
  let userPermissions: string[] = [];
  try {
    const resolved = await ensurePermissionsResolved(c);
    userPermissions = resolved?.permissions ?? [];
  } catch (err) {
    console.error('[app-api/search] Failed to resolve permissions:', err);
  }

  const perms: PermissionLike = {
    hasAny: (required) => hasAnyPermission(userPermissions, required),
  };

  const input = c.req.valid('json');

  try {
    // Structure the query before searching: "Invoice from Acme Corp" becomes
    // {types: ['invoice'], term: 'Acme Corp'}, which the per-entity ILIKE
    // queries can actually match. Never throws — an unparseable query, an
    // unconfigured gateway or an empty credit wallet all fall back to the raw
    // string, i.e. exactly the behaviour before this layer existed.
    const metering = await resolveAiMetering(c.env, c.get('workspaceId') ?? '', c.get('userId') ?? '');
    const parsed = await understandQuery(c.env, input.q, metering);

    // An explicit `types` filter from the UI always wins over the parse — the
    // user narrowing to a tab is a stronger signal than the model's guess.
    const scopedTypes =
      input.types && input.types.length > 0
        ? input.types
        : applyPermittedTypes(parsed, getPermittedTypes(perms));

    const { groups, permittedTypes } = await runSearch(db, workspaceId, {
      q: input.q,
      types: scopedTypes,
      limit: input.limit,
      perms,
      lexicalTerm: parsed.lexicalTerm,
    });

    return c.json({
      data: groups,
      query: input.q,
      permittedTypes,
      understanding: {
        source: parsed.source,
        entityTypes: parsed.entityTypes,
        lexicalTerm: parsed.lexicalTerm,
      },
    });
  } catch (err) {
    console.error('[app-api/search] Failed to run search:', err);
    return error.internal(c, 'Failed to run search');
  }
});

/**
 * POST /api/search/reindex — drive one batch of the semantic backfill.
 *
 * Batch-at-a-time by design. A Worker has a wall-clock and CPU budget that a
 * tenant with a large corpus would blow through in a single sweep, so the
 * caller loops until `done`, passing back the cursor it was handed. That also
 * makes the backfill resumable after any failure: the cursor is the whole of
 * the state.
 *
 * Gated on `settings:general:update` — reindexing is a workspace-wide
 * administrative action, not a search operation.
 */
app.post(
  '/reindex',
  requirePermission('settings:general:update'),
  zValidator('json', reindexInputSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const { cursor } = c.req.valid('json');

    let embedder: ReturnType<typeof createEmbedder>;
    try {
      embedder = createEmbedder(c.env);
    } catch (err) {
      console.error('[app-api/search] reindex: AI gateway unavailable:', err);
      // No `error.serviceUnavailable` helper exists; match the envelope shape
      // used by lib/response.ts so clients parse it the same way.
      return c.json(
        { error: { code: 'AI_NOT_CONFIGURED', message: 'AI gateway is not configured' } },
        503,
      );
    }

    try {
      const progress = await backfillBatch(db, embedder, cursor ?? initialBackfillCursor());
      return c.json({ data: progress });
    } catch (err) {
      console.error('[app-api/search] reindex batch failed:', err);
      return error.internal(c, 'Failed to run reindex batch');
    }
  },
);

export const searchRoutes = app;
