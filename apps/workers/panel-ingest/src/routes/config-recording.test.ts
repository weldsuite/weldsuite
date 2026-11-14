import { quotaKvKey, snapshotRequestKvKey } from '@weldsuite/panel-domain/registry';
import { beforeEach, describe, expect, it } from 'vitest';
import recorderStub from '../testing/recorder-bundle-stub';
import { PROJECT_ID, TOKEN, WORKSPACE_ID, call, makeEnv, projectRecord, resetIsolateState } from '../testing/fakes';

const config = async (testEnv: ReturnType<typeof makeEnv>) =>
  (await (await call(testEnv, { method: 'GET', path: `/c/${TOKEN}` })).json()) as Record<string, unknown>;

describe('GET /c/:token: recordings and snapshots', () => {
  beforeEach(resetIsolateState);

  it('gives the sample rate from the project settings', async () => {
    const record = projectRecord({ settings: { ...projectRecord().settings, recordingSampleRate: 0.25 } });
    expect(await config(makeEnv(record))).toMatchObject({ recordingSampleRate: 0.25, recordingBlocked: false, snapshot: null });
  });

  it('defaults to recording every consented session', async () => {
    expect(await config(makeEnv())).toMatchObject({ recordingSampleRate: 1, recordingBlocked: false });
  });

  it('keeps the rate between 0 and 1', async () => {
    const high = projectRecord({ settings: { ...projectRecord().settings, recordingSampleRate: 7 } });
    expect(await config(makeEnv(high))).toMatchObject({ recordingSampleRate: 1 });
  });

  it('blocks recording when it is off for the project', async () => {
    const off = projectRecord({ settings: { ...projectRecord().settings, recordingSampleRate: 0 } });
    expect(await config(makeEnv(off))).toMatchObject({ recordingSampleRate: 0, recordingBlocked: true });
  });

  it.each([
    ['replay_blocked', true],
    ['events_blocked', true],
    ['ok', false],
  ])('blocks recording by the workspace quota state %s: %s', async (state, blocked) => {
    resetIsolateState();
    const testEnv = makeEnv();
    testEnv.kv.store.set(quotaKvKey(WORKSPACE_ID), state);
    expect(await config(testEnv)).toMatchObject({ recordingBlocked: blocked });
  });

  it('passes on the snapshot the project asks for', async () => {
    const testEnv = makeEnv();
    const request = { pageGroupId: 'pnh_products', urlPattern: '/products/*', deviceClass: 'tablet' };
    testEnv.kv.store.set(snapshotRequestKvKey(PROJECT_ID), JSON.stringify(request));

    expect(await config(testEnv)).toMatchObject({ snapshot: request });
  });

  it('answers null for a snapshot request it cannot read', async () => {
    const testEnv = makeEnv();
    testEnv.kv.store.set(snapshotRequestKvKey(PROJECT_ID), JSON.stringify({ pageGroupId: '../x', urlPattern: '/', deviceClass: 'desktop' }));
    expect(await config(testEnv)).toMatchObject({ snapshot: null });
  });
});

describe('GET /rec.js', () => {
  it('serves the recorder bundle like /s.js: JavaScript, cacheable for an hour, with a validator', async () => {
    const res = await call(makeEnv(), { method: 'GET', path: '/rec.js' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/javascript');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(res.headers.get('ETag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await res.text()).toBe(recorderStub);
  });

  it('answers 304 to a matching validator and has its own, apart from /s.js', async () => {
    const testEnv = makeEnv();
    const etag = (await call(testEnv, { method: 'GET', path: '/rec.js' })).headers.get('ETag')!;
    const core = (await call(testEnv, { method: 'GET', path: '/s.js' })).headers.get('ETag');

    const again = await call(testEnv, { method: 'GET', path: '/rec.js', headers: { 'If-None-Match': etag } });

    expect(again.status).toBe(304);
    expect(core).not.toBe(etag);
  });

  it('needs no project, so it never touches KV', async () => {
    const testEnv = makeEnv();
    await call(testEnv, { method: 'GET', path: '/rec.js' });
    expect(testEnv.kv.get).not.toHaveBeenCalled();
  });
});
