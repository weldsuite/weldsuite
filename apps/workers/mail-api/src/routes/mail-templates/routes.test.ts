/**
 * /api/mail-templates against a pglite tenant DB: list and its filters,
 * categories, CRUD, copies and rendering.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailTemplatesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function api() {
  const { request } = createTestApp('/api/mail-templates', mailTemplatesRoutes, {
    context: {
      userId: 'user_tpl',
      tenantDb: db,
      permissions: permissions('templates:read', 'templates:create', 'templates:update', 'templates:delete'),
    },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-templates${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('mail templates', () => {
  it('creates, lists, renders, copies and deletes', async () => {
    const call = api();
    const created = await call('POST', '', {
      name: 'Welcome',
      subject: 'Hi {{ firstName }}',
      htmlContent: '<p>Hello {{firstName}}, your plan is {{plan}} {{ missing }}</p>',
      textContent: 'Hello {{firstName}} ({{count}})',
      category: 'onboarding',
      type: 'welcome',
      variables: [{ name: 'firstName', type: 'text', required: true, defaultValue: 'there', extra: 1 }],
      requiredVariables: ['firstName'],
      tags: ['a'],
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    await call('POST', '', { name: 'Promo', subject: 'Sale', htmlContent: '<p>Sale</p>', category: 'marketing', type: 'marketing', isActive: false });
    expect((await call('POST', '', { name: '', subject: 'x', htmlContent: 'x' })).status).toBe(400);
    expect((await call('POST', '', { name: 'x', subject: 'x', htmlContent: 'x', variables: [{ name: 'a', type: 'color' }] })).status).toBe(400);

    for (const q of ['', '?type=welcome', '?category=onboarding', '?isActive=true', '?isActive=false', '?limit=1']) {
      expect((await call('GET', q)).status).toBe(200);
    }
    const first = await call('GET', '?limit=1');
    const cursor = ((await first.json()) as { pagination: { cursor: string } }).pagination.cursor;
    expect((await call('GET', `?limit=1&cursor=${cursor}`)).status).toBe(200);
    expect((await call('GET', '?type=bogus')).status).toBe(400);
    expect((await call('GET', '/categories')).status).toBe(200);
    expect((await call('GET', `/${id}`)).status).toBe(200);
    expect((await call('GET', '/tpl_missing')).status).toBe(404);

    const rendered = await call('POST', `/${id}/render`, { variables: { firstName: '<Ann>', plan: { tier: 'pro', seats: 3 }, count: 2.5 } });
    expect(rendered.status).toBe(200);
    expect((await call('POST', `/${id}/render`, { variables: { plan: 'x' } })).status).toBe(400);
    expect((await call('POST', `/${id}/render`, { variables: [] })).status).toBe(400);
    expect((await call('POST', '/tpl_missing/render', { variables: {} })).status).toBe(404);

    expect((await call('PATCH', `/${id}`, { subject: 'Hey {{firstName}}', isDefault: true })).status).toBe(200);
    expect((await call('PUT', `/${id}`, { tags: ['b'], purpose: 'signup' })).status).toBe(200);
    expect((await call('PATCH', '/tpl_missing', { name: 'x' })).status).toBe(404);

    const copy = await call('POST', `/${id}/duplicate`);
    expect(copy.status).toBe(201);
    expect((await call('POST', '/tpl_missing/duplicate')).status).toBe(404);
    expect((await call('DELETE', `/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/${id}`)).status).toBe(404);
  });
});
