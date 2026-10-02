/**
 * Public recording streaming route — PUBLIC (no Clerk), token only.
 *
 * GET /public/meeting-recordings/:token[?download=1]
 *
 * The token comes from `POST /api/meeting-sessions/:id/recording/access` and maps
 * (KV, 1 h) to ONE object of the private MEETING_RECORDINGS bucket. Serves
 * HTTP Range so `<video>` can seek, and `?download=1` switches to an attachment.
 * Mounted in src/index.ts BEFORE apiAuth(), next to the webhooks.
 *
 * Nothing is mutated here, so there is no entity event; unknown, expired and
 * malformed tokens all answer the same 404 (no oracle).
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import {
  RECORDING_TOKEN_PATTERN,
  parseByteRange,
  recordingTokenKey,
  type RecordingTokenGrant,
} from '../../services/weldmeet/recording-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const notFound = () =>
  new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Recording not found' } }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

app.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!RECORDING_TOKEN_PATTERN.test(token)) return notFound();

  const bucket = c.env.MEETING_RECORDINGS;
  if (!bucket) {
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Recording storage is not configured' } }, 503);
  }

  let grant: RecordingTokenGrant | null;
  try {
    grant = (await c.env.WORKSPACE_CACHE.get(recordingTokenKey(token), 'json')) as RecordingTokenGrant | null;
  } catch (err) {
    console.error('[public-meeting-recordings] token lookup failed:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to read recording' } }, 500);
  }
  // A grant can only ever point inside its own session's prefix.
  if (!grant || !grant.key.startsWith(`${grant.orgId}/${grant.sessionId}/`)) return notFound();

  try {
    const head = await bucket.head(grant.key);
    if (!head) return notFound();

    const range = parseByteRange(c.req.header('Range'), head.size);
    const headers = new Headers({
      'Content-Type': grant.contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; filename="${grant.filename}"`,
      ETag: head.httpEtag,
      'X-Content-Type-Options': 'nosniff',
    });

    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }

    if (range) {
      const object = await bucket.get(grant.key, { range: { offset: range.offset, length: range.length } });
      if (!object) return notFound();
      headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
      headers.set('Content-Length', String(range.length));
      return new Response(object.body, { status: 206, headers });
    }

    const object = await bucket.get(grant.key);
    if (!object) return notFound();
    headers.set('Content-Length', String(head.size));
    return new Response(object.body, { status: 200, headers });
  } catch (err) {
    console.error('[public-meeting-recordings] stream failed:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to read recording' } }, 500);
  }
});

export const publicMeetingRecordingsRoutes = app;
