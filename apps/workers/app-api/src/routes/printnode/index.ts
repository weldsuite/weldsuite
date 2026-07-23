/**
 * PrintNode settings — /api/printnode.
 *
 * Ported from apps/api-worker (W5b legacy-worker phase-out):
 *   - GET / ← GET /settings/printnode   [general:read]
 *   - PUT / ← PUT /settings/printnode   [general:update]
 *
 * Backed by `workspace_settings.customSettings.printnode` (no table of its
 * own) — see services/printnode.ts.
 *
 * Gating mirrors legacy exactly. Both tiers are correct rather than merely
 * faithful: SYSTEM_ROLES.MEMBER carries `settings:general:read` → `general:read`,
 * so the read is reachable for every member, and the write is a workspace-wide
 * integration credential (not a self-scoped action), so `general:update`
 * (OWNER/ADMIN) is the right tier and is what the platform's own UI already
 * assumes.
 *
 * NOTE — this port also fixes a live 404. The platform's legacy client called
 * `/api/settings/integrations/printnode` (lib/api/clients/settings.ts), but
 * api-worker only ever served `/api/settings/printnode`; there is no
 * `/integrations/printnode` route and `GET /integrations` does not match the
 * sub-path. So the PrintNode settings UI has been failing both read and save
 * against the legacy worker. Repointing the hooks here is the first time that
 * screen talks to a route that exists.
 *
 * Entity events: none — there is no `printnode` / `workspace_setting` entity
 * type in the packages/core/entity-events catalog, and the legacy route published
 * nothing.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { getPrintNodeSettings, upsertPrintNodeSettings } from '../../services/printnode';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * The legacy PUT took the raw body with no validation at all and stored it
 * verbatim. `apiKey` is the only field the platform sends (and it sends `''`
 * to disconnect), so it is required here; `.passthrough()` keeps any extra
 * keys a caller stores alongside it, preserving the legacy free-form contract
 * while still rejecting a body that is missing the one field that matters.
 */
const printNodeSettingsSchema = z
  .object({
    apiKey: z.string(),
  })
  .passthrough();

// ============================================================================
// GET / — read the PrintNode config (null when never configured)
// ============================================================================

app.get('/', requirePermission('general:read'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const settings = await getPrintNodeSettings(db);
    return success(c, settings);
  } catch (err) {
    // Legacy swallowed read failures and answered `null` rather than 500 —
    // the settings screen treats null as "not connected" and stays usable.
    console.error('[app-api/printnode] Failed to fetch PrintNode settings:', err);
    return success(c, null);
  }
});

// ============================================================================
// PUT / — upsert the PrintNode config
// ============================================================================

app.put('/', requirePermission('general:update'), zValidator('json', printNodeSettingsSchema), async (c) => {
  try {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');

    const result = await upsertPrintNodeSettings(db, body);
    // Legacy answered 201 when it had to create the settings row, 200 otherwise.
    return success(c, result.settings, result.created ? 201 : 200);
  } catch (err) {
    console.error('[app-api/printnode] Failed to update PrintNode settings:', err);
    return error.internal(c, 'Failed to update PrintNode settings');
  }
});

export const printNodeRoutes = app;
