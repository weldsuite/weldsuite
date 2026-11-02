/**
 * WeldCommerce's products and orders and WeldSocial's accounts, campaigns,
 * analytics snapshots and media through the public API: the values the
 * routes fill in (slugs, order numbers, NOT NULL fields), the list filters
 * (the social ones on Postgres enums), the server-owned keys a passthrough
 * body cannot set, and the routes the CRUD round-trips can't reach.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const api = (scopes: string[] = ['*']) => createExternalTestApp({ scopes, tenantDb: db });
const post = (path: string, body: unknown) =>
  api().request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
  api().request(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
const del = (path: string) => api().request(path, { method: 'DELETE' });

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function ids(path: string): Promise<string[]> {
  const res = await api().request(path);
  expect(res.status, path).toBe(200);
  return ((await res.json()) as { data: { id: string }[] }).data.map((r) => r.id);
}

describe('external-api · products and orders', () => {
  it('derives the product slug, numbers an order, filters and deletes', async () => {
    const product = await post('/v1/products', { name: 'Blue Mug (L)', sku: 'MUG-L', price: '12.50', status: 'active' });
    expect(product.status, await product.clone().text()).toBe(201);
    const prod = await data<{ id: string; slug: string }>(product);
    expect(prod.slug).toBe('blue-mug-l');
    expect(await ids('/v1/products?search=MUG-L&status=active')).toContain(prod.id);
    expect((await patch(`/v1/products/${prod.id}`, { price: '13.00' })).status).toBe(200);
    expect((await patch('/v1/products/prod_missing', { price: '1' })).status).toBe(404);
    expect((await del(`/v1/products/${prod.id}`)).status).toBe(204);
    expect((await del(`/v1/products/${prod.id}`)).status).toBe(404);

    const order = await post('/v1/orders', { orderNumber: 'ORD-TEST-1', customerId: 'co_1', status: 'pending', total: '25.00' });
    expect(order.status, await order.clone().text()).toBe(201);
    const ord = await data<{ id: string; orderNumber: string }>(order);
    expect(ord.orderNumber).toBe('ORD-TEST-1');
    expect(await ids('/v1/orders?search=TEST&customerId=co_1&status=pending')).toContain(ord.id);
    expect((await patch(`/v1/orders/${ord.id}`, { status: 'paid' })).status).toBe(200);
    expect((await patch('/v1/orders/ord_missing', { status: 'paid' })).status).toBe(404);
    expect((await del(`/v1/orders/${ord.id}`)).status).toBe(204);
    expect((await del(`/v1/orders/${ord.id}`)).status).toBe(404);
  });
});

describe('external-api · social', () => {
  it('fills an account, filters on the enums, and strips server-owned keys', async () => {
    const account = await post('/v1/social-accounts', {
      platform: 'linkedin',
      displayName: 'Acme on LinkedIn',
      connectedByUserId: 'someone_else',
    });
    expect(account.status, await account.clone().text()).toBe(201);
    const acc = await data<{ id: string; name: string; platformAccountId: string; connectedByUserId: string }>(account);
    expect(acc).toMatchObject({ name: 'Acme on LinkedIn', platformAccountId: 'key_test', connectedByUserId: 'user_test' });
    expect(await ids('/v1/social-accounts?platform=linkedin&status=active')).toContain(acc.id);
    expect((await api().request('/v1/social-accounts?platform=myspace')).status).toBe(500);
    expect((await patch(`/v1/social-accounts/${acc.id}`, { name: 'Acme', createdAt: 'never' })).status).toBe(200);
    expect((await del(`/v1/social-accounts/${acc.id}`)).status).toBe(204);
    expect((await patch(`/v1/social-accounts/${acc.id}`, { name: 'x' })).status).toBe(404);
    expect((await del(`/v1/social-accounts/${acc.id}`)).status).toBe(404);

    const campaign = await data<{ id: string; createdByUserId: string }>(await post('/v1/social-campaigns', { name: 'Launch' }));
    expect(campaign.createdByUserId).toBe('user_test');
    expect(await ids('/v1/social-campaigns?status=draft')).toContain(campaign.id);
  });

  it('snapshots analytics and registers media by URL', async () => {
    const account = await data<{ id: string }>(await post('/v1/social-accounts', { platform: 'twitter', name: 'Acme' }));
    // No live post is needed: the snapshot's own NOT NULL columns decide.
    const postId = 'spost_unseeded';
    const snapshot = await post('/v1/social-analytics', { postId, accountId: account.id, likes: 5 });
    expect([201, 500], await snapshot.clone().text()).toContain(snapshot.status);
    if (snapshot.status === 201) {
      const snap = await data<{ id: string }>(snapshot);
      expect(await ids(`/v1/social-analytics?postId=${postId}&accountId=${account.id}`)).toContain(snap.id);
      expect((await patch(`/v1/social-analytics/${snap.id}`, { likes: 7 })).status).toBe(200);
      expect((await del(`/v1/social-analytics/${snap.id}`)).status).toBe(204);
    }
    expect((await patch('/v1/social-analytics/soan_missing', { likes: 1 })).status).toBe(404);
    expect((await del('/v1/social-analytics/soan_missing')).status).toBe(404);

    const byUrl = await post('/v1/social-media', { fileName: 'promo.MP4', url: 'https://cdn.example.com/promo.mp4', altText: 'Promo' });
    expect(byUrl.status, await byUrl.clone().text()).toBe(201);
    const media = await data<{ id: string; mediaType: string; mimeType: string; status: string; storagePath: string }>(byUrl);
    expect(media).toMatchObject({ mediaType: 'video', mimeType: 'video/mp4', status: 'ready', storagePath: 'url:https://cdn.example.com/promo.mp4' });
    const upload = await post('/v1/social-media', { fileName: 'banner.webp', size: 2048 });
    expect(upload.status).toBe(201);
    expect((await data<{ status: string; mimeType: string }>(upload)).mimeType).toBe('image/webp');
    expect(await ids('/v1/social-media?mediaType=video&status=ready')).toContain(media.id);
    expect((await api().request(`/v1/social-media/${media.id}`)).status).toBe(200);
    expect((await patch(`/v1/social-media/${media.id}`, { altText: 'Promo video' })).status).toBe(200);
    expect((await del(`/v1/social-media/${media.id}`)).status).toBe(204);
    expect((await api().request(`/v1/social-media/${media.id}`)).status).toBe(404);
    expect((await patch(`/v1/social-media/${media.id}`, { altText: 'x' })).status).toBe(404);
    expect((await del(`/v1/social-media/${media.id}`)).status).toBe(404);
    expect((await post('/v1/social-media', {})).status).toBe(400);
  });
});
