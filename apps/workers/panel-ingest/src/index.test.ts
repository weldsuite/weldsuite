import { describe, expect, it } from 'vitest';
import { app } from './index';

describe('panel-ingest', () => {
  it('answers the health check', async () => {
    const res = await app.request('/health', {}, { ENVIRONMENT: 'test' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'panel-ingest', environment: 'test' });
  });

  it('has no collection routes before phase 1', async () => {
    const res = await app.request('/e', { method: 'POST', body: '[]' }, { ENVIRONMENT: 'test' });

    expect(res.status).toBe(404);
  });
});
