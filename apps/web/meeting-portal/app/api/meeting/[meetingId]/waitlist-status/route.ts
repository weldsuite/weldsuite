import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getTenantDb } from '@/lib/db';
import { meetingSessionWaitlist } from '@weldsuite/db/schema';
import { waitlistStatusQuerySchema } from '@/lib/schemas';
import { invalidInput } from '@/lib/api-response';

/**
 * GET /api/meeting/[meetingId]/waitlist-status?orgId=X&waitlistId=Y
 *
 * Public — guests on the meeting-portal poll this every 3 seconds while
 * sitting on the waitlist screen. Returns { status: 'pending' | 'admitted'
 * | 'denied' }. When 'admitted', the portal re-calls /api/meeting/join to
 * mint the RTK token.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string }> },
) {
  const { meetingId } = await context.params;
  const parsed = waitlistStatusQuerySchema.safeParse({
    orgId: request.nextUrl.searchParams.get('orgId'),
    waitlistId: request.nextUrl.searchParams.get('waitlistId'),
  });
  if (!parsed.success) return invalidInput(parsed.error);
  const { orgId, waitlistId } = parsed.data;

  try {
    const { db } = await getTenantDb(orgId);
    const [row] = await db
      .select()
      .from(meetingSessionWaitlist)
      .where(eq(meetingSessionWaitlist.id, waitlistId))
      .limit(1);

    if (!row || row.meetingId !== meetingId) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Waitlist entry not found' } },
        { status: 404 },
      );
    }

    return NextResponse.json({
      data: { status: row.status as 'pending' | 'admitted' | 'denied' },
    });
  } catch (err) {
    console.error('[MeetingPortal] waitlist-status failed:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to fetch waitlist status' } },
      { status: 500 },
    );
  }
}
