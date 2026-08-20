/**
 * Outbound sales-channel publish: add syncs to the store, remove is local-only.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import type { Env } from '../../types';
import {
  publishProductToSalesChannel,
  unlinkProductSalesChannel,
  type ProductWriteClient,
} from './publish-product';

let db: Database;
const env = {} as Env;

function fakeClient(overrides: Partial<ProductWriteClient> = {}): ProductWriteClient {
  return {
    storeUrl: 'https://shop.example',
    findProductBySku: async () => null,
    createProduct: async () => ({ id: '99', url: 'https://shop.example/?p=99' }),
    updateProduct: async (id) => ({ id, url: `https://shop.example/?p=${id}` }),
    ...overrides,
  };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await db.insert(schema.connectorConnections).values({
    id: 'conn_pub_woo',
    provider: 'woocommerce',
    displayName: 'Main store',
    status: 'active',
    externalAccountId: 'https://shop.example',
  });
}, 60_000);

describe('publishProductToSalesChannel', () => {
  it('creates the remote product and records the sales channel + mapping', async () => {
    await db.insert(schema.products).values({
      id: 'prod_pub_1',
      name: 'Helmet',
      slug: 'helmet-pub-1',
      sku: 'WH-PUB-1',
      price: '19.00',
    });

    const createProduct = vi.fn(async () => ({ id: '99', url: 'https://shop.example/?p=99' }));
    const channel = await publishProductToSalesChannel({
      db,
      env,
      productId: 'prod_pub_1',
      connectionId: 'conn_pub_woo',
      client: fakeClient({ createProduct }),
    });

    expect(createProduct).toHaveBeenCalledOnce();
    expect(channel.connectionId).toBe('conn_pub_woo');
    expect(channel.externalId).toBe('99');
    expect(channel.status).toBe('active');

    const mappings = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(eq(schema.integrationEntityMappings.internalEntityId, 'prod_pub_1'));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.externalEntityId).toBe('99');
    expect(mappings[0]?.externalEntityType).toBe('woocommerce_product');
  });

  it('updates an existing remote SKU instead of creating a second listing', async () => {
    await db.insert(schema.products).values({
      id: 'prod_pub_2',
      name: 'Gloves',
      slug: 'gloves-pub-2',
      sku: 'WH-PUB-2',
      price: '9.00',
    });

    const createProduct = vi.fn(async () => ({ id: 'should-not', url: null }));
    const updateProduct = vi.fn(async (id: string) => ({ id, url: `https://shop.example/?p=${id}` }));

    const channel = await publishProductToSalesChannel({
      db,
      env,
      productId: 'prod_pub_2',
      connectionId: 'conn_pub_woo',
      client: fakeClient({
        findProductBySku: async () => ({ id: '12', url: 'https://shop.example/?p=12' }),
        createProduct,
        updateProduct,
      }),
    });

    expect(createProduct).not.toHaveBeenCalled();
    expect(updateProduct).toHaveBeenCalledWith('12', expect.objectContaining({ sku: 'WH-PUB-2' }));
    expect(channel.externalId).toBe('12');
  });

  it('rejects a second add on the same connection', async () => {
    await db.insert(schema.products).values({
      id: 'prod_pub_3',
      name: 'Boots',
      slug: 'boots-pub-3',
      sku: 'WH-PUB-3',
      price: '49.00',
    });

    await publishProductToSalesChannel({
      db,
      env,
      productId: 'prod_pub_3',
      connectionId: 'conn_pub_woo',
      client: fakeClient({ createProduct: async () => ({ id: '31', url: null }) }),
    });

    await expect(
      publishProductToSalesChannel({
        db,
        env,
        productId: 'prod_pub_3',
        connectionId: 'conn_pub_woo',
        client: fakeClient({ createProduct: async () => ({ id: '32', url: null }) }),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('unlinkProductSalesChannel', () => {
  it('deletes the local listing and does not call the store client', async () => {
    await db.insert(schema.products).values({
      id: 'prod_pub_4',
      name: 'Jacket',
      slug: 'jacket-pub-4',
      sku: 'WH-PUB-4',
      price: '79.00',
    });

    const createProduct = vi.fn(async () => ({ id: '41', url: null }));
    const channel = await publishProductToSalesChannel({
      db,
      env,
      productId: 'prod_pub_4',
      connectionId: 'conn_pub_woo',
      client: fakeClient({ createProduct }),
    });

    await unlinkProductSalesChannel({ db, productId: 'prod_pub_4', channelId: channel.id });

    const remaining = await db
      .select()
      .from(schema.productSalesChannels)
      .where(eq(schema.productSalesChannels.productId, 'prod_pub_4'));
    expect(remaining).toHaveLength(0);
    expect(createProduct).toHaveBeenCalledTimes(1);
  });
});
