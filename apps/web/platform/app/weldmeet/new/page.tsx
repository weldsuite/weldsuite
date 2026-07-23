import { useState, useRef, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@clerk/clerk-react';
import { useCreateMeeting, useJoinByCode, useUpcomingMeetings } from '@/hooks/queries/use-weldmeet-queries';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { setStartHandoff } from '@/lib/weldmeet/start-handoff';
import { useWeldMeetCallOptional } from '@/contexts/weldmeet-call-context';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Video, Plus, Link2, Calendar, Keyboard, Clock, Users, ChevronRight, ClipboardType, Copy, Check, X, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@weldsuite/ui/components/dialog';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { useVirtualBackgroundPreference } from '@/hooks/use-virtual-background';

import { QuickCreateCard } from '@/app/weldcalendar/components/calendar-view';
import { useUserCalendars } from '@/hooks/queries/use-calendar-queries';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

export default function NewMeetingPage() {
  const t = getTranslations('weldmeet');
  const navigate = useNavigate();
  const { orgId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  const createMeeting = useCreateMeeting();
  const joinByCode = useJoinByCode();
  const { getClient: getAppApiClient } = useAppApiClient();
  const meetCtx = useWeldMeetCallOptional();
  const prewarmMedia = meetCtx?.prewarmMedia;
  const { data: upcomingMeetings } = useUpcomingMeetings({ days: 7, limit: 3 });

  const { data: calendarsData } = useUserCalendars();
  const calendars = calendarsData?.data ?? [];

  const { backgroundType, backgroundValue, setBlur, setImage, clear: clearBackground } = useVirtualBackgroundPreference();

  const [joinCode, setJoinCode] = useState('');
  const [meetingLink, setMeetingLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const newMeetingRef = useRef<HTMLDivElement>(null);

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
    } catch (err: any) {
      toast.error(t.newMeetingPage.failedToCreate, {
        description: err?.response?.data?.error || err?.message || t.newMeetingPage.failedToCreateHint,
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
      // app-api create returns { id } only — fetch the full meeting to get joinCode
      const client = await getAppApiClient();
      const meetingRes = await client.get<{ data: { joinCode: string } }>(`/meetings/${created.id}`);
      const joinCode = meetingRes.data?.joinCode;
      const meetingPortalUrl = import.meta.env.VITE_MEETING_PORTAL_URL || window.location.origin;
      const url = `${meetingPortalUrl}/${workspaceId}/${joinCode}`;
      setMeetingLink(url);
    } catch (err: any) {
      toast.error(t.newMeetingPage.failedToCreate, {
        description: err?.response?.data?.error || err?.message || t.newMeetingPage.failedToCreateHint,
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
      if (newMeetingRef.current && !newMeetingRef.current.contains(e.target as Node)) {
        setMeetingLink(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [meetingLink]);

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    try {
      const meeting = await joinByCode.mutateAsync(joinCode.trim());
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
        <div className="flex items-center gap-3 mt-8 px-6">
          <div ref={newMeetingRef} className="relative">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="lg" className="gap-2 rounded-lg">
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
              <div className="absolute top-full left-0 mt-2 z-50 w-[340px] bg-popover border rounded-xl shadow-lg animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200">
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
                  <MeetingReadyAddPeople meetingLink={meetingLink} />
                </div>
              </div>
            )}
          </div>

          <div className="relative group/input">
            <Keyboard className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t.newMeetingPage.enterCodePlaceholder}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              className="pl-10 pr-10 w-64 h-10 rounded-lg"
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
          <div className="w-full max-w-xl mx-auto px-6 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">{t.newMeetingPage.upcomingMeetings}</h2>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => navigate({ to: '/weldmeet' })}
              >
                {t.newMeetingPage.viewAll}
                <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
            <div className="space-y-2">
              {upcomingMeetings.map((meeting: any) => (
                <Card
                  key={meeting.id}
                  className="cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() =>
                    navigate({ to: '/weldmeet/$meetingId', params: { meetingId: meeting.id } })
                  }
                >
                  <CardContent className="flex items-center justify-between py-3 px-4">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Video className="h-4 w-4 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{meeting.title}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {meeting.scheduledStart && (
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {format(new Date(meeting.scheduledStart), 'MMM d, h:mm a')}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Users className="h-3 w-3" />
                            {meeting.attendees?.length ?? 0}
                          </span>
                        </div>
                      </div>
                    </div>
                    {meeting.status === 'in_progress' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded-full dark:bg-green-900 dark:text-green-200">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                        {t.newMeetingPage.live}
                      </span>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

      </div>

      {scheduleOpen && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onClick={() => setScheduleOpen(false)}
          />
          <div
            className="absolute z-[70] w-[360px] bg-popover border rounded-lg shadow-lg animate-in fade-in-0 zoom-in-95"
            style={{
              top: newMeetingRef.current ? newMeetingRef.current.getBoundingClientRect().top : '50%',
              left: newMeetingRef.current ? newMeetingRef.current.getBoundingClientRect().left - 360 - 8 : '50%',
            }}
          >
            <QuickCreateCard
              defaultType="event"
              calendars={calendars}
              defaultCalendarId={calendars[0]?.id}
              onClose={() => setScheduleOpen(false)}
              onMoreOptions={() => setScheduleOpen(false)}
              showTypeTabs={false}
            />
          </div>
        </>
      )}
    </div>
  );
}

function MeetingReadyAddPeople({ meetingLink }: { meetingLink: string }) {
  const t = getTranslations('weldmeet');
  const { data: membersData } = useWorkspaceMembers(1, 50);
  const [search, setSearch] = useState('');
  const [invited, setInvited] = useState<Set<string>>(new Set());

  const members = (membersData?.data ?? []).filter((m: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q));
  });

  const handleInvite = (member: any) => {
    setInvited(prev => new Set(prev).add(member.userId));
    try { navigator.clipboard.writeText(meetingLink); } catch { /* ignore */ }
  };

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
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder={t.newMeetingPage.searchByNameOrEmail}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-[35px] text-xs pl-8"
            autoFocus
          />
        </div>

        <div className="max-h-[300px] overflow-y-auto -mx-4 px-4 -mt-2">
          {members.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">{t.newMeetingPage.noMembersFound}</p>
          )}
          {members.map((m: any) => {
            const isInvited = invited.has(m.userId);
            return (
              <div key={m.userId} className="flex items-center gap-3 py-2.5">
                <Avatar className="h-7 w-7 !rounded-[8px]">
                  <AvatarFallback className="text-[10px] !rounded-[8px]">
                    {(m.name ?? m.email ?? '?').charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{m.name ?? t.newMeetingPage.unknown}</p>
                  {m.email && <p className="text-xs text-muted-foreground truncate">{m.email}</p>}
                </div>
                <Button
                  size="sm"
                  variant={isInvited ? 'ghost' : 'outline'}
                  className="shrink-0"
                  onClick={() => handleInvite(m)}
                  disabled={isInvited}
                >
                  {isInvited ? (
                    <><Check className="h-3.5 w-3.5" /> {t.newMeetingPage.invited}</>
                  ) : (
                    t.newMeetingPage.invite
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
