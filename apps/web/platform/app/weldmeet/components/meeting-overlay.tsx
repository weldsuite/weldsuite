'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Check, Search } from 'lucide-react';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useWeldMeetCall } from '@/contexts/weldmeet-call-context';
import { useMeeting, useUpdateMeeting, useLatestSession, useUpdateHostControls, type MeetingSession } from '@/hooks/queries/use-weldmeet-queries';
import type { RTKParticipant, RTKSelf } from '@cloudflare/realtimekit';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { useWeldAgentDrawerOpen } from '@/hooks/use-weldagent-drawer-open';
import { useMeetingPanelOpen } from '@/hooks/use-meeting-panel-open';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { MeetingChatPanel } from '@/components/call/meeting-chat-panel';
import { BackgroundEffectsPanel } from '@/components/virtual-background-picker';
import { GuestCreatePersonDialog, type GuestCreatePersonTarget } from './guest-create-person-dialog';
import { PeopleEntityListPanel } from './people-entity-panel';
import { useObjectPanel } from '@/components/object-panel';
import {
  MeetingRoomView,
  PreviewView,
  ConnectingView,
  InvitePopover,
  HostControlsPanel,
  type HostControlsValue,
} from '@weldsuite/weldmeet-ui';
import { getTranslations } from '@/lib/i18n';

// ============================================================================
// Platform-specific bits the shared component takes as slots
// ============================================================================

/** A single RTK meeting participant — either the local user (Self) or a remote peer. */
type RtkPerson = RTKParticipant | RTKSelf;

/** Minimal shape needed to resolve/display a participant-details target — real
 * RTK participants and the synthetic object built from a chat author both
 * satisfy this. */
interface ParticipantDetailsTarget {
  id?: string;
  userId?: string;
  customParticipantId?: string;
  name?: string;
  picture?: string | null;
}

/** Session participant record with the workspace-member/person/contact links
 * the resolver writes — not yet reflected in the shared MeetingSession type. */
type SessionParticipantWithLinks = MeetingSession['participants'][number] & {
  workspaceMemberId?: string;
  personId?: string;
  contactId?: string;
  customParticipantId?: string;
};

interface WorkspaceMemberOption {
  userId: string;
  name?: string | null;
  email?: string | null;
}

function AddPeopleDialogContent({ shareUrl }: { shareUrl: string }) {
  const t = getTranslations('weldmeet');
  const { data: membersData } = useWorkspaceMembers(1, 50);
  const [search, setSearch] = useState('');
  const [invited, setInvited] = useState<Set<string>>(new Set());

  const members = (membersData?.data ?? []).filter((m: WorkspaceMemberOption) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q));
  });

  const handleInvite = (member: WorkspaceMemberOption) => {
    setInvited(prev => new Set(prev).add(member.userId));
    try { navigator.clipboard.writeText(shareUrl); } catch { /* ignore */ }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-[17px]">{t.overlay.addPeople.title}</DialogTitle>
      </DialogHeader>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder={t.overlay.addPeople.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-[35px] text-xs pl-8"
          autoFocus
        />
      </div>

      <div className="max-h-[300px] overflow-y-auto -mx-4 px-4 -mt-2">
        {members.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-6">{t.overlay.addPeople.noMembersFound}</p>
        )}
        {members.map((m: WorkspaceMemberOption) => {
          const isInvited = invited.has(m.userId);
          return (
            <div key={m.userId} className="flex items-center gap-3 py-2.5">
              <Avatar className="h-7 w-7 !rounded-[8px]">
                <AvatarFallback className="text-[10px] !rounded-[8px]">
                  {(m.name ?? m.email ?? '?').charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{m.name ?? t.overlay.addPeople.unknown}</p>
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
                  <><Check className="h-3.5 w-3.5" /> {t.overlay.addPeople.invited}</>
                ) : (
                  t.overlay.addPeople.invite
                )}
              </Button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function InvitePopoverContent({ shareUrl }: { shareUrl: string }) {
  const t = getTranslations('weldmeet');
  const { data: membersData } = useWorkspaceMembers(1, 50);
  const [search, setSearch] = useState('');
  const [invited, setInvited] = useState<Set<string>>(new Set());

  const members = (membersData?.data ?? []).filter((m: WorkspaceMemberOption) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q));
  });

  const handleInvite = (member: WorkspaceMemberOption) => {
    setInvited(prev => new Set(prev).add(member.userId));
    try { navigator.clipboard.writeText(shareUrl); } catch { /* ignore */ }
  };

  return (
    <>
      <div className="px-4 pt-4 pb-3">
        <p className="text-sm font-semibold">{t.overlay.invitePopover.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{t.overlay.invitePopover.description}</p>
      </div>

      <div className="px-4 pb-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder={t.overlay.invitePopover.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-[35px] text-xs pl-8"
          />
        </div>
      </div>

      <div className="max-h-[240px] overflow-y-auto px-2 pb-2">
        {members.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">{t.overlay.invitePopover.noMembersFound}</p>
        )}
        {members.map((m: WorkspaceMemberOption) => {
          const isInvited = invited.has(m.userId);
          return (
            <div key={m.userId} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-muted/50">
              <Avatar className="h-7 w-7 !rounded-[8px]">
                <AvatarFallback className="text-[10px] !rounded-[8px]">
                  {(m.name ?? m.email ?? '?').charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate">{m.name ?? t.overlay.invitePopover.unknown}</p>
                {m.email && <p className="text-[11px] text-muted-foreground truncate">{m.email}</p>}
              </div>
              <Button
                size="xs"
                variant={isInvited ? 'ghost' : 'secondary'}
                className="shrink-0"
                onClick={() => handleInvite(m)}
                disabled={isInvited}
              >
                {isInvited ? (
                  <><Check className="h-3 w-3" /> {t.overlay.invitePopover.invited}</>
                ) : (
                  t.overlay.invitePopover.invite
                )}
              </Button>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ============================================================================
// Adapter — pulls from contexts/queries and feeds the shared MeetingRoomView
// ============================================================================

function MeetingRoomAdapter() {
  const {
    meeting,
    meetingId: activeMeetingId,
    isMuted,
    isVideoOff,
    isScreenSharing,
    duration,
    handRaised,
    handRaisedParticipants,
    isFullscreen,
    meetingTitle,
    isOrganizer,
    viewMode,
    toggleMute,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    toggleHandRaise,
    toggleFullscreen,
    minimizeToPiP,
    requestPopOut,
    pinnedId,
    togglePin,
    setViewMode,
    leaveMeeting,
    endMeeting,
    isRecording,
    recordingState,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    backgroundType,
    backgroundValue,
    isBackgroundLoading,
    applyBlur,
    applyImage,
    removeBackground,
    captions,
  } = useWeldMeetCall();

  const { orgId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  const { data: meetingData } = useMeeting(activeMeetingId ?? '');
  const { mutate: updateMeeting } = useUpdateMeeting();
  const { mutate: updateHostControls } = useUpdateHostControls();
  const [showWeldAgent, setShowWeldAgent] = useWeldAgentDrawerOpen();
  const [, setMeetingPanelOpen] = useMeetingPanelOpen();
  const mobileNav = useMobileNavOptional();
  // Latest session carries the workspaceMemberId / personId link for each
  // participant — we need it to open the right details sheet on click.
  const { data: latestSession } = useLatestSession(activeMeetingId ?? '');

  const [participants, setParticipants] = useState<RtkPerson[]>([]);
  const [waitlistedCount, setWaitlistedCount] = useState(0);
  // Snapshot of the local screen-share state sourced directly from the RTK
  // `screenShareUpdate` event payload.  We keep this separately because RTK
  // fires the event *before* its internal getter (`meeting.self.screenShareTracks`)
  // is updated, so reading the getter inside updateParticipants() picks up stale
  // (null/false) values and the screenShareEntries filter in MeetingRoomView never
  // finds a local entry.  Storing from the payload eliminates the race.
  const [selfScreenShare, setSelfScreenShare] = useState<{
    enabled: boolean;
    videoTrack: MediaStreamTrack | null;
  }>({ enabled: false, videoTrack: null });
  const [showEffects, setShowEffects] = useState(false);
  const [guestTarget, setGuestTarget] = useState<GuestCreatePersonTarget | null>(null);

  // Reservation broadcast by `<ObjectPanelHost />` so the fullscreen meeting
  // overlay shrinks instead of being covered when a participant-details panel
  // opens. Same event the CRM / WeldMeet layouts listen to.
  const [objectPanelWidth, setObjectPanelWidth] = useState(0);
  useEffect(() => {
    const handler = (e: Event) => {
      const { isOpen, width } = (e as CustomEvent).detail;
      setObjectPanelWidth(isOpen ? width : 0);
    };
    window.addEventListener('object-panel-reservation', handler);
    return () => window.removeEventListener('object-panel-reservation', handler);
  }, []);

  const { open: openObjectPanel } = useObjectPanel();

  // { workspaceMemberId, personId, contactId } indexed by every identifier we
  // know for the persisted participant. Platform-side joins set
  //   sp.userId === sp.customParticipantId === Clerk userId
  // so a single key would suffice. Meeting-portal guests use a colorSeed UUID
  // as customParticipantId but `guest:<email>` as userId, so the map needs
  // both — plus `cfSessionId` as a final fallback that always matches the
  // RTK-assigned `p.id`. `contactId` is kept for backwards-compat on historical
  // session rows; new writes target `personId`.
  const participantLinks = useMemo(() => {
    const map = new Map<string, { workspaceMemberId?: string; personId?: string; contactId?: string }>();
    const sessionParticipants = (latestSession?.participants ?? []) as SessionParticipantWithLinks[];
    for (const sp of sessionParticipants) {
      const entry = {
        workspaceMemberId: sp?.workspaceMemberId,
        personId: sp?.personId,
        contactId: sp?.contactId,
      };
      if (!entry.workspaceMemberId && !entry.personId && !entry.contactId) continue;
      for (const key of [sp?.userId, sp?.customParticipantId, sp?.cfSessionId] as Array<string | undefined>) {
        if (key && !map.has(key)) map.set(key, entry);
      }
    }
    return map;
  }, [latestSession]);

  const handleClickParticipantDetails = useCallback((p: ParticipantDetailsTarget) => {
    // RTK doesn't expose a single canonical identifier — try every key the
    // map might be indexed by until one hits.
    const candidates = [p?.customParticipantId, p?.userId, p?.id] as Array<string | undefined>;
    let link: { workspaceMemberId?: string; personId?: string; contactId?: string } | undefined;
    for (const key of candidates) {
      if (!key) continue;
      const hit = participantLinks.get(key);
      if (hit) { link = hit; break; }
    }

    if (link?.workspaceMemberId && p?.userId) {
      // Team member — the object panel is keyed by Clerk userId so the
      // app-api /team-members/:userId endpoint resolves directly.
      openObjectPanel({ type: 'team-member', id: p.userId });
      return;
    }
    if (link?.personId) {
      openObjectPanel({ type: 'person', id: link.personId });
      return;
    }
    if (link?.contactId) {
      // Historical row from before the people cutover.
      openObjectPanel({ type: 'contact', id: link.contactId });
      return;
    }
    // Unlinked guest — offer to save as a person.
    setGuestTarget({ name: p?.name, picture: p?.picture ?? undefined });
  }, [participantLinks, openObjectPanel]);

  const joinCode = meetingData?.joinCode ?? '';
  const meetingPortalUrl = import.meta.env.VITE_MEETING_PORTAL_URL || window.location.origin;
  const shareUrl = joinCode ? `${meetingPortalUrl}/${workspaceId}/${joinCode}` : '';
  const displayTitle = meetingData?.title || meetingTitle;

  useEffect(() => {
    if (!meeting) return;

    const updateParticipants = () => {
      const joined = meeting.participants?.joined?.toArray?.() ?? [];
      setParticipants([meeting.self, ...joined]);
    };

    const updateWaitlisted = () => {
      const list = meeting.participants?.waitlisted?.toArray?.() ?? [];
      setWaitlistedCount(list.length);
    };

    // RTK fires `screenShareUpdate` on `self` *before* its internal getter
    // (`meeting.self.screenShareTracks`) is updated.  Reading the getter inside
    // updateParticipants() therefore picks up stale null tracks and
    // screenShareEntries in MeetingRoomView never finds the local entry.
    // We capture the track directly from the event payload instead, storing it
    // in selfScreenShare state.  MeetingRoomView then merges it into the self
    // participant snapshot (see below) so the filter sees up-to-date values.
    const onSelfScreenShareUpdate = (payload: {
      screenShareEnabled: boolean;
      screenShareTracks: { audio?: MediaStreamTrack; video?: MediaStreamTrack };
    }) => {
      setSelfScreenShare({
        enabled: payload.screenShareEnabled,
        videoTrack: payload.screenShareTracks?.video ?? null,
      });
      updateParticipants();
    };

    // Seed self screen-share from the live RTK getters. The `screenShareUpdate`
    // event does NOT re-fire on remount, so when this overlay remounts mid-share
    // (PiP ↔ fullscreen, navigation, layout switch) the reset state would drop
    // the local self-share tile even though RTK keeps publishing the screen
    // (remotes still see it). Reading the getter on mount restores it. Safe:
    // outside the start-event window the getter is settled.
    setSelfScreenShare({
      enabled: !!meeting.self?.screenShareEnabled,
      videoTrack: meeting.self?.screenShareTracks?.video ?? null,
    });

    updateParticipants();
    updateWaitlisted();
    meeting.participants?.joined?.on?.('participantJoined', updateParticipants);
    meeting.participants?.joined?.on?.('participantLeft', updateParticipants);
    meeting.participants?.waitlisted?.on?.('participantJoined', updateWaitlisted);
    meeting.participants?.waitlisted?.on?.('participantLeft', updateWaitlisted);
    meeting.self?.on?.('audioUpdate', updateParticipants);
    meeting.self?.on?.('videoUpdate', updateParticipants);
    meeting.self?.on?.('screenShareUpdate', onSelfScreenShareUpdate);

    const pollInterval = setInterval(updateWaitlisted, 2000);

    return () => {
      clearInterval(pollInterval);
      meeting.participants?.joined?.off?.('participantJoined', updateParticipants);
      meeting.participants?.joined?.off?.('participantLeft', updateParticipants);
      meeting.participants?.waitlisted?.off?.('participantJoined', updateWaitlisted);
      meeting.participants?.waitlisted?.off?.('participantLeft', updateWaitlisted);
      meeting.self?.off?.('audioUpdate', updateParticipants);
      meeting.self?.off?.('videoUpdate', updateParticipants);
      meeting.self?.off?.('screenShareUpdate', onSelfScreenShareUpdate);
    };
  }, [meeting]);

  const handleRename = useCallback((newTitle: string) => {
    if (activeMeetingId) {
      updateMeeting({ id: activeMeetingId, data: { title: newTitle } });
    }
  }, [activeMeetingId, updateMeeting]);

  // Auto-record on join when the meeting has `autoRecord` set and the local
  // viewer is the organizer. Idempotent — bails when already recording.
  const autoRecordedRef = useRef(false);
  useEffect(() => {
    if (autoRecordedRef.current) return;
    if (!meeting || !isOrganizer) return;
    if (!meetingData?.autoRecord) return;
    if (isRecording || recordingState !== 'IDLE') return;
    autoRecordedRef.current = true;
    try {
      startRecording();
    } catch (err) {
      console.error('[WeldMeet] auto-record start failed:', err);
    }
  }, [meeting, isOrganizer, meetingData?.autoRecord, isRecording, recordingState, startRecording]);

  // Reset the auto-record latch when the meeting changes.
  useEffect(() => {
    autoRecordedRef.current = false;
  }, [activeMeetingId]);

  const invitePopoverSlot = useMemo(
    () => shareUrl ? <InvitePopover popoverContent={<InvitePopoverContent shareUrl={shareUrl} />} /> : null,
    [shareUrl],
  );

  // Live participants (minus self) offered in the chat composer's @-mention
  // picker. `participants` is [meeting.self, ...joined]; drop self by RTK id.
  const mentionParticipants = useMemo(
    () =>
      participants
        .filter((p: RtkPerson) => p?.id && p.id !== meeting?.self?.id)
        .map((p: RtkPerson) => ({ id: p.id, name: p.name || 'Guest', avatar: p.picture ?? null })),
    [participants, meeting],
  );

  const chatPanelSlot = activeMeetingId
    ? ({ isOpen, onClose, onOpen, notificationHost, skipTransition }: { isOpen: boolean; onClose: () => void; onOpen: () => void; notificationHost: HTMLElement | null; skipTransition: boolean }) => (
        <MeetingChatPanel
          meetingId={activeMeetingId}
          isOpen={isOpen}
          onClose={onClose}
          onOpen={onOpen}
          participants={mentionParticipants}
          notificationHost={notificationHost}
          onClickAuthor={(author) => {
            // Only one panel at a time — close the chat before opening the
            // author's detail panel.
            onClose();
            handleClickParticipantDetails({
              userId: author.id,
              id: author.id,
              name: author.name,
              picture: author.avatar,
            });
          }}
          skipTransition={skipTransition}
        />
      )
    : undefined;

  const backgroundEffectsSlot = (
    <BackgroundEffectsPanel
      backgroundType={backgroundType}
      backgroundValue={backgroundValue}
      isLoading={isBackgroundLoading}
      isOpen={showEffects}
      localParticipant={meeting?.self}
      onApplyBlur={applyBlur}
      onApplyImage={applyImage}
      onRemove={removeBackground}
      onClose={() => setShowEffects(false)}
    />
  );

  // ---------------------------------------------------------------------
  // Host controls — drive the in-meeting policy panel. Only the organizer
  // can mutate; non-organizers don't see the gear icon (gated upstream by
  // MeetingRoomView's `showHostControlsButton`).
  // ---------------------------------------------------------------------
  const hostControlsValue: HostControlsValue = useMemo(() => ({
    hostManagement: meetingData?.hostManagement ?? true,
    allowScreenShare: meetingData?.allowScreenShare ?? true,
    allowMicrophone: meetingData?.allowMicrophone ?? true,
    allowVideo: meetingData?.allowVideo ?? true,
    allowHandRaise: meetingData?.allowHandRaise ?? true,
    allowReactions: meetingData?.allowReactions ?? true,
    allowAnnotations: meetingData?.allowAnnotations ?? true,
    allowVirtualBackgrounds: meetingData?.allowVirtualBackgrounds ?? true,
    allowParticipantRecord: meetingData?.allowParticipantRecord ?? false,
    allowThirdPartyAccess: meetingData?.allowThirdPartyAccess ?? true,
    noiseCancellation: meetingData?.noiseCancellation ?? true,
    autoRecord: meetingData?.autoRecord ?? false,
    enableCaptions: meetingData?.enableCaptions ?? false,
    waitingRoom: meetingData?.waitingRoom ?? false,
    hostMustJoinFirst: meetingData?.hostMustJoinFirst ?? false,
    lockAfterStart: meetingData?.lockAfterStart ?? false,
    autoEndOnInactivity: meetingData?.autoEndOnInactivity ?? true,
    accessType: meetingData?.accessType ?? 'workspace',
  }), [meetingData]);

  const handleHostControlsChange = useCallback((patch: Partial<HostControlsValue>) => {
    if (!activeMeetingId || !isOrganizer) return;
    updateHostControls(
      { meetingId: activeMeetingId, patch },
      {
        onSuccess: ({ controls }) => {
          // Push to every other participant over RTK so they apply the new
          // policy without polling. RTK's broadcast payload requires primitive
          // values per key — stringify the controls object so the receiver
          // gets one flat string field that parses back to the full snapshot.
          try {
            meeting?.participants?.broadcastMessage?.('call:host-controls-updated', {
              meetingId: activeMeetingId ?? '',
              controlsJson: JSON.stringify(controls),
            });
          } catch (err) {
            console.error('[WeldMeet] broadcast host-controls-updated failed:', err);
          }
        },
      },
    );
  }, [activeMeetingId, isOrganizer, updateHostControls, meeting]);

  const hostControlsSlot = activeMeetingId ? (
    <HostControlsPanel
      meeting={meeting}
      controls={hostControlsValue}
      onChange={handleHostControlsChange}
      readOnly={!isOrganizer}
    />
  ) : undefined;

  const peoplePanelSlot = (
    <PeopleEntityListPanel
      meeting={meeting}
      participants={participants}
      selfIsHost={isOrganizer}
      addPeopleDialogContent={shareUrl ? <AddPeopleDialogContent shareUrl={shareUrl} /> : undefined}
      onClickPerson={handleClickParticipantDetails}
    />
  );

  // Build a participants array where the self-entry (index 0) has its
  // screenShareEnabled and screenShareTracks.video overridden with the values
  // captured from the RTK event payload.  RTK fires screenShareUpdate before
  // its internal getter reflects the new state, so without this merge the
  // screenShareEntries filter in MeetingRoomView reads stale null values from
  // meeting.self and never renders the local screen-share tile.
  //
  // IMPORTANT: do NOT spread or Object.assign from the RTK class instance.
  // `screenShareEnabled` (and similar) are getter-only on the RTK prototype —
  // copying the prototype via Object.create/Object.assign then assigning to
  // those keys throws "Cannot set property … which has only a getter".
  // We build a plain object literal instead, reading each field explicitly so
  // nothing inherits from the RTK class.
  const localShim = useMemo(() => {
    // Source live media fields from `participants[0]` (which IS meeting.self,
    // re-snapshotted into a fresh array on every audio/video update) and key the
    // memo on `participants`. The RTK `meeting.self` reference is STABLE for the
    // whole call, so memoising only on `[meeting?.self, …]` froze the camera
    // fields at their first value. Depending on `participants` recomputes on
    // each media change. (Same fix already applied to the WeldChat adapter.)
    const s = participants[0] ?? meeting?.self;
    if (!s) return null;
    return {
      // identity / display
      id: s.id,
      name: s.name,
      picture: s.picture,
      userId: s.userId,
      customParticipantId: s.customParticipantId,
      // media state
      audioEnabled: s.audioEnabled,
      audioTrack: s.audioTrack,
      videoEnabled: s.videoEnabled,
      videoTrack: s.videoTrack,
      // screen-share — prefer event-payload values (they beat the RTK
      // start-event getter race), but fall back to the live getter so an
      // already-running share still renders locally after a remount.
      screenShareEnabled: selfScreenShare.enabled || !!s.screenShareEnabled,
      screenShareTracks: {
        video: selfScreenShare.videoTrack ?? s.screenShareTracks?.video ?? null,
        audio: s.screenShareTracks?.audio ?? null,
      },
      // RTK action methods — proxied through so context-menu actions still work
      pin: s.pin?.bind(s),
      unpin: s.unpin?.bind(s),
      disableAudio: s.disableAudio?.bind(s),
      disableVideo: s.disableVideo?.bind(s),
      // `kick` only exists on remote participants (Self can't kick itself).
      kick: (s as RTKParticipant).kick?.bind(s),
    };
  }, [participants, meeting?.self, selfScreenShare]);

  const participantsWithSelfScreenShare = useMemo(() => {
    if (participants.length === 0) return participants;
    if (!localShim) return participants;
    const [, ...rest] = participants;
    return [localShim, ...rest];
  }, [localShim, participants]);

  return (
    <>
    <MeetingRoomView
      meetingId={activeMeetingId ?? ''}
      meetingTitle={displayTitle}
      joinCode={joinCode || undefined}
      shareUrl={shareUrl || undefined}
      description={meetingData?.description ?? undefined}
      scheduledStart={meetingData?.scheduledStart ?? undefined}
      meeting={meeting}
      participants={participantsWithSelfScreenShare}
      waitlistedCount={waitlistedCount}
      isMuted={isMuted}
      isVideoOff={isVideoOff}
      isScreenSharing={isScreenSharing}
      handRaised={handRaised}
      handRaisedParticipants={handRaisedParticipants}
      duration={duration}
      isOrganizer={isOrganizer}
      viewMode={viewMode}
      isFullscreen={isFullscreen}
      hostControls={hostControlsValue}
      captions={captions}
      toggleMute={toggleMute}
      toggleVideo={toggleVideo}
      startScreenShare={startScreenShare}
      stopScreenShare={stopScreenShare}
      toggleHandRaise={toggleHandRaise}
      setViewMode={setViewMode}
      onLeave={isOrganizer ? endMeeting : leaveMeeting}
      onToggleFullscreen={toggleFullscreen}
      // Picture-in-picture: open the OUT-OF-BROWSER PiP window (Document PiP,
      // with a native single-video fallback). requestPopOut must run inside this
      // click gesture (Document PiP needs user activation); minimizeToPiP then
      // drops the in-app fullscreen overlay so the meeting lives in the OS
      // window. Surfaced in the CallControlsBar "More options" overflow menu.
      onPictureInPicture={() => { requestPopOut(); minimizeToPiP(); }}
      // Recording is surfaced in the Meeting tools panel (organizer only) but
      // kept out of the CallControlsBar overflow menu via
      // showControlBarRecording={false}.
      isRecording={isRecording}
      recordingState={recordingState}
      startRecording={startRecording}
      stopRecording={stopRecording}
      pauseRecording={pauseRecording}
      resumeRecording={resumeRecording}
      showControlBarRecording={false}
      onRenameMeeting={handleRename}
      onToggleEffects={() => setShowEffects(v => !v)}
      effectsOpen={showEffects}
      backgroundType={backgroundType}
      backgroundEffectsSlot={backgroundEffectsSlot}
      chatPanelSlot={chatPanelSlot}
      invitePopoverSlot={invitePopoverSlot}
      peoplePanelSlot={peoplePanelSlot}
      hostControlsSlot={hostControlsSlot}
      addPeopleDialogContent={shareUrl ? <AddPeopleDialogContent shareUrl={shareUrl} /> : undefined}
      onClickParticipantDetails={handleClickParticipantDetails}
      // Treat the object detail panel as an external panel too: when it opens
      // (objectPanelWidth > 0) MeetingRoomView closes its internal panels
      // instantly (skipTransition) — one panel at a time, no switch animation.
      externalPanelOpen={showWeldAgent || objectPanelWidth > 0}
      onActivatePanel={() => {
        // Skip the WeldAgent close animation AND the layout wrapper width
        // transition when the user switches from WeldAgent to a meeting panel.
        mobileNav?.setWeldAgentSkipAnimation(true);
        setShowWeldAgent(false);
      }}
      onInternalPanelChange={setMeetingPanelOpen}
      rightReservation={objectPanelWidth}
      // Controlled pin held in the call context, so it persists when the meeting
      // view remounts moving between the inline page and the fullscreen overlay.
      pinnedId={pinnedId}
      onTogglePin={togglePin}
    />
    <GuestCreatePersonDialog
      target={guestTarget}
      onOpenChange={(open) => { if (!open) setGuestTarget(null); }}
      onCreated={(personId) => {
        setGuestTarget(null);
        openObjectPanel({ type: 'person', id: personId });
      }}
    />
    </>
  );
}

// ============================================================================
// Preview adapter — wires the call context into the shared PreviewView
// ============================================================================

function PreviewAdapter() {
  const {
    previewStream,
    previewAudioEnabled,
    previewVideoEnabled,
    togglePreviewAudio,
    togglePreviewVideo,
    confirmJoinFromPreview,
    cancelPreview,
    meetingTitle,
    meetingType,
  } = useWeldMeetCall();

  return (
    <PreviewView
      meetingTitle={meetingTitle}
      meetingType={meetingType as 'video' | 'audio'}
      previewStream={previewStream}
      previewAudioEnabled={previewAudioEnabled}
      previewVideoEnabled={previewVideoEnabled}
      togglePreviewAudio={togglePreviewAudio}
      togglePreviewVideo={togglePreviewVideo}
      confirmJoinFromPreview={confirmJoinFromPreview}
      cancelPreview={cancelPreview}
    />
  );
}

// ============================================================================
// Public exports
// ============================================================================

/** Inline meeting view — renders within the page content area */
export function InlineMeetingView() {
  const { status } = useWeldMeetCall();

  if (status === 'preview') return <PreviewAdapter />;
  if (status === 'connecting') return <ConnectingView />;
  if (status === 'connected') return <MeetingRoomAdapter />;

  return null;
}

/** Global overlay — only renders in fullscreen mode */
export function MeetingOverlay() {
  const { status, isFullscreen } = useWeldMeetCall();

  if (status === 'idle' || status === 'ended') return null;
  if (!isFullscreen) return null;

  if (status === 'preview') return <PreviewAdapter />;
  if (status === 'connecting') return <ConnectingView />;
  if (status === 'connected') return <MeetingRoomAdapter />;

  return null;
}
