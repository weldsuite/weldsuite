import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull, lt, desc, sql } from 'drizzle-orm';
import { getTenantDb } from '@/lib/db';
import {
  meetingMessages,
  people,
} from '@weldsuite/db/schema';
import { messagesListQuerySchema, messagesPostInputSchema } from '@/lib/schemas';
import {
  guestUnauthorized,
  invalidInput,
  notActiveParticipant,
  tenantNotFoundResponse,
} from '@/lib/api-response';
import { authenticateGuest, guestEmailFromClaims, verifyGuestParticipant } from '@/lib/guest-session';
import { randomToken } from '@/lib/random-id';

interface RouteContext {
  params: Promise<{ meetingId: string }>;
}

function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = randomToken(8);
  return `${prefix}_${timestamp}${random}`;
}

type TenantDb = Awaited<ReturnType<typeof getTenantDb>>['db'];

/**
 * Resolve avatar from the participant, falling back to the people table
 * (matches what /join does via findOrCreatePersonByEmail). Renamed from
 * `contacts` after the Companies + People identity refactor.
 */
async function resolveAuthorAvatar(
  db: TenantDb,
  participantAvatar: string | null | undefined,
  email: string,
): Promise<string | null> {
  if (participantAvatar) return participantAvatar;
  const [matched] = await db
    .select({ avatarUrl: people.avatarUrl })
    .from(people)
    .where(and(
      sql`lower(${people.email}) = lower(${email})`,
      isNull(people.deletedAt),
    ))
    .limit(1);
  return matched?.avatarUrl ?? null;
}

/**
 * Publish a guest chat frame to the realtime-worker. Failures are surfaced in
 * the logs (a silently-dropped broadcast is exactly what makes a guest message
 * invisible to the host until a manual refetch) but never thrown. Resolves to
 * whether the worker accepted the frame.
 */
async function publishGuestMessage(meetingId: string, frame: Record<string, unknown>): Promise<boolean> {
  const realtimeUrl = process.env.REALTIME_WORKER_URL;
  const realtimeSecret = process.env.REALTIME_INTERNAL_SECRET;

  if (!realtimeUrl) {
    console.warn(
      '[weldmeet-chat] Realtime broadcast skipped — REALTIME_WORKER_URL env var is missing. Guest messages will not reach the host live.',
    );
    return false;
  }
  if (!realtimeSecret) {
    console.warn(
      '[weldmeet-chat] Realtime broadcast skipped — REALTIME_INTERNAL_SECRET env var is missing. Guest messages will not reach the host live.',
    );
    return false;
  }

  const pubTarget = `${realtimeUrl.replace(/\/$/, '')}/publish/chat/meet_${meetingId}`;
  try {
    const pubRes = await fetch(pubTarget, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': realtimeSecret,
      },
      body: JSON.stringify(frame),
    });
    if (pubRes.ok) return true;
    // fetch() does not throw on non-2xx — a 403 (secret mismatch) or 5xx
    // would otherwise be swallowed and the host would never get the push.
    const body = await pubRes.text().catch(() => '');
    console.error(
      `[weldmeet-chat] Realtime publish rejected: status=${pubRes.status} url=${pubTarget} body=${body}`,
    );
  } catch (e) {
    console.error(`[weldmeet-chat] Realtime publish fetch failed: url=${pubTarget}`, e);
  }
  return false;
}

/**
 * GET /api/meeting/[meetingId]/messages?orgId=X&before=Z&limit=N
 * Authorization: Bearer <guest session token from /api/meeting/join>
 * List meeting chat messages (newest first, cursor pagination via `before` message id).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const { meetingId } = await context.params;
  const url = request.nextUrl;
  const parsed = messagesListQuerySchema.safeParse({
    orgId: url.searchParams.get('orgId'),
    before: url.searchParams.get('before') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) return invalidInput(parsed.error);
  const { orgId, before, limit } = parsed.data;

  const claims = authenticateGuest(request.headers, orgId, meetingId);
  if (!claims) return guestUnauthorized();

  try {
    const { db } = await getTenantDb(orgId);

    const participant = await verifyGuestParticipant(db, claims);
    if (!participant) return notActiveParticipant();

    const conditions = [
      eq(meetingMessages.meetingId, meetingId),
      isNull(meetingMessages.deletedAt),
    ];

    if (before) {
      const [cursor] = await db
        .select({ createdAt: meetingMessages.createdAt })
        .from(meetingMessages)
        .where(eq(meetingMessages.id, before))
        .limit(1);
      if (cursor) {
        conditions.push(lt(meetingMessages.createdAt, cursor.createdAt));
      }
    }

    const rows = await db
      .select()
      .from(meetingMessages)
      .where(and(...conditions))
      .orderBy(desc(meetingMessages.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    // Surface rich-text HTML (stored in metadata) at the top level so the
    // guest renders formatting on reload, not just on live receive.
    const withHtml = data.map((m) => ({
      ...m,
      htmlContent: (m.metadata as { htmlContent?: string } | null)?.htmlContent ?? null,
    }));

    return NextResponse.json({
      data: {
        messages: withHtml,
        hasMore,
        nextCursor: hasMore && data.length > 0 ? data[data.length - 1].id : null,
      },
    });
  } catch (err) {
    const notFound = tenantNotFoundResponse(err);
    if (notFound) return notFound;
    console.error('[MeetingPortal] Failed to list messages:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to list messages' } },
      { status: 500 },
    );
  }
}

/**
 * POST /api/meeting/[meetingId]/messages
 * Authorization: Bearer <guest session token from /api/meeting/join>
 * Body: { orgId, content, htmlContent?, attachments? }
 * Send a chat message as a meeting guest. The author is the token's guest,
 * named as they joined. Persists to DB and broadcasts via the realtime-worker
 * so platform participants see it live.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { meetingId } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const parsed = messagesPostInputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const { orgId, content: trimmed, attachments, htmlContent } = parsed.data;
  const hasAttachments = (attachments?.length ?? 0) > 0;
  // Rich-text HTML is stored in metadata (no dedicated column) and surfaced at
  // the top level in responses + the realtime payload.
  const metadata = htmlContent ? { htmlContent } : null;

  const claims = authenticateGuest(request.headers, orgId, meetingId);
  if (!claims) return guestUnauthorized();

  try {
    const { db } = await getTenantDb(orgId);

    const participant = await verifyGuestParticipant(db, claims);
    if (!participant) return notActiveParticipant();

    const email = guestEmailFromClaims(claims);
    const name = participant.userName;

    // Resolve avatar from the people table (matches what /join does via
    // findOrCreatePersonByEmail). Renamed from `contacts` after the Companies
    // + People identity refactor.
    const authorAvatar = await resolveAuthorAvatar(db, participant.userAvatar, email);

    const guestUserId = `guest:${email.toLowerCase()}`;
    const id = generateId('mmsg');
    const now = new Date();

    await db.insert(meetingMessages).values({
      id,
      meetingId,
      authorId: guestUserId,
      authorName: name,
      authorAvatar,
      content: trimmed,
      type: 'message',
      attachments: attachments ?? null,
      hasAttachments,
      metadata,
      createdAt: now,
      updatedAt: now,
    });

    const message = {
      id,
      meetingId,
      authorId: guestUserId,
      authorName: name,
      authorAvatar,
      content: trimmed,
      htmlContent: htmlContent ?? null,
      type: 'message' as const,
      attachments: attachments ?? null,
      hasAttachments,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      deletedAt: null,
      pinnedAt: null,
      pinnedBy: null,
      metadata,
    };

    // Broadcast to realtime-worker so platform participants (the host) see the
    // message live. Best-effort — never fails the request.
    const realtimeDelivered = await publishGuestMessage(meetingId, {
      type: 'message',
      id,
      content: trimmed,
      htmlContent: htmlContent ?? undefined,
      senderId: guestUserId,
      senderName: name,
      senderAvatar: authorAvatar ?? undefined,
      // Mapped to the {id,name,size,type,url} shape the host's
      // roomEventToMessage() reads (same shape the api-worker publisher
      // uses), so attachments render live for platform participants.
      attachments: hasAttachments
        ? attachments!.map((a) => ({
            id: a.id,
            name: a.fileName,
            size: a.fileSize,
            type: a.mimeType,
            url: a.url,
          }))
        : undefined,
      ts: now.getTime(),
    });

    return NextResponse.json({ data: { ...message, realtimeDelivered } }, { status: 201 });
  } catch (err) {
    const notFound = tenantNotFoundResponse(err);
    if (notFound) return notFound;
    console.error('[MeetingPortal] Failed to send message:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to send message' } },
      { status: 500 },
    );
  }
}
