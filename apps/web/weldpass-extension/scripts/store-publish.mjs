#!/usr/bin/env node
/**
 * Uploads the store zip (`pnpm --filter weldpass-extension zip`) to the Chrome
 * Web Store or Edge Add-ons and submits it for review. The release workflow
 * (`.github/workflows/release-weldpass-extension.yml`) runs it on a
 * `weldpass-extension-v*` tag; the one-time setup is in store/README.md.
 *
 *   node scripts/store-publish.mjs chrome <zip>
 *     CHROME_WEB_STORE_PUBLISHER_ID, CHROME_WEB_STORE_ITEM_ID,
 *     CHROME_WEB_STORE_TOKEN (an OAuth access token with the chromewebstore
 *     scope), CHROME_WEB_STORE_STAGED=true to hold an approved version until
 *     someone presses Publish in the developer dashboard.
 *   node scripts/store-publish.mjs edge <zip>
 *     EDGE_ADDONS_PRODUCT_ID, EDGE_ADDONS_CLIENT_ID, EDGE_ADDONS_API_KEY.
 *
 * Neither store's API can create an item, so the first version of each is
 * uploaded by hand. No dependencies: it runs on plain Node without an install.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME_API = 'https://chromewebstore.googleapis.com';
const EDGE_API = 'https://api.addons.microsoftedge.microsoft.com';

// What a Chrome Web Store submission can be in right after it is made.
const CHROME_SUBMITTED = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

export class StoreError extends Error {}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Compares Chrome extension versions (one to four dot-separated integers). */
export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/** The store's own words for a failure (never the request's headers), as ": …" or "". */
function storeSays(body) {
  const details = [body.error?.message, body.errorCode, body.message, body.text].filter(Boolean);
  const errors = (body.errors ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.message)).filter(Boolean);
  const words = [...details, ...errors].join(': ');
  return words ? ': ' + words : '';
}

function failure(what, response, body) {
  return new StoreError(`${what} failed (HTTP ${response.status})${storeSays(body)}`);
}

function versionsOf(revision) {
  return (revision?.distributionChannels ?? []).map((channel) => channel.crxVersion).filter(Boolean);
}

/**
 * Chrome Web Store API v2: checks what the store already has, uploads the zip,
 * waits for the upload to be processed and submits it for review.
 * Returns `{ state, skipped }`; `state` is the store's item state.
 */
export async function publishChrome({
  zip,
  version,
  publisherId,
  itemId,
  token,
  staged = false,
  fetch = globalThis.fetch,
  sleep = wait,
  log = console.log,
  pollIntervalMs = 5_000,
  timeoutMs = 300_000,
}) {
  const item = `${CHROME_API}/v2/publishers/${publisherId}/items/${itemId}`;
  const auth = { Authorization: `Bearer ${token}` };

  async function status() {
    const response = await fetch(`${item}:fetchStatus`, { headers: auth });
    const body = await readBody(response);
    if (!response.ok) throw failure('Reading the item', response, body);
    return body;
  }

  const current = await status();
  const submitted = current.submittedItemRevisionStatus;
  const inReview = versionsOf(submitted);
  const live = versionsOf(current.publishedItemRevisionStatus);
  if (inReview.includes(version)) {
    log(`Chrome Web Store: ${version} is already submitted (${submitted.state}); nothing uploaded.`);
    return { state: submitted.state, skipped: true };
  }
  if (live.includes(version)) {
    log(`Chrome Web Store: ${version} is already published; nothing uploaded.`);
    return { state: 'PUBLISHED', skipped: true };
  }
  if (submitted?.state === 'PENDING_REVIEW') {
    throw new StoreError(
      `Chrome Web Store: ${inReview.join(', ')} is still in review. Wait for the review, or cancel it in the developer dashboard, then re-run this job.`,
    );
  }
  const newest = [...live, ...inReview].sort(compareVersions).at(-1);
  if (newest && compareVersions(version, newest) <= 0) {
    throw new StoreError(
      `Chrome Web Store: ${version} is not higher than ${newest}, the store's newest. Bump version in apps/web/weldpass-extension/package.json.`,
    );
  }

  log(`Chrome Web Store: uploading ${version} (${(zip.length / 1024).toFixed(0)} KB)`);
  const upload = await fetch(`${CHROME_API}/upload/v2/publishers/${publisherId}/items/${itemId}:upload`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/zip' },
    body: zip,
  });
  const uploaded = await readBody(upload);
  if (!upload.ok) throw failure('Chrome Web Store upload', upload, uploaded);
  let state = uploaded.uploadState;
  for (let waited = 0; state === 'IN_PROGRESS'; waited += pollIntervalMs) {
    if (waited >= timeoutMs) throw new StoreError('Chrome Web Store: the upload is still being processed; check the dashboard.');
    await sleep(pollIntervalMs);
    state = (await status()).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') throw new StoreError(`Chrome Web Store: the upload ended ${state ?? 'without a state'}.`);
  if (uploaded.crxVersion && uploaded.crxVersion !== version) {
    throw new StoreError(`Chrome Web Store: the store read version ${uploaded.crxVersion} from the zip, not ${version}.`);
  }

  const publish = await fetch(`${item}:publish`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH' }),
  });
  const published = await readBody(publish);
  if (!publish.ok) throw failure('Chrome Web Store submission', publish, published);
  for (const warning of published.warningInfo?.warnings ?? []) {
    log(`Chrome Web Store warning: ${warning.reason}: ${warning.description}`);
  }
  if (!CHROME_SUBMITTED.has(published.state)) {
    throw new StoreError(`Chrome Web Store: the submission came back ${published.state ?? 'without a state'}.`);
  }
  log(`Chrome Web Store: ${version} submitted (${published.state}).`);
  return { state: published.state, skipped: false };
}

/** An Edge operation id from a 202's Location header (bare, or the end of a URL). */
function operationId(response, what) {
  const id = (response.headers.get('location') ?? '').split('?')[0].split('/').filter(Boolean).at(-1);
  if (!id) throw new StoreError(`${what}: the response had no Location header to follow.`);
  return id;
}

/**
 * Edge Add-ons API v1.1: uploads the zip to the draft, waits for it, then
 * submits the draft for certification and waits for the submission to be
 * accepted. Returns the store's message for the submission.
 */
export async function publishEdge({
  zip,
  version,
  productId,
  clientId,
  apiKey,
  notes = '',
  fetch = globalThis.fetch,
  sleep = wait,
  log = console.log,
  pollIntervalMs = 5_000,
  timeoutMs = 300_000,
}) {
  const product = `${EDGE_API}/v1/products/${productId}`;
  const auth = { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId };

  async function follow(url, what) {
    for (let waited = 0; ; waited += pollIntervalMs) {
      const response = await fetch(url, { headers: auth });
      const body = await readBody(response);
      if (!response.ok) throw failure(what, response, body);
      if (body.status === 'Succeeded') return body;
      if (body.status !== 'InProgress') {
        const hint = body.errorCode === 'InProgressSubmission' ? ' A submission is still in review; re-run this job once it is through.' : '';
        throw new StoreError(`${what} failed${storeSays(body)}.${hint}`);
      }
      if (waited >= timeoutMs) throw new StoreError(`${what} is still in progress; check Partner Center.`);
      await sleep(pollIntervalMs);
    }
  }

  log(`Edge Add-ons: uploading ${version} (${(zip.length / 1024).toFixed(0)} KB)`);
  const upload = await fetch(`${product}/submissions/draft/package`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/zip' },
    body: zip,
  });
  if (upload.status !== 202) throw failure('Edge Add-ons upload', upload, await readBody(upload));
  await follow(`${product}/submissions/draft/package/operations/${operationId(upload, 'Edge Add-ons upload')}`, 'Edge Add-ons upload');

  const submit = await fetch(`${product}/submissions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  });
  if (submit.status !== 202) throw failure('Edge Add-ons submission', submit, await readBody(submit));
  const done = await follow(
    `${product}/submissions/operations/${operationId(submit, 'Edge Add-ons submission')}`,
    'Edge Add-ons submission',
  );
  log(`Edge Add-ons: ${version} submitted. ${done.message ?? ''}`.trim());
  return { message: done.message ?? '' };
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new StoreError(`${name} is not set.`);
  return value;
}

const CHROME_OUTCOME = {
  PENDING_REVIEW: (staged) =>
    staged ? 'in review; once approved it waits for **Publish** in the developer dashboard' : 'in review; it goes live once approved',
  STAGED: () => 'approved and staged; press **Publish** in the developer dashboard',
  PUBLISHED: () => 'published',
  PUBLISHED_TO_TESTERS: () => 'published to testers',
};

export async function main(args, { env = process.env, fetch = globalThis.fetch, log = console.log } = {}) {
  const [store, zipPath] = args;
  if (!['chrome', 'edge'].includes(store) || !zipPath) {
    throw new StoreError('Usage: node scripts/store-publish.mjs chrome|edge <zip>');
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const zip = readFileSync(zipPath);
  let summary;

  if (store === 'chrome') {
    const staged = env.CHROME_WEB_STORE_STAGED === 'true';
    const result = await publishChrome({
      zip,
      version,
      publisherId: required(env, 'CHROME_WEB_STORE_PUBLISHER_ID'),
      itemId: required(env, 'CHROME_WEB_STORE_ITEM_ID'),
      token: required(env, 'CHROME_WEB_STORE_TOKEN'),
      staged,
      fetch,
      log,
    });
    const outcome = result.skipped ? 'already there; nothing uploaded' : (CHROME_OUTCOME[result.state]?.(staged) ?? result.state);
    summary = `### Chrome Web Store\n\nWeldPass ${version}: ${outcome}.\n`;
  } else {
    const source = env.GITHUB_SHA
      ? ` Source: ${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/tree/${env.GITHUB_SHA}/apps/web/weldpass-extension`
      : '';
    await publishEdge({
      zip,
      version,
      productId: required(env, 'EDGE_ADDONS_PRODUCT_ID'),
      clientId: required(env, 'EDGE_ADDONS_CLIENT_ID'),
      apiKey: required(env, 'EDGE_ADDONS_API_KEY'),
      notes: `WeldPass ${version}, built and uploaded by the release workflow.${source}`,
      fetch,
      log,
    });
    summary = `### Edge Add-ons\n\nWeldPass ${version}: submitted for certification; it goes live once approved.\n`;
  }

  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof StoreError ? error.message : `${error?.stack ?? error}`;
    console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : message);
    process.exit(1);
  });
}
