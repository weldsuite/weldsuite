/**
 * The default WeldAgent's tools follow the caller's permissions as any route
 * checks them: a member deny takes away a grant their role gives, so the
 * persona cannot read everyone's people or projects past it.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import type { Env, Variables } from '../../types';
import { personaPermissions } from './persona-permissions';

async function held(resolved: ResolvedPermissions): Promise<string[]> {
  const routes = new Hono<{ Bindings: Env; Variables: Variables }>();
  routes.get('/', async (c) => c.json(await personaPermissions(c)));
  const res = await createTestApp('/persona', routes, { context: { permissions: resolved } }).request('/persona');
  return (await res.json()) as string[];
}

describe('personaPermissions', () => {
  it('keeps the persona keys the caller holds', async () => {
    const keys = await held(permissions('people:read', 'people:scope:all', 'invoices:read'));
    expect(keys).toEqual(expect.arrayContaining(['people:read', 'people:scope:all']));
    expect(keys).not.toContain('invoices:read');
  });

  it('drops a key a member deny takes away, even from a wildcard', async () => {
    const keys = await held({
      ...permissions('people:read', 'people:scope:all', 'projects:*'),
      denies: ['people:scope:all', 'projects:scope:all'],
    });
    expect(keys).toContain('people:read');
    expect(keys).toContain('projects:read');
    expect(keys).not.toContain('people:scope:all');
    expect(keys).not.toContain('projects:scope:all');
  });
});
