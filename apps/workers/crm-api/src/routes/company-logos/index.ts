/**
 * Company logos routes — /api/company-logos/*.
 *
 * `POST /resolve` turns a batch of company domains into logo URLs served from
 * the workspace's own storage (see lib/company-logo.ts for how a missing logo is
 * fetched, from the company's own website only). It replaces pointing every
 * avatar at a public favicon service, which sent the workspace's customer list
 * to that service on each page view.
 *
 * A POST, so the domains stay out of URLs and access logs. It reads nothing
 * from the tenant database and changes no CRM record, so there is no entity
 * event; the only write is the logo cache in R2.
 *
 * Permission: any CRM / lead-database read. Avatars appear in every list that
 * shows a company, and a member who may see that list may see its logos.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { resolveCompanyLogosSchema } from '@weldsuite/app-api-client/schemas/company-logos';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { logoPublicBase, resolveCompanyLogos } from '../../lib/company-logo';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post(
  '/resolve',
  requirePermission('companies:read', 'people:read', 'leads:read', 'prospects:read'),
  zValidator('json', resolveCompanyLogosSchema),
  async (c) => {
    const { domains } = c.req.valid('json');
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.badRequest(c, 'No active workspace');

    const storage = c.env.STORAGE;
    const r2PublicUrl = c.env.R2_PUBLIC_URL;
    if (!storage || !r2PublicUrl) {
      // Logo storage is not bound (local dev without R2): behave as "no logos",
      // the clients fall back to initials.
      console.warn('[crm-api/company-logos] STORAGE or R2_PUBLIC_URL is not configured');
      return success(c, { logos: Object.fromEntries(domains.map((d) => [d, null])) });
    }

    const logos = await resolveCompanyLogos(domains, {
      storage,
      r2PublicUrl: logoPublicBase(c.req.url, r2PublicUrl),
      workspaceId,
    });
    return success(c, { logos });
  },
);

export const companyLogosRoutes = app;
