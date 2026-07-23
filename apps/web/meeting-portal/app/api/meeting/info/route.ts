import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { getTenantDb } from '@/lib/db';
import { meetings, workspaceMembers } from '@weldsuite/db/schema';
import { meetingInfoQuerySchema } from '@/lib/schemas';
import { invalidInput } from '@/lib/api-response';

/**
 * GET /api/meeting/info?orgId=X&joinCode=Y
 * Returns public meeting info for the guest landing page.
 */
export async function GET(request: NextRequest) {
  const parsed = meetingInfoQuerySchema.safeParse({
    orgId: request.nextUrl.searchParams.get('orgId'),
    joinCode: request.nextUrl.searchParams.get('joinCode'),
  });
  if (!parsed.success) return invalidInput(parsed.error);
  const { orgId, joinCode } = parsed.data;

  try {
    const { db } = await getTenantDb(orgId);

    const [meeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.joinCode, joinCode), isNull(meetings.deletedAt)))
      .limit(1);

    if (!meeting) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Meeting not found' } },
        { status: 404 },
      );
    }

    if (meeting.accessType === 'workspace') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'This meeting is restricted to workspace members' } },
        { status: 403 },
      );
    }

    let organizerName = 'Host';
    const [organizer] = await db
      .select({ name: workspaceMembers.name })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, meeting.organizerId))
      .limit(1);
    if (organizer?.name) organizerName = organizer.name;

    const attendeesList = (meeting.attendees ?? []).map((a: any) => ({
      name: a.name,
      avatar: a.avatar,
      role: a.role,
    }));

    return NextResponse.json({
      data: {
        id: meeting.id,
        title: meeting.title,
        scheduledStart: meeting.scheduledStart,
        scheduledEnd: meeting.scheduledEnd,
        meetingType: meeting.meetingType,
        status: meeting.status,
        accessType: meeting.accessType,
        organizerName,
        hasActiveSession: !!meeting.activeSessionId,
        attendees: attendeesList,
        // Host controls — surfaced so the portal can client-enforce on first
        // render before any RTK broadcast arrives. Fields are nullable on the
        // row when never explicitly set; portal should treat null as the
        // permissive default (see DEFAULT_HOST_CONTROLS in weldmeet schemas).
        hostControls: {
          hostManagement: meeting.hostManagement ?? true,
          allowScreenShare: meeting.allowScreenShare ?? true,
          allowMicrophone: meeting.allowMicrophone ?? true,
          allowVideo: meeting.allowVideo ?? true,
          allowHandRaise: meeting.allowHandRaise ?? true,
          allowReactions: meeting.allowReactions ?? true,
          allowAnnotations: meeting.allowAnnotations ?? true,
          allowVirtualBackgrounds: meeting.allowVirtualBackgrounds ?? true,
          allowParticipantRecord: meeting.allowParticipantRecord ?? false,
          allowThirdPartyAccess: meeting.allowThirdPartyAccess ?? true,
          noiseCancellation: meeting.noiseCancellation ?? true,
          enableCaptions: meeting.enableCaptions ?? false,
          autoRecord: meeting.autoRecord ?? false,
          hostMustJoinFirst: meeting.hostMustJoinFirst ?? false,
          lockAfterStart: meeting.lockAfterStart ?? false,
          autoEndOnInactivity: meeting.autoEndOnInactivity ?? true,
          autoEndInactivityMinutes: meeting.autoEndInactivityMinutes ?? 10,
        },
        waitingRoom: meeting.waitingRoom ?? false,
      },
    });
  } catch (err) {
    console.error('[MeetingPortal] Failed to get meeting info:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to get meeting info' } },
      { status: 500 },
    );
  }
}
