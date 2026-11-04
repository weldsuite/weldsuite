/**
 * WeldCommerce (commerce-api) response schemas: the shipping routes (carriers,
 * return reasons and rules, pickups, returns, shipments, shipping rules and
 * prices, parcels, and the parcel analytics, notifications, rates, settings
 * and wallet). Spread into ROUTES by conformance-schemas.ts. PrintNode is
 * registered with the rest of commerce (conformance-schemas-commerce.ts).
 */
import {
  carrierRowSchema,
  parcelAnalyticsOverviewSchema,
  parcelCarrierCredentialStatusSchema,
  parcelCarrierPerformanceSchema,
  parcelCostEstimateSchema,
  parcelEmailTemplatePageSchema,
  parcelEmailTemplateSchema,
  parcelRateCarrierSchema,
  parcelRateSchema,
  parcelRateSelectionSchema,
  parcelRowSchema,
  parcelSettingsSchema,
  parcelSmsTemplatePageSchema,
  parcelSmsTemplateSchema,
  parcelTemplateToggleSchema,
  parcelWalletBalanceCheckSchema,
  parcelWalletSchema,
  parcelWalletTransactionPageSchema,
  parcelWalletTransactionResultSchema,
  parcelWalletWithTransactionsSchema,
  parcelWebhookCreatedSchema,
  parcelWebhookLogsSchema,
  parcelWebhookPageSchema,
  parcelWebhookSchema,
  parcelWebhookStatusSchema,
  parcelWebhookTestResultSchema,
  parcelWhatsAppTemplatePageSchema,
  parcelWhatsAppTemplateSchema,
  pickupRowSchema,
  returnReasonRowSchema,
  returnRowSchema,
  returnRuleRowSchema,
  shipmentRowSchema,
  shippingIdResultSchema,
  shippingMessageSchema,
  shippingPriceRowSchema,
  shippingRuleRowSchema,
} from '@weldsuite/app-api-client/schemas/commerce-shipping-responses';
import type { RouteSchema } from './conformance-schemas';

/** `GET /`, `GET /:id`, `POST /` and `PATCH /:id` of a plain CRUD route (`DELETE /:id` answers 204). */
function crud(base: string, row: RouteSchema['data']): RouteSchema[] {
  return [
    { method: 'GET', route: base, envelope: 'list', data: row },
    { method: 'GET', route: `${base}/:id`, envelope: 'single', data: row },
    { method: 'POST', route: base, envelope: 'single', data: shippingIdResultSchema },
    { method: 'PATCH', route: `${base}/:id`, envelope: 'single', data: shippingIdResultSchema },
  ];
}

/** The email, SMS and WhatsApp template routes (`DELETE /:id` answers 204). */
function templates(base: string, page: RouteSchema['data'], template: RouteSchema['data']): RouteSchema[] {
  return [
    { method: 'GET', route: base, envelope: 'single', data: page },
    { method: 'GET', route: `${base}/:id`, envelope: 'single', data: template },
    { method: 'POST', route: base, envelope: 'single', data: shippingIdResultSchema },
    { method: 'PUT', route: `${base}/:id`, envelope: 'single', data: shippingIdResultSchema },
    { method: 'PATCH', route: `${base}/:id/toggle`, envelope: 'single', data: parcelTemplateToggleSchema },
  ];
}

const NOTIFICATIONS = '/api/parcel-notifications';
const HOOKS = `${NOTIFICATIONS}/webhooks`;
const WALLET = '/api/parcel-wallet';

export const COMMERCE_SHIPPING_ROUTES: RouteSchema[] = [
  // commerce: the shipping CRUD routes
  ...crud('/api/carriers', carrierRowSchema),
  ...crud('/api/return-reasons', returnReasonRowSchema),
  ...crud('/api/return-rules', returnRuleRowSchema),
  ...crud('/api/pickups', pickupRowSchema),
  ...crud('/api/returns', returnRowSchema),
  ...crud('/api/shipments', shipmentRowSchema),
  ...crud('/api/shipping-rules', shippingRuleRowSchema),
  ...crud('/api/shipping-prices', shippingPriceRowSchema),
  ...crud('/api/parcels', parcelRowSchema),
  // commerce: parcel analytics
  { method: 'GET', route: '/api/parcel-analytics', envelope: 'single', data: parcelAnalyticsOverviewSchema },
  { method: 'GET', route: '/api/parcel-analytics/carrier/:carrierId', envelope: 'single', data: parcelCarrierPerformanceSchema },
  // commerce: parcel notification templates and webhooks (`DELETE /webhooks/:id` answers 204)
  ...templates(`${NOTIFICATIONS}/email`, parcelEmailTemplatePageSchema, parcelEmailTemplateSchema),
  ...templates(`${NOTIFICATIONS}/sms`, parcelSmsTemplatePageSchema, parcelSmsTemplateSchema),
  ...templates(`${NOTIFICATIONS}/whatsapp`, parcelWhatsAppTemplatePageSchema, parcelWhatsAppTemplateSchema),
  { method: 'GET', route: HOOKS, envelope: 'single', data: parcelWebhookPageSchema },
  { method: 'GET', route: `${HOOKS}/:id`, envelope: 'single', data: parcelWebhookSchema },
  { method: 'POST', route: HOOKS, envelope: 'single', data: parcelWebhookCreatedSchema },
  { method: 'PUT', route: `${HOOKS}/:id`, envelope: 'single', data: shippingIdResultSchema },
  { method: 'PATCH', route: `${HOOKS}/:id/enable`, envelope: 'single', data: parcelWebhookStatusSchema },
  { method: 'PATCH', route: `${HOOKS}/:id/disable`, envelope: 'single', data: parcelWebhookStatusSchema },
  { method: 'POST', route: `${HOOKS}/:id/test`, envelope: 'single', data: parcelWebhookTestResultSchema },
  { method: 'GET', route: `${HOOKS}/:id/logs`, envelope: 'single', data: parcelWebhookLogsSchema },
  // commerce: parcel rates
  { method: 'POST', route: '/api/parcel-rates/calculate', envelope: 'array', data: parcelRateSchema },
  { method: 'POST', route: '/api/parcel-rates/select', envelope: 'single', data: parcelRateSelectionSchema },
  { method: 'GET', route: '/api/parcel-rates/carriers', envelope: 'array', data: parcelRateCarrierSchema },
  // commerce: parcel settings
  { method: 'GET', route: '/api/parcel-settings', envelope: 'single', data: parcelSettingsSchema },
  { method: 'PUT', route: '/api/parcel-settings', envelope: 'single', data: shippingMessageSchema },
  { method: 'GET', route: '/api/parcel-settings/carriers', envelope: 'array', data: parcelCarrierCredentialStatusSchema },
  { method: 'PUT', route: '/api/parcel-settings/carriers/:id/credentials', envelope: 'single', data: shippingMessageSchema },
  // commerce: parcel wallet
  { method: 'GET', route: WALLET, envelope: 'single', data: parcelWalletSchema },
  { method: 'GET', route: `${WALLET}/with-transactions`, envelope: 'single', data: parcelWalletWithTransactionsSchema },
  { method: 'GET', route: `${WALLET}/transactions`, envelope: 'single', data: parcelWalletTransactionPageSchema },
  { method: 'POST', route: `${WALLET}/credits`, envelope: 'single', data: parcelWalletTransactionResultSchema },
  { method: 'POST', route: `${WALLET}/deduct`, envelope: 'single', data: parcelWalletTransactionResultSchema },
  { method: 'POST', route: `${WALLET}/check-balance`, envelope: 'single', data: parcelWalletBalanceCheckSchema },
  { method: 'POST', route: `${WALLET}/estimate-cost`, envelope: 'single', data: parcelCostEstimateSchema },
];
