/**
 * Connector sync direction helpers + default field mappings.
 *
 * Direction lives on `connector_connections`; field mappings reuse
 * `integration_field_mappings` keyed by the connector connection id.
 */

import type { ConnectorEntity, ConnectorSyncSettingKey } from './catalog';
import { getConnector } from './catalog';

export type ConnectorSyncDirection = 'inbound' | 'outbound' | 'bidirectional';

export type ConnectorObjectSyncDirections = Partial<
  Record<ConnectorSyncSettingKey | string, ConnectorSyncDirection>
>;

export interface ConnectorFieldMappingDefinition {
  externalFieldPath: string;
  internalFieldPath: string;
  direction: ConnectorSyncDirection;
  transformType: 'direct' | 'lookup' | 'format_date' | 'custom';
  transformConfig?: Record<string, unknown>;
  isRequired?: boolean;
}

export function allowsInboundSync(direction: ConnectorSyncDirection): boolean {
  return direction === 'inbound' || direction === 'bidirectional';
}

export function allowsOutboundSync(direction: ConnectorSyncDirection): boolean {
  return direction === 'outbound' || direction === 'bidirectional';
}

export function resolveConnectorObjectDirection(args: {
  direction?: ConnectorSyncDirection | null;
  objectSyncDirections?: ConnectorObjectSyncDirections | null;
  settingKey: string;
}): ConnectorSyncDirection {
  const override = args.objectSyncDirections?.[args.settingKey];
  if (override) return override;
  return args.direction ?? 'inbound';
}

export function connectorEntityTypes(provider: string): ConnectorEntity[] {
  const connector = getConnector(provider);
  if (!connector) return [];
  return [...new Set(connector.syncs.map((s) => s.internalEntity))];
}

const PRODUCT_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'name', internalFieldPath: 'name', direction: 'bidirectional', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'title', internalFieldPath: 'name', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'slug', internalFieldPath: 'slug', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'handle', internalFieldPath: 'slug', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'sku', internalFieldPath: 'sku', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'description', internalFieldPath: 'description', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'body_html', internalFieldPath: 'description', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'short_description', internalFieldPath: 'shortDescription', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'price', internalFieldPath: 'price', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'regular_price', internalFieldPath: 'compareAtPrice', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'status', internalFieldPath: 'status', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'weight', internalFieldPath: 'weight', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'vendor', internalFieldPath: 'vendor', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'product_type', internalFieldPath: 'productType', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'type', internalFieldPath: 'productType', direction: 'inbound', transformType: 'direct' },
];

const ORDER_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'number', internalFieldPath: 'orderNumber', direction: 'inbound', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'name', internalFieldPath: 'orderNumber', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'status', internalFieldPath: 'status', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'currency', internalFieldPath: 'currency', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'total', internalFieldPath: 'total', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'subtotal', internalFieldPath: 'subtotal', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'total_tax', internalFieldPath: 'taxTotal', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'shipping_total', internalFieldPath: 'shippingTotal', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'discount_total', internalFieldPath: 'discountTotal', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.email', internalFieldPath: 'customerEmail', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.first_name', internalFieldPath: 'customerFirstName', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.last_name', internalFieldPath: 'customerLastName', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.phone', internalFieldPath: 'customerPhone', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'customer_note', internalFieldPath: 'notes', direction: 'inbound', transformType: 'direct' },
];

const PERSON_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'email', internalFieldPath: 'email', direction: 'bidirectional', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'first_name', internalFieldPath: 'firstName', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'last_name', internalFieldPath: 'lastName', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'username', internalFieldPath: 'fullName', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.phone', internalFieldPath: 'directPhone', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.address_1', internalFieldPath: 'address', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.city', internalFieldPath: 'city', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.state', internalFieldPath: 'state', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.postcode', internalFieldPath: 'zip', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'billing.country', internalFieldPath: 'country', direction: 'inbound', transformType: 'direct' },
];

const PARTY_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'company_name', internalFieldPath: 'companyName', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'firstname', internalFieldPath: 'firstName', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'lastname', internalFieldPath: 'lastName', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'email', internalFieldPath: 'email', direction: 'bidirectional', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'phone', internalFieldPath: 'phone', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'address1', internalFieldPath: 'address', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'city', internalFieldPath: 'city', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'zipcode', internalFieldPath: 'zip', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'country', internalFieldPath: 'country', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'chamber_of_commerce', internalFieldPath: 'vatNumber', direction: 'inbound', transformType: 'direct' },
];

const INVOICE_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'invoice_id', internalFieldPath: 'invoiceNumber', direction: 'inbound', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'reference', internalFieldPath: 'reference', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'state', internalFieldPath: 'status', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'currency', internalFieldPath: 'currency', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'total_price_excl_tax', internalFieldPath: 'subtotal', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'total_price_incl_tax', internalFieldPath: 'total', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'due_date', internalFieldPath: 'dueDate', direction: 'inbound', transformType: 'format_date' },
];

const BILL_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'reference', internalFieldPath: 'reference', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'state', internalFieldPath: 'status', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'currency', internalFieldPath: 'currency', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'total_price_excl_tax', internalFieldPath: 'subtotal', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'total_price_incl_tax', internalFieldPath: 'total', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'due_date', internalFieldPath: 'dueDate', direction: 'inbound', transformType: 'format_date' },
];

const BANK_ACCOUNT_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'name', internalFieldPath: 'name', direction: 'inbound', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'identifier', internalFieldPath: 'iban', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'currency', internalFieldPath: 'currency', direction: 'inbound', transformType: 'direct' },
];

const BANK_TRANSACTION_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'date', internalFieldPath: 'date', direction: 'inbound', transformType: 'format_date', isRequired: true },
  { externalFieldPath: 'amount', internalFieldPath: 'amount', direction: 'inbound', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'message', internalFieldPath: 'description', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'contra_account_name', internalFieldPath: 'counterpartyName', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'contra_account_number', internalFieldPath: 'counterpartyIban', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'batch_reference', internalFieldPath: 'reference', direction: 'inbound', transformType: 'direct' },
];

/** Picqer catalogue — productcode is SKU; stock freestock is inbound-primary. */
const PICQER_PRODUCT_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'name', internalFieldPath: 'name', direction: 'bidirectional', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'productcode', internalFieldPath: 'sku', direction: 'bidirectional', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'barcode', internalFieldPath: 'barcode', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'description', internalFieldPath: 'description', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'price', internalFieldPath: 'price', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'weight', internalFieldPath: 'weight', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'active', internalFieldPath: 'status', direction: 'bidirectional', transformType: 'direct' },
];

const WAREHOUSE_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'name', internalFieldPath: 'name', direction: 'bidirectional', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'code', internalFieldPath: 'code', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'accepts_orders', internalFieldPath: 'isActive', direction: 'inbound', transformType: 'direct' },
];

const LOCATION_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'name', internalFieldPath: 'name', direction: 'bidirectional', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'remark', internalFieldPath: 'code', direction: 'inbound', transformType: 'direct' },
];

const INVENTORY_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'freestock', internalFieldPath: 'quantityAvailable', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'stock', internalFieldPath: 'quantityOnHand', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'reserved', internalFieldPath: 'quantityAllocated', direction: 'inbound', transformType: 'direct' },
];

const PICKLIST_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'picklistid', internalFieldPath: 'pickListNumber', direction: 'inbound', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'status', internalFieldPath: 'status', direction: 'inbound', transformType: 'direct' },
];

const SHIPMENT_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'trackingcode', internalFieldPath: 'shipmentNumber', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'provider', internalFieldPath: 'carrierName', direction: 'inbound', transformType: 'direct' },
];

const SUPPLIER_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'name', internalFieldPath: 'name', direction: 'bidirectional', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'emailaddress', internalFieldPath: 'email', direction: 'bidirectional', transformType: 'direct' },
  { externalFieldPath: 'telephone', internalFieldPath: 'phone', direction: 'bidirectional', transformType: 'direct' },
];

const PURCHASE_ORDER_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'purchaseorderid', internalFieldPath: 'poNumber', direction: 'inbound', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'status', internalFieldPath: 'status', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'supplier_name', internalFieldPath: 'supplierName', direction: 'inbound', transformType: 'direct' },
];

const RETURN_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'returnid', internalFieldPath: 'returnNumber', direction: 'inbound', transformType: 'direct', isRequired: true },
  { externalFieldPath: 'status', internalFieldPath: 'status', direction: 'inbound', transformType: 'direct' },
];

const STOCK_COUNT_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'idlocation_stock_count', internalFieldPath: 'countNumber', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'status', internalFieldPath: 'status', direction: 'inbound', transformType: 'direct' },
];

const MOVEMENT_DEFAULTS: ConnectorFieldMappingDefinition[] = [
  { externalFieldPath: 'idmovement', internalFieldPath: 'movementNumber', direction: 'inbound', transformType: 'direct' },
  { externalFieldPath: 'amount', internalFieldPath: 'quantity', direction: 'inbound', transformType: 'direct' },
];

const DEFAULTS_BY_ENTITY: Record<string, ConnectorFieldMappingDefinition[]> = {
  product: PRODUCT_DEFAULTS,
  order: ORDER_DEFAULTS,
  person: PERSON_DEFAULTS,
  party: PARTY_DEFAULTS,
  invoice: INVOICE_DEFAULTS,
  bill: BILL_DEFAULTS,
  bank_account: BANK_ACCOUNT_DEFAULTS,
  bank_transaction: BANK_TRANSACTION_DEFAULTS,
  inventory: INVENTORY_DEFAULTS,
  warehouse: WAREHOUSE_DEFAULTS,
  location: LOCATION_DEFAULTS,
  picklist: PICKLIST_DEFAULTS,
  shipment: SHIPMENT_DEFAULTS,
  supplier: SUPPLIER_DEFAULTS,
  purchase_order: PURCHASE_ORDER_DEFAULTS,
  return: RETURN_DEFAULTS,
  stock_count: STOCK_COUNT_DEFAULTS,
  inventory_movement: MOVEMENT_DEFAULTS,
};

/** Suggested field catalogs for the connector mapping UI. */
export const CONNECTOR_EXTERNAL_FIELDS: Record<string, Array<{ value: string; label: string }>> = {
  product: [
    { value: 'name', label: 'Name' },
    { value: 'title', label: 'Title' },
    { value: 'slug', label: 'Slug' },
    { value: 'handle', label: 'Handle' },
    { value: 'sku', label: 'SKU' },
    { value: 'productcode', label: 'Product code' },
    { value: 'barcode', label: 'Barcode' },
    { value: 'description', label: 'Description' },
    { value: 'body_html', label: 'Body HTML' },
    { value: 'short_description', label: 'Short description' },
    { value: 'price', label: 'Price' },
    { value: 'regular_price', label: 'Regular price' },
    { value: 'status', label: 'Status' },
    { value: 'weight', label: 'Weight' },
    { value: 'vendor', label: 'Vendor' },
    { value: 'type', label: 'Type' },
    { value: 'product_type', label: 'Product type' },
    { value: 'stock_quantity', label: 'Stock quantity' },
  ],
  order: [
    { value: 'number', label: 'Order number' },
    { value: 'orderid', label: 'Order id' },
    { value: 'name', label: 'Name' },
    { value: 'status', label: 'Status' },
    { value: 'reference', label: 'Reference' },
    { value: 'currency', label: 'Currency' },
    { value: 'total', label: 'Total' },
    { value: 'subtotal', label: 'Subtotal' },
    { value: 'total_tax', label: 'Tax total' },
    { value: 'shipping_total', label: 'Shipping total' },
    { value: 'discount_total', label: 'Discount total' },
    { value: 'billing.email', label: 'Billing email' },
    { value: 'billing.first_name', label: 'Billing first name' },
    { value: 'billing.last_name', label: 'Billing last name' },
    { value: 'billing.phone', label: 'Billing phone' },
    { value: 'customer_note', label: 'Customer note' },
    { value: 'emailaddress', label: 'Email' },
  ],
  person: [
    { value: 'email', label: 'Email' },
    { value: 'emailaddress', label: 'Email address' },
    { value: 'first_name', label: 'First name' },
    { value: 'firstname', label: 'First name' },
    { value: 'last_name', label: 'Last name' },
    { value: 'lastname', label: 'Last name' },
    { value: 'name', label: 'Name' },
    { value: 'username', label: 'Username' },
    { value: 'billing.phone', label: 'Phone' },
    { value: 'telephone', label: 'Telephone' },
    { value: 'billing.address_1', label: 'Address' },
    { value: 'billing.city', label: 'City' },
    { value: 'billing.state', label: 'State' },
    { value: 'billing.postcode', label: 'Postcode' },
    { value: 'billing.country', label: 'Country' },
  ],
  party: [
    { value: 'company_name', label: 'Company name' },
    { value: 'firstname', label: 'First name' },
    { value: 'lastname', label: 'Last name' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone' },
    { value: 'address1', label: 'Address' },
    { value: 'city', label: 'City' },
    { value: 'zipcode', label: 'Zip' },
    { value: 'country', label: 'Country' },
    { value: 'chamber_of_commerce', label: 'Chamber of commerce' },
  ],
  invoice: [
    { value: 'invoice_id', label: 'Invoice id' },
    { value: 'reference', label: 'Reference' },
    { value: 'state', label: 'State' },
    { value: 'currency', label: 'Currency' },
    { value: 'total_price_excl_tax', label: 'Total excl. tax' },
    { value: 'total_price_incl_tax', label: 'Total incl. tax' },
    { value: 'due_date', label: 'Due date' },
  ],
  bill: [
    { value: 'reference', label: 'Reference' },
    { value: 'state', label: 'State' },
    { value: 'currency', label: 'Currency' },
    { value: 'total_price_excl_tax', label: 'Total excl. tax' },
    { value: 'total_price_incl_tax', label: 'Total incl. tax' },
    { value: 'due_date', label: 'Due date' },
  ],
  bank_account: [
    { value: 'name', label: 'Name' },
    { value: 'identifier', label: 'Identifier / IBAN' },
    { value: 'currency', label: 'Currency' },
  ],
  bank_transaction: [
    { value: 'date', label: 'Date' },
    { value: 'amount', label: 'Amount' },
    { value: 'message', label: 'Message' },
    { value: 'contra_account_name', label: 'Contra account name' },
    { value: 'contra_account_number', label: 'Contra account number' },
    { value: 'batch_reference', label: 'Batch reference' },
  ],
  inventory: [
    { value: 'stock', label: 'Stock' },
    { value: 'freestock', label: 'Free stock' },
    { value: 'reserved', label: 'Reserved' },
    { value: 'idwarehouse', label: 'Warehouse id' },
    { value: 'idproduct', label: 'Product id' },
  ],
  warehouse: [
    { value: 'name', label: 'Name' },
    { value: 'code', label: 'Code' },
    { value: 'accepts_orders', label: 'Accepts orders' },
  ],
  location: [
    { value: 'name', label: 'Name' },
    { value: 'remark', label: 'Remark / code' },
    { value: 'idwarehouse', label: 'Warehouse id' },
  ],
  picklist: [
    { value: 'picklistid', label: 'Pick list id' },
    { value: 'status', label: 'Status' },
    { value: 'idwarehouse', label: 'Warehouse id' },
  ],
  shipment: [
    { value: 'trackingcode', label: 'Tracking code' },
    { value: 'provider', label: 'Carrier' },
    { value: 'idpicklist', label: 'Pick list id' },
  ],
  supplier: [
    { value: 'name', label: 'Name' },
    { value: 'emailaddress', label: 'Email' },
    { value: 'telephone', label: 'Phone' },
  ],
  purchase_order: [
    { value: 'purchaseorderid', label: 'PO number' },
    { value: 'status', label: 'Status' },
    { value: 'supplier_name', label: 'Supplier name' },
  ],
  return: [
    { value: 'returnid', label: 'Return id' },
    { value: 'status', label: 'Status' },
  ],
  stock_count: [
    { value: 'idlocation_stock_count', label: 'Stock count id' },
    { value: 'status', label: 'Status' },
  ],
  inventory_movement: [
    { value: 'idmovement', label: 'Movement id' },
    { value: 'amount', label: 'Amount' },
  ],
};

export const CONNECTOR_INTERNAL_FIELDS: Record<string, Array<{ value: string; label: string }>> = {
  product: [
    { value: 'name', label: 'Name' },
    { value: 'slug', label: 'Slug' },
    { value: 'sku', label: 'SKU' },
    { value: 'barcode', label: 'Barcode' },
    { value: 'description', label: 'Description' },
    { value: 'shortDescription', label: 'Short description' },
    { value: 'price', label: 'Price' },
    { value: 'compareAtPrice', label: 'Compare-at price' },
    { value: 'status', label: 'Status' },
    { value: 'weight', label: 'Weight' },
    { value: 'vendor', label: 'Vendor' },
    { value: 'productType', label: 'Product type' },
    { value: 'inventoryQuantity', label: 'Inventory quantity' },
  ],
  order: [
    { value: 'orderNumber', label: 'Order number' },
    { value: 'status', label: 'Status' },
    { value: 'currency', label: 'Currency' },
    { value: 'total', label: 'Total' },
    { value: 'subtotal', label: 'Subtotal' },
    { value: 'taxTotal', label: 'Tax total' },
    { value: 'shippingTotal', label: 'Shipping total' },
    { value: 'discountTotal', label: 'Discount total' },
    { value: 'customerEmail', label: 'Customer email' },
    { value: 'customerFirstName', label: 'Customer first name' },
    { value: 'customerLastName', label: 'Customer last name' },
    { value: 'customerPhone', label: 'Customer phone' },
    { value: 'notes', label: 'Notes' },
  ],
  person: [
    { value: 'email', label: 'Email' },
    { value: 'firstName', label: 'First name' },
    { value: 'lastName', label: 'Last name' },
    { value: 'fullName', label: 'Full name' },
    { value: 'directPhone', label: 'Phone' },
    { value: 'address', label: 'Address' },
    { value: 'city', label: 'City' },
    { value: 'state', label: 'State' },
    { value: 'zip', label: 'Zip' },
    { value: 'country', label: 'Country' },
  ],
  party: [
    { value: 'companyName', label: 'Company name' },
    { value: 'firstName', label: 'First name' },
    { value: 'lastName', label: 'Last name' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone' },
    { value: 'address', label: 'Address' },
    { value: 'city', label: 'City' },
    { value: 'zip', label: 'Zip' },
    { value: 'country', label: 'Country' },
    { value: 'vatNumber', label: 'VAT number' },
  ],
  invoice: [
    { value: 'invoiceNumber', label: 'Invoice number' },
    { value: 'reference', label: 'Reference' },
    { value: 'status', label: 'Status' },
    { value: 'currency', label: 'Currency' },
    { value: 'subtotal', label: 'Subtotal' },
    { value: 'total', label: 'Total' },
    { value: 'dueDate', label: 'Due date' },
  ],
  bill: [
    { value: 'reference', label: 'Reference' },
    { value: 'status', label: 'Status' },
    { value: 'currency', label: 'Currency' },
    { value: 'subtotal', label: 'Subtotal' },
    { value: 'total', label: 'Total' },
    { value: 'dueDate', label: 'Due date' },
  ],
  bank_account: [
    { value: 'name', label: 'Name' },
    { value: 'iban', label: 'IBAN' },
    { value: 'currency', label: 'Currency' },
  ],
  bank_transaction: [
    { value: 'date', label: 'Date' },
    { value: 'amount', label: 'Amount' },
    { value: 'description', label: 'Description' },
    { value: 'counterpartyName', label: 'Counterparty name' },
    { value: 'counterpartyIban', label: 'Counterparty IBAN' },
    { value: 'reference', label: 'Reference' },
  ],
  inventory: [
    { value: 'quantityOnHand', label: 'On hand' },
    { value: 'quantityAvailable', label: 'Available' },
    { value: 'quantityAllocated', label: 'Allocated' },
  ],
  warehouse: [
    { value: 'name', label: 'Name' },
    { value: 'code', label: 'Code' },
    { value: 'isActive', label: 'Active' },
  ],
  location: [
    { value: 'name', label: 'Name' },
    { value: 'code', label: 'Code' },
  ],
  picklist: [
    { value: 'pickListNumber', label: 'Pick list number' },
    { value: 'status', label: 'Status' },
  ],
  shipment: [
    { value: 'shipmentNumber', label: 'Shipment number' },
    { value: 'carrierName', label: 'Carrier' },
    { value: 'status', label: 'Status' },
  ],
  supplier: [
    { value: 'name', label: 'Name' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone' },
  ],
  purchase_order: [
    { value: 'poNumber', label: 'PO number' },
    { value: 'status', label: 'Status' },
    { value: 'supplierName', label: 'Supplier name' },
  ],
  return: [
    { value: 'returnNumber', label: 'Return number' },
    { value: 'status', label: 'Status' },
  ],
  stock_count: [
    { value: 'countNumber', label: 'Count number' },
    { value: 'status', label: 'Status' },
  ],
  inventory_movement: [
    { value: 'movementNumber', label: 'Movement number' },
    { value: 'quantity', label: 'Quantity' },
  ],
};

export function getDefaultConnectorFieldMappings(
  entityType: string,
  provider?: string,
): ConnectorFieldMappingDefinition[] {
  if (provider === 'picqer' && entityType === 'product') {
    return PICQER_PRODUCT_DEFAULTS.map((m) => ({ ...m }));
  }
  return (DEFAULTS_BY_ENTITY[entityType] ?? []).map((m) => ({ ...m }));
}
