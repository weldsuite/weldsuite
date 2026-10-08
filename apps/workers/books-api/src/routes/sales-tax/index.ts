/**
 * Sales tax calculation preview, engine settings, nexus and reports.
 *
 * Placeholder mounted in src/index.ts; filled in by the WeldBooks US work
 * (docs/plans/weldbooks-us.md).
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export const salesTaxRoutes = app;
