import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull, lt, desc } from 'drizzle-orm';
import { getTenantDb } from '@/lib/db';
import {
  meetingMessages,
  people,
} from '@weldsuite/db/schema';
import { sql } from 'drizzle-orm';
import { messagesListQuerySchema, messagesPostInputSchema } from '@/lib/schemas';
import { invalidInput } from '@/lib/api-response';
import { verifyGuestParticipant } from '@/lib/meeting-guest';

interface RouteContext {
  params: Promise<{ meetingId: string }>;
}

function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * GET /api/meeting/[meetingId]/messages?orgId=X&email=Y&before=Z&limit=N
 * List meeting chat messages (newest first, cursor pagination via `before` message id).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const { meetingId } = await context.params;
  const url = request.nextUrl;
  const parsed = messagesListQuerySchema.safeParse({
    orgId: url.searchParams.get('orgId'),
    email: url.searchParams.get('email'),
    before: url.searchParams.get('before') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) return invalidInput(parsed.error);
  const { orgId, email, before, limit } = parsed.data;

  try {
    const { db } = await getTenantDb(orgId);

    const participant = await verifyGuestParticipant(db, meetingId, email);
    if (!participant) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'Not an active meeting participant' } },
        { status: 403 },
      );
    }

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
    console.error('[MeetingPortal] Failed to list messages:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to list messages' } },
      { status: 500 },
    );
  }
}

/**
 * POST /api/meeting/[meetingId]/messages
 * Body: { orgId, email, name, content }
 * Send a chat message as a meeting guest. Persists to DB and broadcasts via
 * the realtime-worker so platform participants see it live.
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
  const { orgId, email, name, content: trimmed, attachments, htmlContent } = parsed.data;
  const hasAttachments = (attachments?.length ?? 0) > 0;
  // Rich-text HTML is stored in metadata (no dedicated column) and surfaced at
  // the top level in responses + the realtime payload.
  const metadata = htmlContent ? { htmlContent } : null;

  try {
    const { db } = await getTenantDb(orgId);

    const participant = await verifyGuestParticipant(db, meetingId, email);
    if (!participant) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'Not an active meeting participant' } },
        { status: 403 },
      );
    }

    // Resolve avatar from the people table (matches what /join does via
    // findOrCreatePersonByEmail). Renamed from `contacts` after the Companies
    // + People identity refactor.
    let authorAvatar: string | null = participant.userAvatar ?? null;
    if (!authorAvatar) {
      const [matched] = await db
        .select({ avatarUrl: people.avatarUrl })
        .from(people)
        .where(and(
          sql`lower(${people.email}) = lower(${email})`,
          isNull(people.deletedAt),
        ))
        .limit(1);
      authorAvatar = matched?.avatarUrl ?? null;
    }

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
    // message live. Best-effort — don't fail the request if it errors — but DO
    // surface failures: a silently-dropped broadcast is exactly what makes a
    // guest message invisible to the host until a manual refetch.
    const realtimeUrl = process.env.REALTIME_WORKER_URL;
    const realtimeSecret = process.env.REALTIME_INTERNAL_SECRET;
    let realtimeDelivered = false;

    if (!realtimeUrl) {
      console.warn(
        '[weldmeet-chat] Realtime broadcast skipped — REALTIME_WORKER_URL env var is missing. Guest messages will not reach the host live.',
      );
    } else if (!realtimeSecret) {
      console.warn(
        '[weldmeet-chat] Realtime broadcast skipped — REALTIME_INTERNAL_SECRET env var is missing. Guest messages will not reach the host live.',
      );
    } else {
      const pubTarget = `${realtimeUrl.replace(/\/$/, '')}/publish/chat/meet_${meetingId}`;
      try {
        const pubRes = await fetch(
          pubTarget,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-secret': realtimeSecret,
            },
            body: JSON.stringify({
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
            }),
          },
        );
        if (!pubRes.ok) {
          // fetch() does not throw on non-2xx — a 403 (secret mismatch) or 5xx
          // would otherwise be swallowed and the host would never get the push.
          const body = await pubRes.text().catch(() => '');
          console.error(
            `[weldmeet-chat] Realtime publish rejected: status=${pubRes.status} url=${pubTarget} body=${body}`,
          );
        } else {
          realtimeDelivered = true;
        }
      } catch (e) {
        console.error(`[weldmeet-chat] Realtime publish fetch failed: url=${pubTarget}`, e);
      }
    }

    return NextResponse.json({ data: { ...message, realtimeDelivered } }, { status: 201 });
  } catch (err) {
    console.error('[MeetingPortal] Failed to send message:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to send message' } },
      { status: 500 },
    );
  }
}
