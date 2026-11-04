/** WeldCommerce (commerce-api) response schemas: products and their sales channels, categories, orders, Sendcloud, PrintNode, and the B2B commerce portal (buyers' public routes, staff routes). Spread into ROUTES by conformance-schemas.ts. The label PDF and the invoice HTML answer no JSON; deletes and logout answer 204. */
import {
  categoryCreatedSchema,
  categoryMembersAddedSchema,
  categoryMembersPreviewSchema,
  commerceCategoryRowSchema,
  commerceCategoryTreeNodeSchema,
  commerceIdResultSchema,
  commerceInvoiceRowSchema,
  commerceInvoiceWithItemsSchema,
  commerceOkSchema,
  commerceOrderItemRowSchema,
  commerceOrderRowSchema,
  commerceOrderWithItemsSchema,
  commercePortalAccessRowSchema,
  commercePortalConfigSchema,
  commercePortalMeSchema,
  commercePortalSessionSchema,
  commercePortalSettingsSchema,
  commercePortalVerifySchema,
  commerceProductRowSchema,
  commerceProductSchema,
  commerceReturnReasonRowSchema,
  commerceReturnRowSchema,
  orderTaxRecalculationSchema,
  orderTaxResultSchema,
  orderWriteResultSchema,
  printNodeSettingsOrNullSchema,
  printNodeSettingsSchema,
  productCategoryRefSchema,
  productSalesChannelSchema,
  salesChannelTargetSchema,
  sendcloudSettingsPublicSchema,
} from '@weldsuite/app-api-client/schemas/commerce-responses';
import type { RouteSchema } from './conformance-schemas';

const P = '/api/products';
const C = '/api/categories';
const O = '/api/orders';
const SC = '/api/sendcloud';
const PORTAL = '/public/commerce-portal';
const STAFF = '/api/commerce-portal';

export const COMMERCE_ROUTES: RouteSchema[] = [
  // products and their sales channels
  { method: 'GET', route: P, envelope: 'list', data: commerceProductSchema },
  { method: 'GET', route: `${P}/sales-channel-targets`, envelope: 'array', data: salesChannelTargetSchema },
  { method: 'GET', route: `${P}/:id`, envelope: 'single', data: commerceProductSchema },
  { method: 'GET', route: `${P}/:id/categories`, envelope: 'list', data: productCategoryRefSchema },
  { method: 'GET', route: `${P}/:id/sales-channels`, envelope: 'list', data: productSalesChannelSchema },
  { method: 'POST', route: `${P}/:id/sales-channels`, envelope: 'single', data: productSalesChannelSchema },
  { method: 'PATCH', route: `${P}/:id/sales-channels/:channelId`, envelope: 'single', data: productSalesChannelSchema },
  { method: 'POST', route: P, envelope: 'single', data: commerceIdResultSchema },
  { method: 'PATCH', route: `${P}/:id`, envelope: 'single', data: commerceIdResultSchema },
  // categories
  { method: 'GET', route: C, envelope: 'list', data: commerceCategoryRowSchema },
  { method: 'GET', route: `${C}/tree`, envelope: 'array', data: commerceCategoryTreeNodeSchema },
  { method: 'POST', route: `${C}/preview-members`, envelope: 'single', data: categoryMembersPreviewSchema },
  { method: 'GET', route: `${C}/:id`, envelope: 'single', data: commerceCategoryRowSchema },
  { method: 'GET', route: `${C}/:id/products`, envelope: 'list', data: commerceProductRowSchema },
  { method: 'POST', route: C, envelope: 'single', data: categoryCreatedSchema },
  { method: 'PATCH', route: `${C}/:id`, envelope: 'single', data: commerceIdResultSchema },
  { method: 'POST', route: `${C}/:id/products`, envelope: 'single', data: categoryMembersAddedSchema },
  // orders and their sales tax
  { method: 'GET', route: O, envelope: 'list', data: commerceOrderRowSchema },
  { method: 'GET', route: `${O}/:id`, envelope: 'single', data: commerceOrderRowSchema },
  { method: 'GET', route: `${O}/:id/items`, envelope: 'list', data: commerceOrderItemRowSchema },
  { method: 'POST', route: `${O}/calculate-tax`, envelope: 'single', data: orderTaxResultSchema },
  { method: 'POST', route: `${O}/:id/calculate-tax`, envelope: 'single', data: orderTaxRecalculationSchema },
  { method: 'POST', route: O, envelope: 'single', data: orderWriteResultSchema },
  { method: 'PATCH', route: `${O}/:id`, envelope: 'single', data: orderWriteResultSchema },
  // Sendcloud (GET /labels/:parcelId answers the PDF) and PrintNode
  { method: 'GET', route: SC, envelope: 'single', data: sendcloudSettingsPublicSchema },
  { method: 'PUT', route: `${SC}/connect`, envelope: 'single', data: sendcloudSettingsPublicSchema },
  { method: 'POST', route: `${SC}/sync`, envelope: 'single', data: sendcloudSettingsPublicSchema },
  { method: 'PATCH', route: SC, envelope: 'single', data: sendcloudSettingsPublicSchema },
  { method: 'GET', route: '/api/printnode', envelope: 'single', data: printNodeSettingsOrNullSchema },
  { method: 'PUT', route: '/api/printnode', envelope: 'single', data: printNodeSettingsSchema },
  // the buyers' portal (GET /invoices/:id/pdf answers the invoice HTML)
  { method: 'GET', route: `${PORTAL}/config`, envelope: 'single', data: commercePortalConfigSchema },
  { method: 'POST', route: `${PORTAL}/auth/request`, envelope: 'single', data: commerceOkSchema },
  { method: 'POST', route: `${PORTAL}/auth/verify`, envelope: 'single', data: commercePortalVerifySchema },
  { method: 'POST', route: `${PORTAL}/auth/select-company`, envelope: 'single', data: commercePortalSessionSchema },
  { method: 'GET', route: `${PORTAL}/me`, envelope: 'single', data: commercePortalMeSchema },
  { method: 'GET', route: `${PORTAL}/products`, envelope: 'list', data: commerceProductRowSchema },
  { method: 'GET', route: `${PORTAL}/products/:id`, envelope: 'single', data: commerceProductRowSchema },
  { method: 'GET', route: `${PORTAL}/categories`, envelope: 'list', data: commerceCategoryRowSchema },
  { method: 'GET', route: `${PORTAL}/orders`, envelope: 'list', data: commerceOrderRowSchema },
  { method: 'GET', route: `${PORTAL}/orders/:id`, envelope: 'single', data: commerceOrderWithItemsSchema },
  { method: 'POST', route: `${PORTAL}/orders`, envelope: 'single', data: commerceOrderWithItemsSchema },
  { method: 'GET', route: `${PORTAL}/invoices`, envelope: 'list', data: commerceInvoiceRowSchema },
  { method: 'GET', route: `${PORTAL}/invoices/:id`, envelope: 'single', data: commerceInvoiceWithItemsSchema },
  { method: 'GET', route: `${PORTAL}/return-reasons`, envelope: 'list', data: commerceReturnReasonRowSchema },
  { method: 'GET', route: `${PORTAL}/returns`, envelope: 'list', data: commerceReturnRowSchema },
  { method: 'GET', route: `${PORTAL}/returns/:id`, envelope: 'single', data: commerceReturnRowSchema },
  { method: 'POST', route: `${PORTAL}/returns`, envelope: 'single', data: commerceReturnRowSchema },
  // the staff side of the portal
  { method: 'GET', route: `${STAFF}/settings`, envelope: 'single', data: commercePortalSettingsSchema },
  { method: 'PATCH', route: `${STAFF}/settings`, envelope: 'single', data: commercePortalSettingsSchema },
  { method: 'GET', route: `${STAFF}/access`, envelope: 'list', data: commercePortalAccessRowSchema },
  { method: 'POST', route: `${STAFF}/access/invite`, envelope: 'single', data: commercePortalAccessRowSchema },
  { method: 'POST', route: `${STAFF}/access/:id/revoke`, envelope: 'single', data: commercePortalAccessRowSchema },
  { method: 'POST', route: `${STAFF}/access/:id/resend`, envelope: 'single', data: commerceOkSchema },
];
