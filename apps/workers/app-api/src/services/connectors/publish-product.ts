/**
 * Outbound product publish — list a WeldCommerce product on an external store.
 *
 * Adding a sales channel pushes (or matches-by-SKU and updates) the catalogue
 * item on that connection, then writes `product_sales_channels` + an
 * `integration_entity_mappings` row so later webhooks update the same product.
 *
 * Removing a sales channel is local only: the remote listing is left alone.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { ConnectorApiError, getConnector, type ExternalProductRef, type OutboundCatalogProduct } from '@weldsuite/connectors';
import type { ProductSalesChannel } from '@weldsuite/db/schema';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type { Env } from '../../types';
import { createConnectorClient } from './clients';
import { decryptCredentials, getConnectionById, keyringFromEnv, type ConnectorConnectionRow } from './connections';

export type ProductSalesChannelErrorCode =
  | 'not_found'
  | 'conflict'
  | 'connection_inactive'
  | 'unsupported'
  | 'sync_failed';

export class ProductSalesChannelError extends Error {
  readonly code: ProductSalesChannelErrorCode;

  constructor(code: ProductSalesChannelErrorCode, message: string) {
    super(message);
    this.name = 'ProductSalesChannelError';
    this.code = code;
  }
}

export interface ProductWriteClient {
  storeUrl: string;
  findProductBySku(sku: string): Promise<ExternalProductRef | null>;
  createProduct(product: OutboundCatalogProduct): Promise<ExternalProductRef>;
  updateProduct(id: string, product: OutboundCatalogProduct): Promise<ExternalProductRef>;
}

const WRITABLE_STATUSES = new Set(['active', 'sync_error']);

function numericString(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0';
  return String(value);
}

function toOutboundProduct(product: typeof schema.products.$inferSelect): OutboundCatalogProduct {
  const images = product.images?.filter((img) => img.url) ?? [];
  if (images.length === 0 && product.featuredImageUrl) {
    images.push({ url: product.featuredImageUrl });
  }
  return {
    name: product.name,
    description: product.description,
    shortDescription: product.shortDescription,
    sku: product.sku,
    slug: product.slug,
    price: numericString(product.price),
    status: product.status ?? 'draft',
    vendor: product.vendor,
    productType: product.productType,
    images,
    weight: product.weight != null ? String(product.weight) : null,
    length: product.length != null ? String(product.length) : null,
    width: product.width != null ? String(product.width) : null,
    height: product.height != null ? String(product.height) : null,
  };
}

async function loadProduct(db: Database, productId: string) {
  const [row] = await db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), isNull(schema.products.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listSalesChannelTargets(db: Database): Promise<
  Array<{
    id: string;
    provider: string;
    label: string;
    displayName: string | null;
    status: string;
    externalAccountId: string | null;
  }>
> {
  const rows = await db
    .select()
    .from(schema.connectorConnections)
    .where(isNull(schema.connectorConnections.deletedAt));
  return rows
    .filter((row) => {
      const connector = getConnector(row.provider);
      return connector?.category === 'ecommerce' && WRITABLE_STATUSES.has(row.status);
    })
    .map((row) => {
      const connector = getConnector(row.provider);
      return {
        id: row.id,
        provider: row.provider,
        label: connector?.label ?? row.provider,
        displayName: row.displayName,
        status: row.status,
        externalAccountId: row.externalAccountId,
      };
    });
}

async function existingChannel(
  db: Database,
  productId: string,
  connectionId: string,
): Promise<ProductSalesChannel | null> {
  const [row] = await db
    .select()
    .from(schema.productSalesChannels)
    .where(
      and(
        eq(schema.productSalesChannels.productId, productId),
        eq(schema.productSalesChannels.connectionId, connectionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function channelByExternalId(
  db: Database,
  connectionId: string,
  externalId: string,
): Promise<ProductSalesChannel | null> {
  const [row] = await db
    .select()
    .from(schema.productSalesChannels)
    .where(
      and(
        eq(schema.productSalesChannels.connectionId, connectionId),
        eq(schema.productSalesChannels.externalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function ensureMapping(args: {
  db: Database;
  connectionId: string;
  provider: string;
  externalId: string;
  productId: string;
}): Promise<void> {
  const connector = getConnector(args.provider);
  const productSync = connector?.syncs.find((s) => s.internalEntity === 'product');
  const externalEntityType = productSync?.externalEntityType ?? `${args.provider}_product`;

  const [existing] = await args.db
    .select({
      id: schema.integrationEntityMappings.id,
      internalEntityId: schema.integrationEntityMappings.internalEntityId,
    })
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, args.connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, externalEntityType),
        eq(schema.integrationEntityMappings.externalEntityId, args.externalId),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.internalEntityId !== args.productId) {
      throw new ProductSalesChannelError(
        'conflict',
        'That store listing is already linked to a different product',
      );
    }
    await args.db
      .update(schema.integrationEntityMappings)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.integrationEntityMappings.id, existing.id));
    return;
  }

  await args.db.insert(schema.integrationEntityMappings).values({
    id: generateId('iem'),
    connectionId: args.connectionId,
    externalEntityType,
    externalEntityId: args.externalId,
    internalEntityType: 'product',
    internalEntityId: args.productId,
    lastSyncedAt: new Date(),
  });
}

async function writeSalesChannel(args: {
  db: Database;
  productId: string;
  connection: ConnectorConnectionRow;
  remote: ExternalProductRef;
}): Promise<ProductSalesChannel> {
  const now = new Date();
  const stolen = await channelByExternalId(args.db, args.connection.id, args.remote.id);
  if (stolen && stolen.productId !== args.productId) {
    throw new ProductSalesChannelError(
      'conflict',
      'That store listing is already linked to a different product',
    );
  }

  const linked = await existingChannel(args.db, args.productId, args.connection.id);
  if (linked) {
    await args.db
      .update(schema.productSalesChannels)
      .set({
        externalId: args.remote.id,
        externalUrl: args.remote.url,
        displayName: args.connection.displayName,
        provider: args.connection.provider,
        status: 'active',
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.productSalesChannels.id, linked.id));
    const [updated] = await args.db
      .select()
      .from(schema.productSalesChannels)
      .where(eq(schema.productSalesChannels.id, linked.id))
      .limit(1);
    return updated ?? { ...linked, externalId: args.remote.id, externalUrl: args.remote.url, status: 'active' };
  }

  const id = generateId('psch');
  await args.db.insert(schema.productSalesChannels).values({
    id,
    productId: args.productId,
    connectionId: args.connection.id,
    provider: args.connection.provider,
    displayName: args.connection.displayName,
    externalId: args.remote.id,
    externalUrl: args.remote.url,
    status: 'active',
    lastSyncedAt: now,
  });
  const [inserted] = await args.db
    .select()
    .from(schema.productSalesChannels)
    .where(eq(schema.productSalesChannels.id, id))
    .limit(1);
  if (!inserted) {
    throw new ProductSalesChannelError('sync_failed', 'Failed to record the sales channel');
  }
  return inserted;
}

async function clientForConnection(
  connection: ConnectorConnectionRow,
  env: Env,
  override?: ProductWriteClient,
): Promise<ProductWriteClient> {
  if (override) return override;
  const credentials = await decryptCredentials(connection.credentials ?? undefined, keyringFromEnv(env));
  return createConnectorClient(connection.provider, credentials, connection.externalAccountId);
}

function assertWritableConnection(connection: ConnectorConnectionRow): void {
  if (!getConnector(connection.provider)) {
    throw new ProductSalesChannelError('unsupported', `Unknown connector '${connection.provider}'`);
  }
  if (connection.deletedAt || !WRITABLE_STATUSES.has(connection.status)) {
    throw new ProductSalesChannelError(
      'connection_inactive',
      'This sales channel is not connected. Reconnect the store and try again.',
    );
  }
}

/**
 * Push a product onto a store and record the sales-channel listing.
 *
 * Matching SKU on the remote store updates that listing instead of creating a
 * second one. The local product is never duplicated.
 */
export async function publishProductToSalesChannel(args: {
  db: Database;
  env: Env;
  productId: string;
  connectionId: string;
  client?: ProductWriteClient;
}): Promise<ProductSalesChannel> {
  const product = await loadProduct(args.db, args.productId);
  if (!product) {
    throw new ProductSalesChannelError('not_found', 'Product not found');
  }

  const connection = await getConnectionById(args.db, args.connectionId);
  if (!connection) {
    throw new ProductSalesChannelError('not_found', 'Sales channel not found');
  }
  assertWritableConnection(connection);

  const already = await existingChannel(args.db, product.id, connection.id);
  if (already && already.status === 'active') {
    throw new ProductSalesChannelError('conflict', 'This product is already listed on that sales channel');
  }

  const payload = toOutboundProduct(product);
  let client: ProductWriteClient;
  try {
    client = await clientForConnection(connection, args.env, args.client);
  } catch (err) {
    if (err instanceof ConnectorApiError) {
      throw new ProductSalesChannelError('unsupported', err.message);
    }
    throw err;
  }

  let remote: ExternalProductRef;
  try {
    const sku = product.sku?.trim();
    const existing = sku ? await client.findProductBySku(sku) : null;
    remote = existing
      ? await client.updateProduct(existing.id, payload)
      : await client.createProduct(payload);
  } catch (err) {
    const message = err instanceof ConnectorApiError ? err.message : 'Failed to sync the product to the store';
    throw new ProductSalesChannelError('sync_failed', message);
  }

  if (!remote.id) {
    throw new ProductSalesChannelError('sync_failed', 'The store did not return a product id');
  }

  await ensureMapping({
    db: args.db,
    connectionId: connection.id,
    provider: connection.provider,
    externalId: remote.id,
    productId: product.id,
  });

  return writeSalesChannel({
    db: args.db,
    productId: product.id,
    connection,
    remote,
  });
}

/**
 * Drop the local listing only. The product stays on the remote store.
 */
export async function unlinkProductSalesChannel(args: {
  db: Database;
  productId: string;
  channelId: string;
}): Promise<void> {
  const product = await loadProduct(args.db, args.productId);
  if (!product) {
    throw new ProductSalesChannelError('not_found', 'Product not found');
  }

  const [channel] = await args.db
    .select({ id: schema.productSalesChannels.id })
    .from(schema.productSalesChannels)
    .where(
      and(
        eq(schema.productSalesChannels.id, args.channelId),
        eq(schema.productSalesChannels.productId, args.productId),
      ),
    )
    .limit(1);
  if (!channel) {
    throw new ProductSalesChannelError('not_found', 'Sales channel listing not found');
  }

  await args.db.delete(schema.productSalesChannels).where(eq(schema.productSalesChannels.id, channel.id));
}

export async function attachSalesChannelsToProducts<T extends { id: string }>(
  db: Database,
  products: T[],
): Promise<Array<T & { salesChannels: ProductSalesChannel[] }>> {
  if (products.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.productSalesChannels)
    .where(inArray(schema.productSalesChannels.productId, products.map((p) => p.id)));

  const byProduct = new Map<string, ProductSalesChannel[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }
  return products.map((product) => ({
    ...product,
    salesChannels: byProduct.get(product.id) ?? [],
  }));
}
