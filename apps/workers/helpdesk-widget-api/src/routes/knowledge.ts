/**
 * Self-service in the widget, mounted at /api behind the widget auth:
 *
 *   GET /articles/search?q=&locale=&limit=   articles that might answer what
 *       the visitor is typing, before they send it: the help center's
 *       published articles they may read, in their language when a version
 *       exists, best match first (1–5, default 3), each with its help-center
 *       URL when the help center is live.
 *   GET /announcements                       the status banners they may see.
 *
 * The visitor token is optional (`Authorization: Bearer`): a known visitor
 * with a verified email also sees `logged_in` articles, and `groups`
 * articles and `specific_groups` announcements for their CRM companies.
 * Query values are read leniently (a long query is cut, a bad limit is the
 * default), so neither route refuses a request.
 */

import { Hono } from 'hono';
import {
  deskReaderOf,
  deskTypedSearch,
  listDeskAnnouncementsFor,
  normalizeDeskLocale,
  searchDeskArticlesFor,
} from '@weldsuite/db/lib/desk-articles';
import type { Env, Variables } from '../index';
import { error, success } from '../lib/response';
import { optionalVisitorPrincipal } from '../lib/optional-visitor';

export const knowledgeRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;

function limitOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(n) ? DEFAULT_LIMIT : Math.min(Math.max(n, 1), MAX_LIMIT);
}

knowledgeRoutes.get('/articles/search', async (c) => {
  const search = deskTypedSearch(c.req.query('q') ?? '');
  if (!search) return success(c, []);
  try {
    const db = c.get('tenantDb');
    const reader = await deskReaderOf(db, await optionalVisitorPrincipal(c));
    const hits = await searchDeskArticlesFor(db, reader, search, {
      locale: normalizeDeskLocale(c.req.query('locale')?.slice(0, 10)),
      limit: limitOf(c.req.query('limit')),
    });
    return success(c, hits);
  } catch (err) {
    console.error('[widget-api/knowledge] article search failed:', err);
    return error.internal(c, 'Failed to search articles');
  }
});

knowledgeRoutes.get('/announcements', async (c) => {
  try {
    const db = c.get('tenantDb');
    const reader = await deskReaderOf(db, await optionalVisitorPrincipal(c));
    return success(c, await listDeskAnnouncementsFor(db, reader));
  } catch (err) {
    console.error('[widget-api/knowledge] announcements failed:', err);
    return error.internal(c, 'Failed to load announcements');
  }
});
