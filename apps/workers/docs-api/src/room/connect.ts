/**
 * The room socket: `GET /api/docs/connect?ticket=<room id>.<secret>`.
 *
 * Browsers cannot put a bearer token on a WebSocket, so the socket does not
 * go through the API's auth chain. The session route (which does) checks
 * access and asks the document's room for a single-use ticket; the ticket names
 * the room, and the room itself checks the secret. This handler runs before
 * Hono, whose middleware would try to rewrite the 101 response's headers.
 */

import { DOC_CONNECT_PATH } from '@weldsuite/app-api-client/schemas/docs';
import type { Env } from '../types';

const TICKET = /^([0-9a-f]{64})\.[\w-]{16,}$/;

export function isConnectRequest(request: Request): boolean {
  return new URL(request.url).pathname === DOC_CONNECT_PATH;
}

export async function connectToRoom(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
  const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
  const match = TICKET.exec(ticket);
  if (!match) return new Response('Invalid ticket', { status: 401 });
  let id: DurableObjectId;
  try {
    id = env.DOC_ROOM.idFromString(match[1]!);
  } catch {
    return new Response('Invalid ticket', { status: 401 });
  }
  return env.DOC_ROOM.get(id).fetch(request);
}
