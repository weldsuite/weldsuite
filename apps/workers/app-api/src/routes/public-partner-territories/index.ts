/**
 * Public partner territories — GET /public/partner-territories.
 *
 * Which country belongs to which reseller, with the partner's public contact
 * details. No auth: the marketing site's price resolver reads it to show
 * "Available through {Partner}" instead of a price, and signup screens use the
 * same data. Only what a partner already shows its customers is returned.
 *
 * Entity events: none. Read-only.
 */

import { Hono } from 'hono';
import { listTerritories } from '@weldsuite/core-domain/partners';
import type { Env, Variables } from '../../types';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { success } from '@weldsuite/worker-kit/response';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Browsers and the edge may reuse the list for 5 minutes. */
const CACHE_CONTROL = 'public, max-age=300';

app.get('/', async (c) => {
  const territories = await listTerritories(getMasterDb(c.env));
  c.header('Cache-Control', CACHE_CONTROL);
  // Public data with no credentials: any origin (the marketing site) may read it.
  if (!c.res.headers.has('Access-Control-Allow-Origin')) c.header('Access-Control-Allow-Origin', '*');
  return success(c, territories);
});

export const publicPartnerTerritoriesRoutes = app;
