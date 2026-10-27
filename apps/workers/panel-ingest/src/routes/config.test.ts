import { projectKvKey } from '@weldsuite/panel-domain/registry';
import { describe, expect, it } from 'vitest';
import { TOKEN, call, makeEnv, projectRecord } from '../testing/fakes';

describe('GET /c/:token', () => {
  it('gives the client config of the project, cacheable for five minutes', async () => {
    const record = projectRecord({
      settings: {
        autocapture: false,
        maskingLevel: 'strict',
        consentMode: 'none',
        recordingSampleRate: 0.5,
        excludedUrls: ['/admin/*'],
        ipFilters: ['203.0.113.0/24'],
        aiEnabled: true,
      },
    });
    const res = await call(makeEnv(record), { method: 'GET', path: `/c/${TOKEN}` });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await res.json()).toEqual({
      autocapture: false,
      consentMode: 'none',
      maskingLevel: 'strict',
      excludedUrls: ['/admin/*'],
    });
  });

  it('keeps everything private to the project out of the answer', async () => {
    const record = projectRecord({
      allowedDomains: ['example.com'],
      settings: { ...projectRecord().settings, ipFilters: ['203.0.113.7'] },
    });
    const body = await (await call(makeEnv(record), { method: 'GET', path: `/c/${TOKEN}` })).text();

    expect(body).not.toContain('203.0.113.7');
    expect(body).not.toContain('example.com');
    expect(body).not.toContain('ws_test_workspace');
  });

  it('fills in settings a stored record predates', async () => {
    const record = projectRecord();
    const { ipFilters: _ipFilters, excludedUrls: _excludedUrls, ...older } = record.settings;
    const stored = { ...record, settings: older };
    const testEnv = makeEnv(null);
    testEnv.kv.store.set(projectKvKey(TOKEN), JSON.stringify(stored));

    const res = await call(testEnv, { method: 'GET', path: `/c/${TOKEN}` });

    expect(await res.json()).toMatchObject({ excludedUrls: [], autocapture: true });
  });

  it('answers 404, not cached, for an unknown or deleted project', async () => {
    const res = await call(makeEnv(null), { method: 'GET', path: `/c/${TOKEN}` });

    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ error: { code: 'unknown_project' } });
  });

  it('answers 404 for a token that cannot be one, without asking KV', async () => {
    const testEnv = makeEnv();
    const res = await call(testEnv, { method: 'GET', path: '/c/not-a-token' });

    expect(res.status).toBe(404);
    expect(testEnv.kv.get).not.toHaveBeenCalled();
  });

  it('answers 404 for a record of a version it does not know', async () => {
    const testEnv = makeEnv(null);
    testEnv.kv.store.set(projectKvKey(TOKEN), JSON.stringify({ ...projectRecord(), v: 2 }));

    expect((await call(testEnv, { method: 'GET', path: `/c/${TOKEN}` })).status).toBe(404);
  });
});
