/**
 * The WeldDesk BI feed: an OData 4.0 service (read-only) on the public API,
 * `GET /v1/odata/…`, scope `reports:read`, so Power BI and Excel can read
 * helpdesk data.
 *
 *   GET /v1/odata/                 service document
 *   GET /v1/odata/$metadata        CSDL
 *   GET /v1/odata/<Set>            rows (`$top $skip $skiptoken $select $orderby $filter $count $format`)
 *   GET /v1/odata/<Set>/$count     number of rows, text/plain
 *   GET /v1/odata/<Set>('<key>')   one row
 *
 * Writes answer 405, valid OData that is not served (`$expand`, `$apply`,
 * other functions, navigation) 501, a malformed request 400. The sets, their
 * properties and everything that is checked against them are in `catalog.ts`;
 * the payloads are OData 4.0 JSON with minimal metadata. The key layer accepts
 * HTTP Basic (the password is the API key) on this path only
 * (`middleware/auth.ts`), because that is what Power BI's connector offers.
 */

import { Hono, type Context } from 'hono';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { findEntitySet } from '@weldsuite/desk-domain/odata-catalog';
import { ODataError } from './errors';
import { contextUrl, metadataXml, nextLink, serviceDocument } from './metadata';
import { countRows, fetchEntity, fetchPage, parseQueryOptions } from './query';

export const ODATA_READ_SCOPE = 'reports:read';

const JSON_TYPE = 'application/json;odata.metadata=minimal';
const ROOT_PATH = '/v1/odata';
const WRITE_ALLOW = 'GET, HEAD, OPTIONS';

/**
 * Every answer of the feed: its OData version, and `nosniff`, so a browser
 * that is sent to a feed URL never reads an answer as anything but what its
 * Content-Type says (an error message repeats text from the request).
 */
const feedHeaders = (contentType: string) => ({
  'Content-Type': contentType,
  'OData-Version': '4.0',
  'X-Content-Type-Options': 'nosniff',
});

/** The CSDL and `$count`: text this service wrote itself, never text from the request. */
function respond(c: Context<HonoEnv>, body: string, contentType: 'application/xml' | 'text/plain') {
  return c.body(body, 200, feedHeaders(contentType));
}

function jsonResponse(c: Context<HonoEnv>, payload: unknown, status: 200 | 400 | 404 | 405 | 415 | 501 = 200) {
  return c.json(payload, status, feedHeaders(JSON_TYPE));
}

function errorResponse(c: Context<HonoEnv>, error: ODataError) {
  return jsonResponse(c, { error: { code: error.code, message: error.message } }, error.status);
}

/** `Conversations`, `Conversations('abc')` (with `''` for a quote) or `Conversations()`. */
function parseSegment(segment: string): { name: string; key: string | null } {
  const match = /^(\w+)(?:\((.*)\))?$/s.exec(segment);
  if (!match) throw new ODataError(404, `Resource not found: ${segment}`);
  const inner = match[2];
  if (inner === undefined || inner === '') return { name: match[1]!, key: null };
  const quoted = /^'((?:[^']|'')*)'$/s.exec(inner);
  if (!quoted) throw new ODataError(400, 'A key must be a string in single quotes, like Conversations(\'cnv_1\')');
  const key = quoted[1]!.replace(/''/g, "'");
  // Postgres refuses a NUL in a text parameter, so no key holds one.
  if (key.includes('\u0000')) throw new ODataError(400, 'A key must not contain a NUL character');
  return { name: match[1]!, key };
}

function pathSegments(c: Context<HonoEnv>): string[] {
  const path = c.req.path;
  const index = path.indexOf(ROOT_PATH);
  const rest = index === -1 ? '' : path.slice(index + ROOT_PATH.length);
  return rest
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw new ODataError(400, 'The path is not valid percent-encoding');
      }
    });
}

async function handle(c: Context<HonoEnv>) {
  const url = new URL(c.req.url);
  const root = `${url.origin}${ROOT_PATH}`;
  const segments = pathSegments(c);

  if (segments.length === 0) return jsonResponse(c, serviceDocument(root));

  if (segments[0] === '$metadata' && segments.length === 1) {
    return respond(c, metadataXml(), 'application/xml');
  }

  const { name, key } = parseSegment(segments[0]!);
  const set = findEntitySet(name);
  if (!set) throw new ODataError(404, `The entity set '${name}' does not exist`);
  const db = c.get('tenantDb');

  if (segments.length === 2 && segments[1] === '$count' && key === null) {
    const options = parseQueryOptions(url.searchParams, set, 'count');
    return respond(c, String(await countRows(db, set, options.filter)), 'text/plain');
  }
  if (segments.length > 1) throw new ODataError(501, 'Navigation properties and other resource paths are not supported');

  if (key !== null) {
    const options = parseQueryOptions(url.searchParams, set, 'entity');
    const entity = await fetchEntity(db, set, key, options.select);
    if (!entity) throw new ODataError(404, `${set.entityType} '${key}' not found`);
    return jsonResponse(c, { '@odata.context': contextUrl(root, set, options.select, true), ...entity });
  }

  const options = parseQueryOptions(url.searchParams, set, 'collection');
  const page = await fetchPage(db, set, options);
  const payload: Record<string, unknown> = { '@odata.context': contextUrl(root, set, options.select) };
  if (page.total !== null) payload['@odata.count'] = page.total;
  payload.value = page.rows;
  // `$top` that ends with this page is not linked on.
  if (page.next && page.remainingTop !== 0) payload['@odata.nextLink'] = nextLink(url, page.next, page.remainingTop);
  return jsonResponse(c, payload);
}

const app = new Hono<HonoEnv>();

// Read-only: anything that would write is a 405 (after the key layer, so a missing key is still a 401).
app.use('*', async (c, next) => {
  c.header('OData-Version', '4.0');
  c.header('X-Content-Type-Options', 'nosniff');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
    c.header('Allow', WRITE_ALLOW);
    return jsonResponse(c, { error: { code: 'MethodNotAllowed', message: 'The OData feed is read-only.' } }, 405);
  }
  await next();
});

app.use('*', requireScope(ODATA_READ_SCOPE));

app.all('*', async (c) => {
  try {
    return await handle(c);
  } catch (error) {
    if (error instanceof ODataError) return errorResponse(c, error);
    throw error;
  }
});


export default app;
