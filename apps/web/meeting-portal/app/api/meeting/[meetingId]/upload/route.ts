import { NextRequest, NextResponse } from 'next/server';
import { getTenantDb } from '@/lib/db';
import { uploadToR2, isR2Configured } from '@/lib/storage/r2';
import { guestUnauthorized, notActiveParticipant, tenantNotFoundResponse } from '@/lib/api-response';
import { authenticateGuest, verifyGuestParticipant } from '@/lib/guest-session';

interface RouteContext {
  params: Promise<{ meetingId: string }>;
}

/** 25 MB — mirrors the platform's chat attachment cap. */
const MAX_FILE_SIZE = 25 * 1024 * 1024;

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomUUID().replace(/-/g, '').substring(0, 8);
  return `${prefix}_${ts}${rand}`;
}

/**
 * POST /api/meeting/[meetingId]/upload
 * Authorization: Bearer <guest session token from /api/meeting/join>
 * multipart/form-data: orgId, file
 *
 * Guest file upload for in-meeting chat. Verifies the token's guest is an
 * active participant (same check as message send),
 * streams the file to R2, and returns a persisted attachment with a real,
 * shareable URL that the platform host can render.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { meetingId } = await context.params;

  if (!isR2Configured()) {
    console.error('[MeetingPortal] Upload rejected — R2 not configured');
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'File uploads are not configured' } },
      { status: 500 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Expected multipart/form-data' } },
      { status: 400 },
    );
  }

  const orgId = String(form.get('orgId') ?? '').trim();
  const file = form.get('file');

  if (!orgId || !(file instanceof File)) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'orgId and file are required' } },
      { status: 400 },
    );
  }

  const claims = authenticateGuest(request.headers, orgId, meetingId);
  if (!claims) return guestUnauthorized();

  if (file.size === 0) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Empty file' } },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: { code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds the 25 MB limit' } },
      { status: 413 },
    );
  }

  try {
    const { db } = await getTenantDb(orgId);

    const participant = await verifyGuestParticipant(db, claims);
    if (!participant) return notActiveParticipant();

    const attachmentId = generateId('matt');
    const safeName = (file.name || 'file').replace(/[^\w.-]+/g, '_').slice(0, 120);
    const key = `meeting-attachments/${meetingId}/${attachmentId}-${safeName}`;
    const contentType = file.type || 'application/octet-stream';
    const body = new Uint8Array(await file.arrayBuffer());

    const url = await uploadToR2(key, body, contentType);

    return NextResponse.json(
      {
        data: {
          id: attachmentId,
          fileName: file.name,
          fileSize: file.size,
          mimeType: contentType,
          url,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    const notFound = tenantNotFoundResponse(err);
    if (notFound) return notFound;
    console.error('[MeetingPortal] Failed to upload attachment:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to upload file' } },
      { status: 500 },
    );
  }
}
