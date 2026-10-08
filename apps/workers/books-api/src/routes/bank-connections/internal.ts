/**
 * Internal bank-feed endpoints, mounted only on the `BooksInternal` entrypoint
 * (service binding; trusted by topology, no Clerk JWT). integration-webhook-worker
 * and integration-sync-worker call them with `X-Workspace-Id` (Clerk org id)
 * to sync one connection of one tenant.
 *
 * Placeholder; filled in by the WeldBooks US bank-feeds work.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export const bankConnectionsInternalRoutes = app;
