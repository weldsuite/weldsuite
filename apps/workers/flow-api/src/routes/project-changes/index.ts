/**
 * /api/project-changes: change requests: submit, approve, reject, withdraw (FLOW-013).
 *
 * Stub from the WeldFlow project-control foundation (slice B, governance): the prefix is
 * registered in @weldsuite/api-modules and this router is mounted in
 * ../../index.ts, so the slice only fills this file in. Rust mirrors every
 * route in rust/modules/flow/src/project_changes.rs.
 *
 * Design: weldsuite-documentation, design/modules/weldflow-delivery-and-portfolio.md
 * and weldflow-project-control.md ("API surface").
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export const projectChangesRoutes = app;
