import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useAuth } from '@clerk/clerk-react';
import { useCreateMeeting, useJoinByCode, useMeeting, useUpcomingMeetings, type Meeting } from '@/hooks/queries/use-weldmeet-queries';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { setStartHandoff } from '@/lib/weldmeet/start-handoff';
import { buildMeetingShareUrl, parseMeetingJoinInput } from '@/lib/weldmeet/share-link';
import { useWeldMeetCallOptional } from '@/contexts/weldmeet-call-context';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Plus, Link2, Calendar, Keyboard, ChevronRight, ClipboardType, Copy, Check, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@weldsuite/ui/components/dialog';
import { MeetingInvitePicker } from '../components/meeting-invite-picker';

import { QuickCreateCard } from '@/app/weldcalendar/components/calendar-view';
import { useUserCalendars } from '@/hooks/queries/use-calendar-queries';
import { placeCardNearAnchor } from '@/app/weldcalendar/lib/popover-position';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

export default function NewMeetingPage() {
  const t = getTranslations('weldmeet');
  const navigate = useNavigate();
  const { orgId, userId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  useBreadcrumbs([{ label: getTranslations('navigation').moduleSidebar.weldmeet.newMeeting }]);
  // "Schedule again" arrives with the id of the meeting to copy.
  // This component is mounted by both /weldmeet/ and /weldmeet/new/, so the
  // search is read non-strictly and `from` is validated here.
  const search = useSearch({ strict: false }) as { from?: unknown };
  const scheduleFromId = typeof search.from === 'string' && search.from ? search.from : undefined;
  const { data: sourceMeeting } = useMeeting(scheduleFromId ?? '');
  const createMeeting = useCreateMeeting();
  const joinByCode = useJoinByCode();
  const { getClient: getAppApiClient } = useAppApiClient();
  const meetCtx = useWeldMeetCallOptional();
  const prewarmMedia = meetCtx?.prewarmMedia;
  const { data: upcomingMeetings } = useUpcomingMeetings({ days: 7, limit: 3 });

  const { data: calendarsData } = useUserCalendars();
  const calendars = calendarsData?.data ?? [];

  const [joinCode, setJoinCode] = useState('');
  const [meetingLink, setMeetingLink] = useState<string | null>(null);
  const [createdMeetingId, setCreatedMeetingId] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // The meeting "Schedule again" copies its title, description and guests from.
  const [scheduleSeed, setScheduleSeed] = useState<Meeting | null>(null);
  const consumedScheduleFromRef = useRef<string | null>(null);
  const newMeetingRef = useRef<HTMLDivElement>(null);

  // Open the schedule card once, as soon as the meeting to copy has loaded,
  // then drop `from` from the URL so a reload or "back" starts clean.
  useEffect(() => {
    if (!scheduleFromId || !sourceMeeting) return;
    if (consumedScheduleFromRef.current === scheduleFromId) return;
    consumedScheduleFromRef.current = scheduleFromId;
    setScheduleSeed(sourceMeeting);
    setScheduleOpen(true);
    void navigate({ to: '.', search: {}, replace: true });
  }, [scheduleFromId, sourceMeeting, navigate]);

  const closeSchedule = () => {
    setScheduleOpen(false);
    setScheduleSeed(null);
  };

  // Keyboard users dismiss the schedule card (and its click-away backdrop) with Escape.
  useEffect(() => {
    if (!scheduleOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setScheduleOpen(false);
      setScheduleSeed(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [scheduleOpen]);

  // Guests of the copied meeting: its invitees, without the organizer and without you.
  const scheduleDefaultGuests = scheduleSeed
    ? (scheduleSeed.attendees ?? [])
        .filter((a) =>
          !!a.email &&
          a.role !== 'organizer' &&
          a.userId !== scheduleSeed.organizerId &&
          (!userId || a.userId !== userId),
        )
        .map((a) => ({ email: a.email, name: a.name || undefined }))
    : undefined;

  const handleInstantMeeting = async () => {
    void prewarmMedia?.();

    try {
      const client = await getAppApiClient();
      // app-api returns { data: { meetingId, sessionId, authToken, rtkMeetingId, joinCode, participants } }
      const fast = await client.post<{ data: { meetingId: string; sessionId: string; authToken: string; rtkMeetingId: string; joinCode: string } }>(
        '/meetings/start-instant',
        {
          title: 'Instant Meeting',
          meetingType: 'video',
          accessType: 'anyone_with_link',
          waitingRoom: true,
        },
      );
      setStartHandoff({
        meetingId: fast.data.meetingId,
        sessionId: fast.data.sessionId,
        authToken: fast.data.authToken,
        rtkMeetingId: fast.data.rtkMeetingId,
      });
      navigate({ to: '/weldmeet/$meetingId/room', params: { meetingId: fast.data.meetingId } });
      return;
    } catch (fastErr) {
      console.warn('[WeldMeet] start-instant fast path failed, falling back', fastErr);
    }

    try {
      const result = await createMeeting.mutateAsync({
        title: 'Instant Meeting',
        meetingType: 'video',
        accessType: 'anyone_with_link',
        waitingRoom: true,
      });
      navigate({ to: '/weldmeet/$meetingId/room', params: { meetingId: result.id } });
    } catch (err) {
      toast.error(t.newMeetingPage.failedToCreate, {
        description: err instanceof Error ? err.message : t.newMeetingPage.failedToCreateHint,
      });
    }
  };

  const handleCreateForLater = async () => {
    try {
      const created = await createMeeting.mutateAsync({
        title: 'Meeting',
        meetingType: 'video',
        accessType: 'anyone_with_link',
        waitingRoom: true,
      });
      // The create response carries the join code; fall back to fetching the
      // meeting for an API that predates that.
      let code = created.joinCode;
      if (!code) {
        const client = await getAppApiClient();
        const meetingRes = await client.get<{ data: { joinCode: string | null } }>(`/meetings/${created.id}`);
        code = meetingRes.data?.joinCode ?? '';
      }
      const url = buildMeetingShareUrl(workspaceId, code);
      if (!url) {
        // Never show or copy a link that cannot work (e.g. ".../null").
        toast.error(t.newMeetingPage.meetingLinkUnavailable, {
          description: t.newMeetingPage.meetingLinkUnavailableHint,
        });
        return;
      }
      setCreatedMeetingId(created.id);
      setMeetingLink(url);
    } catch (err) {
      toast.error(t.newMeetingPage.failedToCreate, {
        description: err instanceof Error ? err.message : t.newMeetingPage.failedToCreateHint,
      });
    }
  };

  const handleCopyLink = async () => {
    if (!meetingLink) return;
    await navigator.clipboard.writeText(meetingLink);
    setLinkCopied(true);
    toast.success(t.newMeetingPage.meetingLinkCopied);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  // Close meeting link card on click outside
  useEffect(() => {
    if (!meetingLink) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      // The Add people dialog and its toasts are portaled outside the card;
      // interacting with them must not close it.
      if (target.closest?.('[role="dialog"], [data-sonner-toaster]')) return;
      if (newMeetingRef.current && !newMeetingRef.current.contains(target)) {
        setMeetingLink(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [meetingLink]);

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    const parsed = parseMeetingJoinInput(joinCode);
    if (!parsed) {
      toast.error(t.newMeetingPage.meetingNotFound, {
        description: t.newMeetingPage.meetingNotFoundHint,
      });
      return;
    }
    // A portal link of another workspace can't resolve against this tenant;
    // its guest link still works, so offer that instead of "not found".
    if (parsed.workspaceId && workspaceId && parsed.workspaceId !== workspaceId) {
      const guestUrl = parsed.url;
      toast.error(t.newMeetingPage.meetingInOtherWorkspace, {
        description: t.newMeetingPage.meetingInOtherWorkspaceHint,
        action: guestUrl
          ? { label: t.newMeetingPage.openLink, onClick: () => window.open(guestUrl, '_blank', 'noopener,noreferrer') }
          : undefined,
      });
      return;
    }
    try {
      const meeting = await joinByCode.mutateAsync(parsed.joinCode);
      navigate({ to: '/weldmeet/$meetingId/room', params: { meetingId: meeting.id } });
    } catch {
      toast.error(t.newMeetingPage.meetingNotFound, {
        description: t.newMeetingPage.meetingNotFoundHint,
      });
    }
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] -mt-[60px]">
        {/* The hero and action row stay centered; upcoming meetings hang below
            them (absolute) so the list never pushes the hero up. */}
        <div className="relative w-full flex flex-col items-center">
        {/* Hero Section */}
        <div className="text-center max-w-2xl mx-auto px-6">
          <h1
            className="leading-tight font-sans text-[32px] md:text-[48px] text-[#171717] dark:text-foreground"
            style={{ fontWeight: 575, letterSpacing: '-0.02em' }}
          >
            {t.newMeetingPage.heroTitle}
          </h1>
          <p
            className="leading-tight font-sans -mt-1 md:-mt-1.5 text-[32px] md:text-[48px] text-[#888888] dark:text-muted-foreground"
            style={{ fontWeight: 450, letterSpacing: '-0.02em' }}
          >
            {t.newMeetingPage.heroSubtitle}
          </p>
          <p
            className="mt-3 md:mt-4 text-sm md:text-base text-[#666666] dark:text-muted-foreground"
            style={{ fontWeight: 400, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}
          >
            {t.newMeetingPage.heroDescription}
          </p>
        </div>

        {/* Action Row */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mt-8 px-6 w-full max-w-md sm:max-w-none sm:w-auto">
          <div ref={newMeetingRef} className="relative w-full sm:w-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="lg" className="gap-2 rounded-lg w-full sm:w-auto">
                  <Plus className="h-5 w-5" />
                  {t.newMeetingPage.newMeeting}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuItem onClick={handleInstantMeeting} disabled={createMeeting.isPending}>
                  <Plus className="h-4 w-4 mr-0.5" />
                  {t.newMeetingPage.startInstant}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleCreateForLater} disabled={createMeeting.isPending}>
                  <Link2 className="h-4 w-4 mr-0.5" />
                  {t.newMeetingPage.createForLater}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setScheduleOpen(true)}>
                  <Calendar className="h-4 w-4 mr-0.5" />
                  {t.newMeetingPage.scheduleInCalendar}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Meeting ready card */}
            {meetingLink && (
              <div className="absolute top-full left-0 mt-2 z-50 w-[min(340px,calc(100vw-3rem))] bg-popover border rounded-xl shadow-lg animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200">
                <div className="p-5 pb-4">
                  <div className="flex items-start justify-between mb-1">
                    <h3 className="text-[15px] font-semibold">{t.newMeetingPage.meetingReady}</h3>
                    <Button variant="ghost" onClick={() => setMeetingLink(null)} className="p-1.5 -mr-1.5 -mt-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors h-auto w-auto">
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-[14px] text-muted-foreground mb-4">{t.newMeetingPage.meetingReadyDescription}</p>

                  <div className="flex items-center gap-2 h-[35px] rounded-lg border bg-muted/40 pl-3 pr-1">
                    <span className="flex-1 text-[12px] font-mono text-muted-foreground truncate select-all">{meetingLink.replace(/^https?:\/\//, '')}</span>
                    <Button
                      variant="ghost"
                      onClick={handleCopyLink}
                      className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors h-auto w-auto"
                    >
                      {linkCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>

                <div className="px-5 pb-5 -mt-1">
                  {createdMeetingId && <MeetingReadyAddPeople meetingId={createdMeetingId} />}
                </div>
              </div>
            )}
          </div>

          <div className="relative group/input w-full sm:w-auto">
            <Keyboard className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t.newMeetingPage.enterCodePlaceholder}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              className="pl-10 pr-10 w-full sm:w-64 h-10 rounded-lg"
            />
            <Button
              size="icon"
              className={`absolute right-[5px] top-1/2 -translate-y-1/2 h-7 w-7 rounded-md transition-opacity duration-150 ${joinCode.trim() ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
              onClick={handleJoin}
              disabled={joinByCode.isPending}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={`absolute right-[5px] top-1/2 -translate-y-1/2 h-7 w-7 rounded-md transition-opacity duration-150 ${joinCode.trim() ? 'opacity-0 pointer-events-none' : 'opacity-0 group-hover/input:opacity-100'}`}
              onClick={async () => {
                const text = await navigator.clipboard.readText();
                if (text) setJoinCode(text);
              }}
            >
              <ClipboardType className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>


        {/* Upcoming Meetings Preview */}
        {upcomingMeetings && upcomingMeetings.length > 0 && (
          <div className="absolute top-full inset-x-0 w-full max-w-xl mx-auto px-6 pt-12 pb-8">
            <div className="flex items-center justify-between mb-2 pl-1">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t.newMeetingPage.upcomingMeetings}
              </h2>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-foreground -mr-2"
                onClick={() => navigate({ to: '/weldmeet/upcoming' })}
              >
                {t.newMeetingPage.viewAll}
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
            <ul className="space-y-2">
              {upcomingMeetings.map((meeting: Meeting) => {
                const start = meeting.scheduledStart ? new Date(meeting.scheduledStart) : null;
                const end = meeting.scheduledEnd ? new Date(meeting.scheduledEnd) : null;
                return (
                  <li key={meeting.id}>
                    <button
                      type="button"
                      className="group flex w-full items-center gap-3 rounded-2xl bg-muted/50 px-5 py-3.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      onClick={() =>
                        navigate({ to: '/weldmeet/$meetingId', params: { meetingId: meeting.id } })
                      }
                    >
                      <div className="min-w-0 flex-1">
                        {start && (
                          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {format(start, 'EEE, MMM d')} · {format(start, 'h:mm a')}
                            {end && ` – ${format(end, 'h:mm a')}`}
                          </p>
                        )}
                        <p className="mt-0.5 text-base truncate">{meeting.title}</p>
                      </div>
                      {meeting.status === 'in_progress' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded-full dark:bg-green-900 dark:text-green-200 shrink-0">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                          {t.newMeetingPage.live}
                        </span>
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        </div>

      </div>

      {scheduleOpen && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            aria-hidden="true"
            onClick={closeSchedule}
          />
          <SchedulePopover anchorRef={newMeetingRef}>
            <QuickCreateCard
              defaultType="event"
              defaultTitle={scheduleSeed?.title}
              defaultDescription={scheduleSeed?.description}
              defaultGuests={scheduleDefaultGuests}
              defaultWeldMeet={!!scheduleSeed}
              calendars={calendars}
              defaultCalendarId={calendars[0]?.id}
              onClose={closeSchedule}
              showTypeTabs={false}
            />
          </SchedulePopover>
        </>
      )}
    </div>
  );
}

const SCHEDULE_POPOVER_WIDTH = 360;
/** Viewport width under which the card sits below the button instead of beside it. */
const SCHEDULE_NARROW_VIEWPORT = 640;

/**
 * The "Schedule in calendar" card, fixed to the viewport next to the "New
 * meeting" button: left of it on wide screens, below (or above) it otherwise.
 * It is clamped so the whole card, Save button included, stays on screen at any
 * window height and never covers the button, and it follows the card's height
 * as rows expand.
 */
function SchedulePopover({
  anchorRef,
  children,
}: Readonly<{ anchorRef: React.RefObject<HTMLElement | null>; children: React.ReactNode }>) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const place = () => {
      const anchor = anchorRef.current;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const narrow = viewport.width < SCHEDULE_NARROW_VIEWPORT;
      const size = { width: Math.min(SCHEDULE_POPOVER_WIDTH, viewport.width - 16), height: card.offsetHeight };
      if (!anchor) {
        setPos({
          x: Math.max(8, (viewport.width - size.width) / 2),
          y: Math.max(8, (viewport.height - size.height) / 2),
        });
        return;
      }
      setPos(
        placeCardNearAnchor({
          anchor: anchor.getBoundingClientRect(),
          card: size,
          viewport,
          order: narrow ? ['below', 'above'] : ['left', 'below', 'above'],
        }),
      );
    };
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(card);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [anchorRef]);

  return (
    <div
      ref={cardRef}
      className="fixed z-[70] w-[min(360px,calc(100vw-1rem))] bg-popover border rounded-lg shadow-lg animate-in fade-in-0 zoom-in-95"
      style={pos ? { top: pos.y, left: pos.x } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      {children}
    </div>
  );
}

function MeetingReadyAddPeople({ meetingId }: Readonly<{ meetingId: string }>) {
  const t = getTranslations('weldmeet');
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className="w-full gap-2">
          <Plus className="h-3.5 w-3.5" />
          {t.newMeetingPage.addPeople}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px] p-4">
        <DialogHeader>
          <DialogTitle className="text-[17px]">{t.newMeetingPage.addPeople}</DialogTitle>
          <DialogDescription className="sr-only">{t.newMeetingPage.addPeopleDescription}</DialogDescription>
        </DialogHeader>
        <MeetingInvitePicker meetingId={meetingId} />
      </DialogContent>
    </Dialog>
  );
}
