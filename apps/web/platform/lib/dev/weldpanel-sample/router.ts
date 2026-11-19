/**
 * Routes a WeldPanel request to the area that has sample data for it. Each
 * area module exports a handler that returns the response body (what the API
 * would send: `{ data }`, `{ data, pagination }`, `undefined` for a 204, or a
 * `Response` for raw downloads) or `UNHANDLED` when the path isn't its own.
 */

import { UNHANDLED, type SampleRequest } from './request';
import { handleQuery } from './areas/query';
import { handleObjects } from './areas/objects';
import { handleCollab } from './areas/collab';

export { UNHANDLED } from './request';

// Collab before objects: it owns sub-paths of objects' routes (`reports/:id/versions`, `projects/:id/domains`).
const AREAS = [handleQuery, handleCollab, handleObjects];

/** A short pause, so loading states still show while you design. */
function latency(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 250));
}

export async function handleSampleRequest(input: {
  method: SampleRequest['method'];
  path: string;
  body: unknown;
  raw: boolean;
}): Promise<unknown> {
  const url = new URL(input.path, 'http://sample.local');
  const segments = url.pathname.replace(/^\/panel\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const request: SampleRequest = { ...input, segments, query: url.searchParams };
  await latency();
  for (const area of AREAS) {
    const result = area(request);
    if (result !== UNHANDLED) return result;
  }
  return UNHANDLED;
}
