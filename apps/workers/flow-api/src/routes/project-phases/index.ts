/**
 * /api/project-phases: phases and stage gates: check, request approval, waive (FLOW-017).
 *
 * Stub from the WeldFlow project-control foundation (slice C, schedule): the prefix is
 * registered in @weldsuite/api-modules and this router is mounted in
 * ../../index.ts, so the slice only fills this file in. Rust mirrors every
 * route in rust/modules/flow/src/project_phases.rs.
 *
 * Design: weldsuite-documentation, design/modules/weldflow-delivery-and-portfolio.md
 * and weldflow-project-control.md ("API surface").
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export const projectPhasesRoutes = app;
