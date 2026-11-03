/**
 * /public/project-portal: the client portal API (sign-in with an email code, the
 * project view, approvals addressed to a contact; FLOW-020).
 *
 * Stub from the WeldFlow project-control foundation (slice H, client portal).
 * Unlike every other flow-api router it is mounted outside `/api/*` in
 * ../../index.ts, so `apiAuth()` (Clerk) does not run: the workspace comes from
 * the request and the caller from a portal session (KV), like the commerce
 * portal (../public-commerce-portal in commerce-api). Rust mirrors it in
 * rust/modules/flow/src/public_project_portal.rs, mounted by `public_router`
 * in rust/modules/flow/src/lib.rs.
 *
 * Design: weldsuite-documentation, design/modules/weldflow-delivery-and-portfolio.md
 * ("Client portal").
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export const publicProjectPortalRoutes = app;
