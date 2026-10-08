/**
 * /api/sales-tax: everything about US sales tax that isn't a CRUD object of
 * its own (agencies, jurisdictions, zones, rules, certificates and returns
 * have their own prefixes).
 *
 * - settings.ts: engine choice and credentials, provider registration check,
 *   calculation preview.
 * - reports.ts: liability, taxable/exempt sales, exceptions, certificates.
 * - nexus.ts: the nexus monitor.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { salesTaxSettingsRoutes } from './settings';
import { salesTaxReportsRoutes } from './reports';
import { salesTaxNexusRoutes } from './nexus';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.route('/', salesTaxSettingsRoutes);
app.route('/reports', salesTaxReportsRoutes);
app.route('/nexus', salesTaxNexusRoutes);

export const salesTaxRoutes = app;
