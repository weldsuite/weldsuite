import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compareVersions, main, publishChrome, publishEdge } from './store-publish.mjs';

/** A fake store: each "METHOD url" answers from its queue, repeating the last answer. */
function fakeStore(routes) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, headers: init.headers ?? {}, body: init.body });
    const queue = routes[`${method} ${url}`];
    if (!queue?.length) throw new Error(`unexpected ${method} ${url}`);
    return (queue.length > 1 ? queue.shift() : queue[0])();
  });
  return { fetch, calls };
}

const json = (body, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const accepted = (location) => () => new Response(null, { status: 202, headers: { Location: location } });

const zip = Buffer.from('PK the store zip');
const quiet = { sleep: async () => {}, log: () => {} };

describe('compareVersions', () => {
  it('compares dot-separated integers, not strings', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0.400', '0.2.0.1000')).toBe(-1);
  });
});

describe('publishChrome', () => {
  const ITEM = 'https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/item-1';
  const STATUS = `GET ${ITEM}:fetchStatus`;
  const UPLOAD = 'POST https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/item-1:upload';
  const PUBLISH = `POST ${ITEM}:publish`;
  const revision = (crxVersion, state = 'PUBLISHED') => ({ state, distributionChannels: [{ deployPercentage: 100, crxVersion }] });
  const run = (fetch, options = {}) =>
    publishChrome({ zip, version: '0.2.0', publisherId: 'pub-1', itemId: 'item-1', token: 'secret-token', fetch, ...quiet, ...options });

  it('uploads the zip and submits it for review', async () => {
    const { fetch, calls } = fakeStore({
      [STATUS]: [json({ publishedItemRevisionStatus: revision('0.1.0') })],
      [UPLOAD]: [json({ uploadState: 'SUCCEEDED', crxVersion: '0.2.0' })],
      [PUBLISH]: [json({ state: 'PENDING_REVIEW' })],
    });
    await expect(run(fetch)).resolves.toEqual({ state: 'PENDING_REVIEW', skipped: false });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'POST']);
    expect(calls[1].headers).toMatchObject({ Authorization: 'Bearer secret-token', 'Content-Type': 'application/zip' });
    expect(calls[1].body).toBe(zip);
    expect(JSON.parse(calls[2].body)).toEqual({ publishType: 'DEFAULT_PUBLISH' });
  });

  it('holds an approved version for the dashboard when staged', async () => {
    const { fetch, calls } = fakeStore({
      [STATUS]: [json({})],
      [UPLOAD]: [json({ uploadState: 'SUCCEEDED', crxVersion: '0.2.0' })],
      [PUBLISH]: [json({ state: 'PENDING_REVIEW' })],
    });
    await run(fetch, { staged: true });
    expect(JSON.parse(calls[2].body)).toEqual({ publishType: 'STAGED_PUBLISH' });
  });

  it('waits while the store processes the upload', async () => {
    const sleep = vi.fn(async () => {});
    const { fetch } = fakeStore({
      [STATUS]: [json({}), json({ lastAsyncUploadState: 'IN_PROGRESS' }), json({ lastAsyncUploadState: 'SUCCEEDED' })],
      [UPLOAD]: [json({ uploadState: 'IN_PROGRESS' })],
      [PUBLISH]: [json({ state: 'PENDING_REVIEW' })],
    });
    await expect(run(fetch, { sleep })).resolves.toMatchObject({ state: 'PENDING_REVIEW' });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up on an upload that stays in progress', async () => {
    const { fetch, calls } = fakeStore({
      [STATUS]: [json({}), json({ lastAsyncUploadState: 'IN_PROGRESS' })],
      [UPLOAD]: [json({ uploadState: 'IN_PROGRESS' })],
    });
    await expect(run(fetch, { pollIntervalMs: 5, timeoutMs: 20 })).rejects.toThrow(/still being processed/);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(5);
  });

  it('uploads nothing when the version is already submitted or published', async () => {
    const inReview = fakeStore({ [STATUS]: [json({ submittedItemRevisionStatus: revision('0.2.0', 'PENDING_REVIEW') })] });
    await expect(run(inReview.fetch)).resolves.toEqual({ state: 'PENDING_REVIEW', skipped: true });
    expect(inReview.calls).toHaveLength(1);

    const live = fakeStore({ [STATUS]: [json({ publishedItemRevisionStatus: revision('0.2.0') })] });
    await expect(run(live.fetch)).resolves.toEqual({ state: 'PUBLISHED', skipped: true });
    expect(live.calls).toHaveLength(1);
  });

  it('refuses while another version is in review', async () => {
    const { fetch, calls } = fakeStore({ [STATUS]: [json({ submittedItemRevisionStatus: revision('0.1.5', 'PENDING_REVIEW') })] });
    await expect(run(fetch)).rejects.toThrow(/0\.1\.5 is still in review/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a version that is not higher than the store has', async () => {
    const { fetch, calls } = fakeStore({ [STATUS]: [json({ publishedItemRevisionStatus: revision('0.10.0') })] });
    await expect(run(fetch)).rejects.toThrow(/0\.2\.0 is not higher than 0\.10\.0/);
    expect(calls).toHaveLength(1);
  });

  it("passes on the store's error, never the token", async () => {
    const { fetch } = fakeStore({ [STATUS]: [json({ error: { code: 403, message: 'The caller does not have permission' } }, 403)] });
    const attempt = run(fetch);
    await expect(attempt).rejects.toThrow(/HTTP 403.*does not have permission/);
    await expect(attempt).rejects.not.toThrow('secret-token');
  });

  it('stops when the upload fails or the submission is rejected', async () => {
    const failed = fakeStore({ [STATUS]: [json({})], [UPLOAD]: [json({ uploadState: 'FAILED' })] });
    await expect(run(failed.fetch)).rejects.toThrow(/upload ended FAILED/);
    expect(failed.calls.map((call) => call.url)).not.toContain(`${ITEM}:publish`);

    const rejected = fakeStore({
      [STATUS]: [json({})],
      [UPLOAD]: [json({ uploadState: 'SUCCEEDED' })],
      [PUBLISH]: [json({ state: 'REJECTED' })],
    });
    await expect(run(rejected.fetch)).rejects.toThrow(/came back REJECTED/);
  });
});

describe('publishEdge', () => {
  const PRODUCT = 'https://api.addons.microsoftedge.microsoft.com/v1/products/prod-1';
  const run = (fetch) =>
    publishEdge({ zip, version: '0.2.0', productId: 'prod-1', clientId: 'client-1', apiKey: 'secret-key', notes: 'WeldPass 0.2.0', fetch, ...quiet });

  it('uploads the zip, waits for it, then submits the draft', async () => {
    const { fetch, calls } = fakeStore({
      [`POST ${PRODUCT}/submissions/draft/package`]: [accepted('op-upload')],
      [`GET ${PRODUCT}/submissions/draft/package/operations/op-upload`]: [json({ status: 'InProgress' }), json({ status: 'Succeeded' })],
      // The Location header may be a whole URL rather than a bare id.
      [`POST ${PRODUCT}/submissions`]: [accepted(`${PRODUCT}/submissions/operations/op-submit`)],
      [`GET ${PRODUCT}/submissions/operations/op-submit`]: [json({ status: 'Succeeded', message: 'Successfully created submission with ID 7' })],
    });
    await expect(run(fetch)).resolves.toEqual({ message: 'Successfully created submission with ID 7' });
    expect(calls[0].headers).toMatchObject({ Authorization: 'ApiKey secret-key', 'X-ClientID': 'client-1', 'Content-Type': 'application/zip' });
    expect(calls[0].body).toBe(zip);
    expect(JSON.parse(calls[3].body)).toEqual({ notes: 'WeldPass 0.2.0' });
  });

  it('explains a submission refused because another one is in review', async () => {
    const { fetch } = fakeStore({
      [`POST ${PRODUCT}/submissions/draft/package`]: [accepted('op-upload')],
      [`GET ${PRODUCT}/submissions/draft/package/operations/op-upload`]: [json({ status: 'Succeeded' })],
      [`POST ${PRODUCT}/submissions`]: [accepted('op-submit')],
      [`GET ${PRODUCT}/submissions/operations/op-submit`]: [
        json({ status: 'Failed', errorCode: 'InProgressSubmission', message: 'Your extension submission is in progress.' }),
      ],
    });
    await expect(run(fetch)).rejects.toThrow(/InProgressSubmission.*still in review/);
  });

  it("passes on a refused upload's status, never the key", async () => {
    const { fetch } = fakeStore({ [`POST ${PRODUCT}/submissions/draft/package`]: [json({ message: 'Unauthorized' }, 401)] });
    const attempt = run(fetch);
    await expect(attempt).rejects.toThrow('Edge Add-ons upload failed (HTTP 401): Unauthorized');
    await expect(attempt).rejects.not.toThrow('secret-key');
  });
});

describe('main', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const dir = mkdtempSync(path.join(tmpdir(), 'store-publish-'));
  const zipPath = path.join(dir, 'weldpass-extension.zip');
  writeFileSync(zipPath, zip);

  it('refuses an unknown store or a missing setting', async () => {
    await expect(main(['firefox', zipPath], { env: {} })).rejects.toThrow(/Usage/);
    await expect(main(['chrome', zipPath], { env: {} })).rejects.toThrow('CHROME_WEB_STORE_PUBLISHER_ID is not set.');
    await expect(main(['edge', zipPath], { env: {} })).rejects.toThrow('EDGE_ADDONS_PRODUCT_ID is not set.');
  });

  it("submits package.json's version and writes the outcome to the step summary", async () => {
    const summary = path.join(dir, 'summary.md');
    const item = 'https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/item-1';
    const { fetch, calls } = fakeStore({
      [`GET ${item}:fetchStatus`]: [json({})],
      ['POST https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/item-1:upload']: [
        json({ uploadState: 'SUCCEEDED', crxVersion: version }),
      ],
      [`POST ${item}:publish`]: [json({ state: 'PENDING_REVIEW' })],
    });
    const env = {
      CHROME_WEB_STORE_PUBLISHER_ID: 'pub-1',
      CHROME_WEB_STORE_ITEM_ID: 'item-1',
      CHROME_WEB_STORE_TOKEN: 'secret-token',
      GITHUB_STEP_SUMMARY: summary,
    };
    await main(['chrome', zipPath], { env, fetch, log: () => {} });
    expect(calls[1].body).toEqual(zip);
    expect(readFileSync(summary, 'utf8')).toContain(`WeldPass ${version}: in review; it goes live once approved.`);
  });
});
