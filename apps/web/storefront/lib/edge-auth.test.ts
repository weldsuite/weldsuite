import { describe, expect, it } from 'vitest';
import * as nodeCheck from '../node/edge-auth.mjs';
import { isEdgeSecret, isOpenPath, refusal } from './edge-auth';

// Made at run time: the tests depend on no fixed secret. NEAR_MISS differs
// from it in the last character only.
const SECRET = `renderer-${crypto.randomUUID()}`;
const NEAR_MISS = `${SECRET.slice(0, -1)}${SECRET.endsWith('0') ? '1' : '0'}`;

describe('edge check (app middleware)', () => {
  it('accepts the secret and nothing else', async () => {
    expect(await isEdgeSecret(SECRET, SECRET)).toBe(true);
    expect(await isEdgeSecret(NEAR_MISS, SECRET)).toBe(false);
    expect(await isEdgeSecret(`${SECRET}x`, SECRET)).toBe(false);
    expect(await isEdgeSecret('', SECRET)).toBe(false);
    expect(await isEdgeSecret(null, SECRET)).toBe(false);
  });

  it('refuses everything when the renderer has no secret', async () => {
    expect(await isEdgeSecret('', undefined)).toBe(false);
    expect(await isEdgeSecret('anything', '')).toBe(false);
  });

  it('leaves only /healthz open, and refuses with a bare 404', async () => {
    expect(isOpenPath('/healthz')).toBe(true);
    expect(isOpenPath('/healthz/')).toBe(false);
    expect(isOpenPath('/')).toBe(false);
    const response = refusal();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });
});

describe('edge check (node/server.mjs)', () => {
  it('agrees with the app middleware', async () => {
    for (const presented of [SECRET, 'wrong', '', `${SECRET} `]) {
      expect(nodeCheck.isEdgeSecret(presented, SECRET), presented).toBe(await isEdgeSecret(presented, SECRET));
    }
  });

  it('refuses a missing header, a repeated header and a missing secret', () => {
    expect(nodeCheck.isEdgeSecret(undefined, SECRET)).toBe(false);
    expect(nodeCheck.isEdgeSecret([SECRET, SECRET], SECRET)).toBe(false);
    expect(nodeCheck.isEdgeSecret(SECRET, undefined)).toBe(false);
    expect(nodeCheck.isOpenPath('/healthz')).toBe(true);
    expect(nodeCheck.EDGE_HEADER).toBe('x-storefront-edge');
  });
});
