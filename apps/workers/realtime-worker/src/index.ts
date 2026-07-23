import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from './lib/protocol';
import { AUTH_HEADERS } from './lib/protocol';
import { verifyClerkJwt, verifyAuth, pemToBuffer, base64UrlToBuffer } from './lib/auth';
import {
  getWorkspacePermissions,
  getConversationPermissions,
  getChatPermissions,
} from './lib/permissions';
import { getTenantDbForWorkspace } from './lib/db';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';

// Re-export DO classes for wrangler
export { WorkspaceHub } from './durable-objects/workspace-hub';
export { ConversationRoom } from './durable-objects/conversation-room';
export { ChatRoom } from './durable-objects/chat-room';
export { WhiteboardRoom } from './durable-objects/whiteboard-room';
export { DocumentRoom } from './durable-objects/document-room';
export { SupportRoom } from './durable-objects/support-room';

const app = new Hono<{ Bindings: Env }>();

/**
 * Guard for /publish/* endpoints. Service-binding callers (other CF workers)
 * are trusted because they can't be reached from the public internet. Requests
 * that arrive over the public network — identified by the presence of a
 * `cf-connecting-ip` header that Cloudflare sets on edge requests — must
 * supply the matching `x-internal-secret` header.
 */
app.use('/publish/*', async (c, next) => {
  const isPublic = c.req.header('cf-connecting-ip') !== undefined;
  if (!isPublic) {
    return next();
  }
  const expected = c.env.REALTIME_INTERNAL_SECRET;
  if (!expected) {
    return c.text('Forbidden: REALTIME_INTERNAL_SECRET not configured', 403);
  }
  const provided = c.req.header('x-internal-secret');
  if (provided !== expected) {
    return c.text('Forbidden', 403);
  }
  return next();
});

/**
 * Cross-tenant ownership guard for resource-keyed rooms (conversation,
 * whiteboard, document). Durable Objects here are addressed by a bare,
 * globally-unique resource id, so verifying the JWT is not enough — an
 * authenticated user in workspace A must not be able to join a room whose
 * resource belongs to workspace B just by knowing its id.
 *
 * Each workspace has its own physical tenant DB, so "does a row with this id
 * exist in the caller's tenant DB?" IS the ownership check — a resource from
 * another workspace simply isn't present. Mirrors the ChatRoom membership gate.
 * Fail-closed: a DB error rejects rather than falling through.
 *
 * Returns `null` when access is allowed, or an error Response to return to the
 * caller when it is not.
 */
async function assertResourceInWorkspace(
  c: Context<{ Bindings: Env }>,
  workspaceId: string,
  table: typeof schema.projects | typeof schema.helpdeskConversations,
  id: string,
  label: string,
): Promise<Response | null> {
  try {
    const db = await getTenantDbForWorkspace(c.env, workspaceId);
    const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
    if (!row) {
      return c.text(`Forbidden: ${label} not found`, 403);
    }
    return null;
  } catch (dbErr) {
    console.error(`[realtime] ${label} access check failed:`, (dbErr as Error).message);
    return c.text(`Internal error checking ${label} access`, 500);
  }
}

// ============================================
// WorkspaceHub — always-on workspace connection
// ============================================

/** Client WebSocket upgrade — authenticate and forward to WorkspaceHub DO */
app.get('/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  let auth;
  try {
    auth = await verifyClerkJwt(c);
  } catch (err) {
    console.error('[realtime /ws] Auth failed:', (err as Error).message);
    return c.text(`Unauthorized: ${(err as Error).message}`, 401);
  }

  console.log('[realtime /ws] Authenticated:', auth.userId, 'workspace:', auth.workspaceId);

  const permissions = getWorkspacePermissions(auth);
  const id = c.env.WORKSPACE_HUB.idFromName(auth.workspaceId);
  const stub = c.env.WORKSPACE_HUB.get(id);

  // Forward the upgrade request to the DO with auth info in headers
  const headers = new Headers(c.req.raw.headers);
  headers.set(AUTH_HEADERS.USER_ID, auth.userId);
  headers.set(AUTH_HEADERS.USER_NAME, auth.userName);
  headers.set(AUTH_HEADERS.ROLE, auth.role);
  headers.set(AUTH_HEADERS.SUBSCRIBE_TOPICS, permissions.subscribe.join(','));
  headers.set(AUTH_HEADERS.WORKSPACE_ID, auth.workspaceId);

  return stub.fetch(new Request(c.req.url, { headers, method: 'GET' }));
});

/** Workers publish events to a workspace */
app.post('/publish/workspace', async (c) => {
  const body = await c.req.json<{
    workspaceId: string;
    topic: string;
    event: string;
    data: unknown;
    userId: string;
  }>();

  const id = c.env.WORKSPACE_HUB.idFromName(body.workspaceId);
  const stub = c.env.WORKSPACE_HUB.get(id);

  return stub.fetch('https://internal/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: body.topic,
      event: body.event,
      data: body.data,
      userId: body.userId,
    }),
  });
});

// ============================================
// ConversationRoom — per-conversation connection
// ============================================

/** Client WebSocket upgrade — forward to ConversationRoom DO.
 *  Accepts both authenticated agents (Clerk JWT) and unauthenticated
 *  widget customers (query params: customerId, customerName). */
app.get('/ws/conversation/:conversationId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const conversationId = c.req.param('conversationId');
  const url = new URL(c.req.url);

  let userId: string;
  let userName: string;
  let role: string;
  let userType: string;
  let canPublish: boolean;

  // Try Clerk JWT first (agents), fall back to query params (widget customers)
  try {
    const auth = await verifyClerkJwt(c);

    // Cross-tenant gate: the conversation must exist in the agent's own tenant
    // DB. Without this, any authenticated user could join another workspace's
    // helpdesk conversation stream by id. (The widget-customer path below is
    // intentionally capability-based — the random conversation id is the bearer.)
    const denied = await assertResourceInWorkspace(
      c,
      auth.workspaceId,
      schema.helpdeskConversations,
      conversationId,
      'conversation',
    );
    if (denied) return denied;

    const permissions = getConversationPermissions(auth, conversationId);
    userId = auth.userId;
    userName = auth.userName;
    role = permissions.role;
    userType = 'agent';
    canPublish = permissions.canPublish;
  } catch {
    // No valid JWT — treat as widget customer.
    userId = url.searchParams.get('customerId') || `anon_${Date.now()}`;
    userName = url.searchParams.get('customerName') || 'Customer';
    role = 'customer';
    userType = 'customer';
    canPublish = true;
  }

  const id = c.env.CONVERSATION_ROOM.idFromName(conversationId);
  const stub = c.env.CONVERSATION_ROOM.get(id);

  const headers = new Headers(c.req.raw.headers);
  headers.set(AUTH_HEADERS.USER_ID, userId);
  headers.set(AUTH_HEADERS.USER_NAME, userName);
  headers.set(AUTH_HEADERS.ROLE, role);
  headers.set(AUTH_HEADERS.TYPE, userType);
  headers.set(AUTH_HEADERS.CAN_PUBLISH, String(canPublish));

  return stub.fetch(new Request(c.req.url, { headers, method: 'GET' }));
});

/** Workers publish to a conversation (messages, system events, AI tokens) */
app.post('/publish/conversation/:conversationId', async (c) => {
  const conversationId = c.req.param('conversationId');
  const body = await c.req.json();

  const id = c.env.CONVERSATION_ROOM.idFromName(conversationId);
  const stub = c.env.CONVERSATION_ROOM.get(id);

  return stub.fetch('https://internal/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

// ============================================
// ChatRoom — per-channel/DM connection
// ============================================

/** Client WebSocket upgrade — authenticate and forward to ChatRoom DO.
 *  Accepts Clerk JWTs from authenticated users AND unauthenticated meeting
 *  guests when the channel is a meeting chat room (`meet_*`). Guests pass
 *  `guestUserId` + `guestName` via query params, mirroring the widget pattern
 *  used by ConversationRoom. Anyone with the meeting join code can already
 *  participate in the meeting itself, so this matches the existing trust
 *  boundary. */
app.get('/ws/chat/:channelId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const channelId = c.req.param('channelId');
  const isMeetingChannel = channelId.startsWith('meet_');

  let userId: string;
  let userName: string;
  let role: string;
  let canPublish: boolean;

  try {
    const auth = await verifyClerkJwt(c);
    const permissions = getChatPermissions(auth, channelId);
    userId = auth.userId;
    userName = auth.userName;
    role = permissions.role;
    canPublish = permissions.canPublish;

    // Channel-membership gate: verify the authenticated user may access this
    // channel (public channel or an explicit membership row). This prevents any
    // workspace member from joining a private channel or DM they are not part of.
    //
    // Meeting chat rooms (`meet_*`) are NOT backed by a chatChannels row — they
    // are reachable only via the meeting join code, which is the trust boundary
    // (same as the guest path below). Skip the membership query for them so
    // authenticated meeting participants aren't wrongly rejected.
    if (!isMeetingChannel) {
      try {
        const db = await getTenantDbForWorkspace(c.env, auth.workspaceId);
        const { chatChannels, chatChannelMembers } = schema;

        const [channel] = await db
          .select({ id: chatChannels.id, type: chatChannels.type })
          .from(chatChannels)
          .where(and(eq(chatChannels.id, channelId), isNull(chatChannels.deletedAt)))
          .limit(1);

        if (!channel) {
          return c.text('Forbidden: channel not found', 403);
        }

        if (channel.type !== 'public') {
          const [membership] = await db
            .select({ id: chatChannelMembers.id })
            .from(chatChannelMembers)
            .where(
              and(
                eq(chatChannelMembers.channelId, channelId),
                eq(chatChannelMembers.userId, auth.userId),
              ),
            )
            .limit(1);

          if (!membership) {
            return c.text('Forbidden: not a member of this channel', 403);
          }
        }
      } catch (dbErr) {
        console.error('[realtime /ws/chat] Channel access check failed:', (dbErr as Error).message);
        return c.text('Internal error checking channel access', 500);
      }
    }
  } catch (err) {
    if (!isMeetingChannel) {
      return c.text(`Unauthorized: ${(err as Error).message}`, 401);
    }
    // Meeting guest path — no JWT required; channel is keyed meet_* which is
    // only reachable via the meeting join code, so the join-code acts as the
    // trust boundary. No DB membership check needed.
    const url = new URL(c.req.url);
    const guestUserId = url.searchParams.get('guestUserId');
    const guestName = url.searchParams.get('guestName');
    if (!guestUserId || !guestName) {
      return c.text('Unauthorized: missing guest credentials', 401);
    }
    userId = guestUserId;
    userName = guestName;
    role = 'guest';
    canPublish = true;
  }

  const id = c.env.CHAT_ROOM.idFromName(channelId);
  const stub = c.env.CHAT_ROOM.get(id);

  const headers = new Headers(c.req.raw.headers);
  headers.set(AUTH_HEADERS.USER_ID, userId);
  headers.set(AUTH_HEADERS.USER_NAME, userName);
  headers.set(AUTH_HEADERS.ROLE, role);
  headers.set(AUTH_HEADERS.CAN_PUBLISH, String(canPublish));

  return stub.fetch(new Request(c.req.url, { headers, method: 'GET' }));
});

/** Workers publish to a chat channel (messages, reactions, pins, calls) */
app.post('/publish/chat/:channelId', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json();

  const id = c.env.CHAT_ROOM.idFromName(channelId);
  const stub = c.env.CHAT_ROOM.get(id);

  return stub.fetch('https://internal/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

// ============================================
// WhiteboardRoom — per-whiteboard connection
// ============================================

/** Client WebSocket upgrade — authenticate and forward to WhiteboardRoom DO */
app.get('/ws/whiteboard/:whiteboardId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  let auth;
  try {
    auth = await verifyClerkJwt(c);
  } catch (err) {
    return c.text(`Unauthorized: ${(err as Error).message}`, 401);
  }

  const whiteboardId = c.req.param('whiteboardId');

  // Cross-tenant gate: the whiteboard room key is `${projectId}` or
  // `${projectId}:${whiteboardId}` (see use-whiteboard-collaboration.ts), so the
  // ownership anchor is the project — which must exist in the caller's own tenant
  // DB. Without this, any authenticated user could join another workspace's
  // whiteboard (read + edit) by id. Whiteboards are project-scoped, so a project
  // owned by the caller's workspace implies the whiteboard is theirs too.
  const whiteboardProjectId = whiteboardId.split(':')[0];
  const denied = await assertResourceInWorkspace(
    c,
    auth.workspaceId,
    schema.projects,
    whiteboardProjectId,
    'whiteboard project',
  );
  if (denied) return denied;

  const id = c.env.WHITEBOARD_ROOM.idFromName(whiteboardId);
  const stub = c.env.WHITEBOARD_ROOM.get(id);

  // Client sends sessionId as query param for multi-tab support
  const sessionId = new URL(c.req.url).searchParams.get('sessionId') || crypto.randomUUID();

  const headers = new Headers(c.req.raw.headers);
  headers.set(AUTH_HEADERS.USER_ID, auth.userId);
  headers.set(AUTH_HEADERS.USER_NAME, auth.userName);
  headers.set('x-rt-session-id', sessionId);

  return stub.fetch(new Request(c.req.url, { headers, method: 'GET' }));
});

/** Workers publish to a whiteboard */
app.post('/publish/whiteboard/:whiteboardId', async (c) => {
  const whiteboardId = c.req.param('whiteboardId');
  const body = await c.req.json();

  const id = c.env.WHITEBOARD_ROOM.idFromName(whiteboardId);
  const stub = c.env.WHITEBOARD_ROOM.get(id);

  return stub.fetch('https://internal/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

// ============================================
// DocumentRoom — per-document collaboration
// ============================================

/** Client WebSocket upgrade — authenticate and forward to DocumentRoom DO */
app.get('/ws/document/:documentId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  let auth;
  try {
    auth = await verifyClerkJwt(c);
  } catch (err) {
    return c.text(`Unauthorized: ${(err as Error).message}`, 401);
  }

  const documentId = c.req.param('documentId');

  // SECURITY (deferred, tracked): DocumentRoom has no cross-tenant ownership gate
  // yet — an authenticated user could join another workspace's document room by
  // id. It is NOT gated here because the room key's format is unverified and the
  // feature currently has no platform consumer (no `useDocumentRoom` call site),
  // so a wrong table/id guess would fail-closed against a real fix later. Add the
  // gate (mirror the whiteboard/conversation checks, on the confirmed backing
  // table) when the collaborative-document feature is wired up and its room-key
  // format is pinned down. See .claude/weldchat-realtime-security-audit.md.
  const id = c.env.DOCUMENT_ROOM.idFromName(documentId);
  const stub = c.env.DOCUMENT_ROOM.get(id);

  const sessionId = new URL(c.req.url).searchParams.get('sessionId') || crypto.randomUUID();

  const headers = new Headers(c.req.raw.headers);
  headers.set(AUTH_HEADERS.USER_ID, auth.userId);
  headers.set(AUTH_HEADERS.USER_NAME, auth.userName);
  headers.set('x-rt-session-id', sessionId);

  return stub.fetch(new Request(c.req.url, { headers, method: 'GET' }));
});

/** Workers publish to a document room */
app.post('/publish/document/:documentId', async (c) => {
  const documentId = c.req.param('documentId');
  const body = await c.req.json();

  const id = c.env.DOCUMENT_ROOM.idFromName(documentId);
  const stub = c.env.DOCUMENT_ROOM.get(id);

  return stub.fetch('https://internal/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

// ============================================
// SupportRoom — per-workspace enterprise support channel
// ============================================

/** Client WebSocket upgrade — authenticate and forward to SupportRoom DO.
 *  Accepts Clerk JWTs from both the platform and admin Clerk instances.
 *  The room is keyed by workspaceId (clerkOrgId). */
app.get('/ws/support/:workspaceId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const workspaceId = c.req.param('workspaceId');

  // Extract JWT from query param, Authorization header, or WebSocket subprotocol.
  const url = new URL(c.req.url);
  let token: string | undefined = url.searchParams.get('token') ?? undefined;
  if (!token) {
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);
  }
  if (!token) {
    const protocol = c.req.header('Sec-WebSocket-Protocol');
    if (protocol) {
      const parts = protocol.split(', ');
      const idx = parts.indexOf('authorization');
      if (idx >= 0 && parts[idx + 1]) token = parts[idx + 1];
    }
  }

  if (!token) {
    return c.text('Unauthorized: Missing token', 401);
  }

  // Verify JWT signature against both Clerk instances (platform + admin).
  // Try platform key first, then admin key.
  let payload: any;
  const jwtParts = token.split('.');
  if (jwtParts.length !== 3) {
    return c.text('Unauthorized: Invalid JWT format', 401);
  }

  // Verify against the platform key first, then the admin key. Track WHICH key
  // matched: the 'support' role must be reserved for admin-instance tokens, not
  // inferred from an org mismatch (see role assignment below).
  const keyEntries = [
    { pem: c.env.CLERK_JWT_KEY, isAdmin: false },
    { pem: c.env.ADMIN_CLERK_JWT_KEY, isAdmin: true },
  ].filter((k) => Boolean(k.pem)) as { pem: string; isAdmin: boolean }[];
  let verified = false;
  let verifiedByAdminKey = false;

  for (const { pem, isAdmin } of keyEntries) {
    try {
      const keyData = pemToBuffer(pem);
      const cryptoKey = await crypto.subtle.importKey(
        'spki',
        keyData,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );

      const signedData = new TextEncoder().encode(`${jwtParts[0]}.${jwtParts[1]}`);
      const signature = base64UrlToBuffer(jwtParts[2]);

      const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signedData);
      if (valid) {
        payload = JSON.parse(atob(jwtParts[1].replace(/-/g, '+').replace(/_/g, '/')));
        verified = true;
        verifiedByAdminKey = isAdmin;
        break;
      }
    } catch {
      // Key didn't match — try next
    }
  }

  if (!verified || !payload) {
    return c.text('Unauthorized: Token verification failed', 401);
  }

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return c.text('Unauthorized: Token expired', 401);
  }
  if (!payload.sub) {
    return c.text('Unauthorized: Invalid token', 401);
  }

  const userId = payload.sub;
  // Clerk JWTs don't include name by default — read from query param fallback
  const userName = url.searchParams.get('userName') || payload.name || payload.first_name || 'Unknown';
  // Platform tokens have org (o.id), admin tokens don't.
  const userOrgId = payload.o?.id || payload.org_id || null;

  // Role must come from WHICH Clerk instance signed the token, not from an org
  // mismatch. Previously any platform user whose org !== :workspaceId was auto-
  // granted 'support' and could join another workspace's enterprise support
  // channel. Now: admin-instance token => 'support'; platform token => 'customer'
  // only for its OWN workspace, otherwise rejected.
  if (!verifiedByAdminKey && userOrgId !== workspaceId) {
    return c.text('Forbidden: not a member of this workspace', 403);
  }
  const role = verifiedByAdminKey ? 'support' : 'customer';

  const id = c.env.SUPPORT_ROOM.idFromName(workspaceId);
  const stub = c.env.SUPPORT_ROOM.get(id);

  const headers = new Headers(c.req.raw.headers);
  headers.set(AUTH_HEADERS.USER_ID, userId);
  headers.set(AUTH_HEADERS.USER_NAME, userName);
  headers.set(AUTH_HEADERS.ROLE, role);

  return stub.fetch(new Request(c.req.url, { headers, method: 'GET' }));
});

/** Workers publish to a support channel (messages from API workers) */
app.post('/publish/support/:workspaceId', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const body = await c.req.json();

  const id = c.env.SUPPORT_ROOM.idFromName(workspaceId);
  const stub = c.env.SUPPORT_ROOM.get(id);

  return stub.fetch('https://internal/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

// ============================================
// Health check
// ============================================

app.get('/health', (c) => c.json({ status: 'ok', service: 'realtime-worker' }));

export default app;
