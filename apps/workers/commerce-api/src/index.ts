/**
 * WeldSuite commerce-api — the WeldCommerce (products, categories, orders,
 * parcels, shipments, pickups, returns, shipping rules and prices, carriers,
 * Sendcloud, PrintNode, B2B commerce portal) module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { carriersRoutes } from './routes/carriers';
import { categoriesRoutes } from './routes/categories';
import { commercePortalStaffRoutes } from './routes/commerce-portal';
import { ordersRoutes } from './routes/orders';
import { parcelAnalyticsRoutes } from './routes/parcel-analytics';
import { parcelNotificationsRoutes } from './routes/parcel-notifications';
import { parcelRatesRoutes } from './routes/parcel-rates';
import { parcelSettingsRoutes } from './routes/parcel-settings';
import { parcelWalletRoutes } from './routes/parcel-wallet';
import { parcelsRoutes } from './routes/parcels';
import { pickupsRoutes } from './routes/pickups';
import { printNodeRoutes } from './routes/printnode';
import { productsRoutes } from './routes/products';
import { publicCommercePortalRoutes } from './routes/public-commerce-portal';
import { returnReasonsRoutes } from './routes/return-reasons';
import { returnRulesRoutes } from './routes/return-rules';
import { returnsRoutes } from './routes/returns';
import { sendcloudRoutes } from './routes/sendcloud';
import { shipmentsRoutes } from './routes/shipments';
import { shippingPricesRoutes } from './routes/shipping-prices';
import { shippingRulesRoutes } from './routes/shipping-rules';
import { woocommerceAuthWebhookRoutes } from './routes/webhooks-woocommerce-auth';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'commerce-api' });

// Public B2B commerce portal consumed by apps/web/commerce-portal. No Clerk
// JWT — tenant DB is resolved from `?slug=` / X-Workspace-Slug, buyer auth is
// a hashed KV session. Must stay ABOVE the app.use('/api/*', ...) guard below.
app.route('/public/commerce-portal', publicCommercePortalRoutes);

// WooCommerce /wc-auth/v1 callback — PUBLIC. The shop POSTs API keys here.
// WooCommerce requires HTTP 200 or it deletes the keys. HMAC `user_id`.
app.route('/webhooks/woocommerce', woocommerceAuthWebhookRoutes);

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/carriers', carriersRoutes);
app.route('/api/categories', categoriesRoutes);
app.route('/api/commerce-portal', commercePortalStaffRoutes);
app.route('/api/orders', ordersRoutes);
app.route('/api/parcels', parcelsRoutes);
app.route('/api/parcel-analytics', parcelAnalyticsRoutes);
app.route('/api/parcel-notifications', parcelNotificationsRoutes);
app.route('/api/parcel-rates', parcelRatesRoutes);
app.route('/api/parcel-settings', parcelSettingsRoutes);
app.route('/api/parcel-wallet', parcelWalletRoutes);
app.route('/api/pickups', pickupsRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/return-reasons', returnReasonsRoutes);
app.route('/api/return-rules', returnRulesRoutes);
app.route('/api/returns', returnsRoutes);
app.route('/api/shipments', shipmentsRoutes);
app.route('/api/shipping-prices', shippingPricesRoutes);
app.route('/api/shipping-rules', shippingRulesRoutes);
// PrintNode settings (workspace_settings.customSettings.printnode) — AUTHED.
// Needs clerkMiddleware() + workspaceDbMiddleware() (reads c.get('tenantDb')),
// so this must stay BELOW the app.use('/api/*', ...) guard.
app.route('/api/printnode', printNodeRoutes);
app.route('/api/sendcloud', sendcloudRoutes);

export default {
  fetch: app.fetch,
};
