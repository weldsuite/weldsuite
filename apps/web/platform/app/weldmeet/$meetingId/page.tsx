import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@clerk/clerk-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { HostControlsPanel, type HostControlsValue } from '@weldsuite/weldmeet-ui';
import {
  useMeeting,
  useUpdateMeeting,
  useDeleteMeeting,
  useLatestSession,
  useUpdateMeetingPolicy,
  type Meeting,
} from '@/hooks/queries/use-weldmeet-queries';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { buildMeetingShareUrl } from '@/lib/weldmeet/share-link';
import { useMeetingRecording, useRecordingAccess, useSessionRecording } from '@/hooks/queries/use-weldmeet-recording-queries';
import type { MeetingAttendee } from '@/lib/api/domains/weldmeet';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { MeetingIntelligence } from '@/components/weldcrm/calls/meeting-intelligence';
import type { TranscriptionActions, MeetingIntelligenceCall, TranscriptionData } from '@/components/weldcrm/calls/meeting-intelligence';
import type { HeaderAction, MeetingIntelligenceProps, MeetingIntelligenceTab } from '@/components/weldcrm/calls/meeting-intelligence/types';
import type {
  SessionRecordingInfo,
  SessionTranscription,
} from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import { billableRecordingSeconds, hasApiStatus, isDeletableRecordingStatus } from '@/lib/weldmeet/recording';
import { MeetingChatHistory } from '../components/meeting-chat-history';
import { MeetingInvitePicker } from '../components/meeting-invite-picker';
import { MeetingSummaryPanel } from '../components/meeting-summary-panel';
import { RecordingStatePanel } from '../components/recording-state-panel';
import { DeleteRecordingDialog, RecordingAiEstimateDialog, type RecordingAiKind } from '../components/recording-dialogs';
import { useDownloadRecording } from '../components/use-recording-download';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { X, MessageSquare, Loader2, UserPlus, Video, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

// The attendee resolver also links to a workspace member or CRM contact; not
// yet reflected in the shared MeetingAttendee client type.
type MeetingAttendeeWithLinks = MeetingAttendee & { workspaceMemberId?: string; contactId?: string };

type TranscribeResult = { success: boolean; error?: string; message?: string; cancelled?: boolean };

type LatestSession = ReturnType<typeof useLatestSession>['data'];
type WeldmeetStrings = ReturnType<typeof getTranslations<'weldmeet'>>;

/**
 * Organizer first, then the invitees. A meeting created before the organizer
 * became an attendee has no organizer row: add one from `meeting.organizer`.
 */
function buildAttendeeDetails(meeting: Meeting): NonNullable<MeetingIntelligenceCall['attendeeDetails']> {
  const rows = (meeting.attendees ?? []).map((a: MeetingAttendeeWithLinks) => ({
    name: a.name,
    email: a.email,
    avatar: a.avatar,
    role: a.role,
    workspaceMemberId: a.workspaceMemberId,
    contactId: a.contactId,
  }));
  const organizer = meeting.organizer;
  const hasOrganizerRow = (meeting.attendees ?? []).some(
    (a) => a.role === 'organizer' || (!!organizer && a.userId === organizer.userId),
  );
  if (organizer && !hasOrganizerRow) {
    return [{ name: organizer.name ?? undefined, avatar: organizer.avatar ?? undefined, role: 'organizer' as const }, ...rows];
  }
  return rows;
}

function buildNormalizedCall(
  meeting: Meeting,
  meetingId: string,
  latestSession: LatestSession,
  recordingDuration: number | null | undefined,
  options: { meetingUrl: string | undefined; notScheduledLabel: string },
): MeetingIntelligenceCall {
  // Meetings that ran show when they ran; a scheduled one shows its slot.
  // createdAt is never a meeting date: with neither, say so.
  const ranAt = latestSession?.startedAt ?? undefined;
  const date =
    meeting.status === 'scheduled'
      ? (meeting.scheduledStart ?? ranAt)
      : (ranAt ?? meeting.scheduledStart);
  const attendeeDetails = buildAttendeeDetails(meeting);
  return {
    id: meetingId,
    subject: meeting.title,
    description: meeting.description,
    date: date ?? meeting.createdAt,
    dateLabel: date ? undefined : options.notScheduledLabel,
    meetingUrl: options.meetingUrl,
    duration: recordingDuration ?? undefined,
    attendees: attendeeDetails.map((a) => a.name ?? a.email ?? ''),
    attendeeDetails,
    sessionParticipants: latestSession?.participants?.map((p) => ({
      userId: p.userId,
      userName: p.userName,
      userAvatar: p.userAvatar,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt,
      firstJoinedAt: p.firstJoinedAt,
      priorSeconds: p.priorSeconds,
      stints: p.stints,
    })),
    sessionDuration: latestSession?.duration ?? undefined,
    sessionStartedAt: latestSession?.startedAt ?? undefined,
    sessionEndedAt: latestSession?.endedAt ?? undefined,
  };
}

/** The transcript payload of meet-api in the shape the shared transcript viewer reads. */
function toTranscriptionData(data: SessionTranscription): TranscriptionData {
  return {
    id: data.id,
    status: data.status,
    fullText: data.fullText ?? undefined,
    summary: data.summary ?? undefined,
    speakerCount: data.speakerCount ?? undefined,
    wordCount: data.wordCount ?? undefined,
    segments: data.segments.map((seg) => ({
      id: seg.id,
      speaker: seg.speaker ?? seg.speakerLabel ?? undefined,
      speakerName: seg.speakerName ?? undefined,
      text: seg.text,
      start: seg.start,
      end: seg.end,
      timestamp: seg.timestamp ?? undefined,
    })),
  };
}

/**
 * Transcript reads go through the per-meeting alias on purpose: it resolves the
 * latest recorded session AND falls back to the legacy transcript keyed by
 * meeting id, so meetings recorded before the move to RealtimeKit still show
 * theirs. Starting a transcript is session-scoped and goes through the estimate
 * dialog (`onTranscribe`).
 */
function buildTranscriptionActions(
  getClient: ReturnType<typeof useAppApiClient>['getClient'],
  onTranscribe: TranscriptionActions['onTranscribe'],
  onTranscriptLoaded: (data: SessionTranscription) => void,
): TranscriptionActions {
  return {
    onTranscribe,
    onFetchTranscription: async (id) => {
      const client = await getClient();
      try {
        const result = await client.get<{ data: SessionTranscription }>(`/meetings/${id}/recording/transcription`);
        onTranscriptLoaded(result.data);
        return { success: true, transcription: toTranscriptionData(result.data) };
      } catch (err) {
        // No transcript yet is not an error.
        if (hasApiStatus(err, 404)) return { success: true, transcription: null };
        throw err;
      }
    },
    onPollStatus: async (id) => {
      const client = await getClient();
      const result = await client.get<{
        data: { exists: boolean; status?: string; errorMessage?: string | null };
      }>(`/meetings/${id}/recording/transcription-status`);
      return {
        status: result.data.exists
          ? { status: result.data.status, errorMessage: result.data.errorMessage ?? undefined }
          : {},
      };
    },
  };
}

function buildHeaderMenuActions({
  t,
  shareUrl,
  onDownloadRecording,
  onDeleteRecording,
  hasRecording,
  onRename,
  onScheduleAgain,
}: {
  t: WeldmeetStrings;
  /** Guest link; the copy action is left out when there is no working link. */
  shareUrl: string | null;
  onDownloadRecording: (() => void) | undefined;
  onDeleteRecording: (() => void) | undefined;
  hasRecording: boolean;
  onRename: () => void;
  onScheduleAgain: () => void;
}): MeetingIntelligenceProps['headerMenuActions'] {
  return {
    onCopyLink: shareUrl
      ? () => {
          void navigator.clipboard.writeText(shareUrl);
          toast.success(t.meetingDetailPage.meetingLinkCopied);
        }
      : undefined,
    onRename,
    onScheduleAgain,
    onDownloadRecording,
    onDeleteRecording,
    deleteRecordingLabel: t.recording.actions.delete,
    onExportTranscript: hasRecording ? () => {
      toast.success(t.meetingDetailPage.transcriptExported);
    } : undefined,
  };
}

function buildChatToggleAction(t: WeldmeetStrings, showChat: boolean, onToggle: () => void): HeaderAction {
  return {
    label: showChat ? t.meetingDetailPage.hideChat : t.meetingDetailPage.chat,
    icon: <MessageSquare className="h-4 w-4" />,
    onClick: onToggle,
    variant: showChat ? 'default' : 'ghost',
  };
}

function ChatHistorySidebar({ t, meetingId, onClose }: { t: WeldmeetStrings; meetingId: string; onClose: () => void }) {
  return (
    <>
      <div className="px-4 border-b flex-shrink-0 h-[53px] flex items-center justify-between">
        <span className="text-[15px] font-semibold">{t.meetingDetailPage.chatHistoryTitle}</span>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <MeetingChatHistory meetingId={meetingId} hideHeader />
    </>
  );
}

function RenameMeetingDialog({
  t,
  open,
  onOpenChange,
  draft,
  onDraftChange,
  onRename,
}: {
  t: WeldmeetStrings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  onRename: (title: string) => void;
}) {
  const commit = () => {
    const title = draft.trim();
    if (!title) return;
    onRename(title);
    toast.success(t.meetingDetailPage.meetingRenamed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t.meetingDetailPage.renameMeeting.title}</DialogTitle>
          <DialogDescription className="sr-only">{t.meetingDetailPage.renameMeeting.description}</DialogDescription>
        </DialogHeader>
        <Input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          placeholder={t.meetingDetailPage.renameMeeting.placeholder}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t.meetingDetailPage.renameMeeting.cancel}</Button>
          <Button onClick={commit} disabled={!draft.trim()}>
            {t.meetingDetailPage.renameMeeting.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function MeetingDetailPage() {
  const t = getTranslations('weldmeet');
  const { meetingId } = useParams({ from: '/weldmeet/$meetingId/' });
  const { data: meeting, isLoading } = useMeeting(meetingId);
  const { data: latestSession } = useLatestSession(meetingId);
  const { getClient } = useAppApiClient();
  const navigate = useNavigate();
  const { userId, orgId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  const navLabels = getTranslations('navigation').moduleSidebar.weldmeet;

  // Recorder, transcript and summary. The alias resolves the meeting to its
  // recorded session (and hands back a fresh playback token once ready); the
  // session query then polls while anything is still being produced.
  const recording = useMeetingRecording(meetingId);
  const recordingSessionId = recording.data?.sessionId ?? null;
  const { data: liveRecordingInfo } = useSessionRecording(recordingSessionId);
  const recordingInfo: SessionRecordingInfo | null = liveRecordingInfo ?? recording.data ?? null;
  const recordingStatus = recordingInfo?.status ?? null;
  const { refetch: refetchRecording } = recording;

  // Fully qualified keys, so this page behaves the same however it was reached.
  const { can } = usePermissions();
  const canViewRecording = can('weldmeet:recordings:read');
  const canDeleteRecording = can('weldmeet:recordings:delete');
  // Transcribe / summarize spend credits: sessions:update on top of read.
  const canUseRecordingAi = canViewRecording && can('weldmeet:sessions:update');

  const { download: downloadRecording } = useDownloadRecording();
  // Playback tokens last an hour: the player asks for a new one before that, or
  // when playback fails. Minted on demand and never cached.
  const { mutateAsync: mintRecordingAccess } = useRecordingAccess();
  const handleRefreshPlaybackUrl = useCallback(async () => {
    if (!recordingSessionId) return null;
    const { url, expiresAt } = await mintRecordingAccess(recordingSessionId);
    return { url, expiresAt };
  }, [recordingSessionId, mintRecordingAccess]);
  const [deleteRecordingOpen, setDeleteRecordingOpen] = useState(false);
  const [aiDialog, setAiDialog] = useState<RecordingAiKind | null>(null);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  // Resolves the pending Transcribe click once the estimate dialog is answered.
  const transcribeResolverRef = useRef<((result: TranscribeResult) => void) | null>(null);

  // The recording turned ready while this page was open: pick up its playback
  // URL once (the alias only mints one when the file is ready).
  const refetchedForReadyRef = useRef<string | null>(null);
  useEffect(() => {
    if (recordingStatus !== 'ready' || !recordingSessionId || recording.data?.url) return;
    if (refetchedForReadyRef.current === recordingSessionId) return;
    refetchedForReadyRef.current = recordingSessionId;
    void refetchRecording();
  }, [recordingStatus, recordingSessionId, recording.data?.url, refetchRecording]);

  const settleTranscribe = useCallback((result: TranscribeResult) => {
    transcribeResolverRef.current?.(result);
    transcribeResolverRef.current = null;
  }, []);
  const [showChat, setShowChat] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [addPeopleOpen, setAddPeopleOpen] = useState(false);
  const { mutate: updateMeeting } = useUpdateMeeting();
  const { mutateAsync: deleteMeeting } = useDeleteMeeting();
  const { mutate: updateMeetingPolicy } = useUpdateMeetingPolicy();
  const [hostControlsOpen, setHostControlsOpen] = useState(false);

  // Upcoming meetings come from (and go back to) Upcoming; the rest to History.
  const isUpcoming = meeting?.status === 'scheduled' || meeting?.status === 'in_progress';
  const listUrl = isUpcoming ? '/weldmeet/upcoming' : '/weldmeet/history';
  useBreadcrumbs(
    meeting
      ? [
          { label: isUpcoming ? navLabels.upcoming : navLabels.history, href: listUrl },
          { label: meeting.title },
        ]
      : [],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t.meetingDetailPage.loading}</span>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">{t.meetingDetailPage.notFound}</p>
      </div>
    );
  }

  const playbackUrl = canViewRecording ? (recording.data?.url ?? undefined) : undefined;
  const recordingDuration = recording.data?.duration ?? recordingInfo?.durationSeconds ?? undefined;
  const hasRecording = !!playbackUrl;
  const hasRecordingInfo = !!recordingInfo && recordingStatus !== null && recordingStatus !== 'deleted';
  const mediaType: 'video' | 'audio' | 'none' = !playbackUrl ? 'none' : recordingInfo?.hasVideo === false ? 'audio' : 'video';

  const transcriptStatus = recordingInfo?.transcription.status;
  const transcriptPending = transcriptStatus === 'pending' || transcriptStatus === 'processing';
  const hasTranscript = transcriptStatus === 'completed';
  const transcriptRequestedAtStart = !!recordingInfo?.ai.transcribe;
  // The transcript the host asked for arrives after the meeting; do not offer a paid second one meanwhile.
  const transcriptExpected = transcriptRequestedAtStart && !hasTranscript && transcriptStatus !== 'failed';
  const canOfferTranscribe =
    canUseRecordingAi && recordingStatus === 'ready' && !!recordingInfo?.hasAudio &&
    !hasTranscript && !transcriptPending && !transcriptExpected;
  const summaryStatus = recordingInfo?.summary.status ?? null;
  const showIntelligenceTabs = hasRecordingInfo && canViewRecording;
  const intelligenceTabs: MeetingIntelligenceTab[] = showIntelligenceTabs
    ? ['transcript', 'summary', 'speakers', 'meeting']
    : ['meeting'];
  // Changes whenever the transcript or summary does, so the viewer loads them again.
  const transcriptionRefreshKey = showIntelligenceTabs
    ? `${transcriptStatus ?? 'none'}:${summaryStatus ?? 'none'}:${recordingInfo?.summary.generatedAt ?? ''}`
    : undefined;

  const estimateSeconds = billableRecordingSeconds({
    parts: recordingInfo?.parts,
    durationSeconds: recordingInfo?.durationSeconds,
    sessionDurationSeconds: recordingDuration,
  });
  // Backend also emits a `failed` status (see MeetingStatus in the DB schema),
  // not yet reflected in the shared Meeting client type.
  const meetingStatus = meeting.status as Meeting['status'] | 'failed';
  const hasChat = meetingStatus === 'completed' || meetingStatus === 'failed';

  // People can be invited until the meeting is over; invitations need its join link.
  const canInvite = !!meeting.joinCode && (meetingStatus === 'scheduled' || meetingStatus === 'in_progress');
  const shareUrl = buildMeetingShareUrl(workspaceId, meeting.joinCode);
  const isOrganizer = !!userId && meeting.organizerId === userId;
  const canJoin = isUpcoming && can('weldmeet:sessions:create');
  const canEditHostControls = isUpcoming && isOrganizer && can('weldmeet:meetings:update');
  const hostControlsValue: HostControlsValue = {
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
    autoRecord: meeting.autoRecord ?? false,
    enableCaptions: meeting.enableCaptions ?? false,
    waitingRoom: meeting.waitingRoom ?? false,
    hostMustJoinFirst: meeting.hostMustJoinFirst ?? false,
    lockAfterStart: meeting.lockAfterStart ?? false,
    autoEndOnInactivity: meeting.autoEndOnInactivity ?? true,
    accessType: meeting.accessType ?? 'workspace',
  };
  const headerActions: HeaderAction[] = [
    ...(canJoin
      ? [{
          label: meeting.activeSessionId ? t.meetingDetailPage.join : t.meetingDetailPage.start,
          icon: <Video className="h-4 w-4" />,
          onClick: () => void navigate({ to: '/weldmeet/$meetingId/room', params: { meetingId } }),
          variant: 'default' as const,
          showLabel: true,
        }]
      : []),
    ...(canEditHostControls
      ? [{
          label: t.meetingDetailPage.hostControls,
          icon: <SlidersHorizontal className="h-4 w-4" />,
          onClick: () => setHostControlsOpen(true),
          variant: 'ghost' as const,
        }]
      : []),
    ...(canInvite
      ? [{
          label: t.meetingDetailPage.addPeople,
          icon: <UserPlus className="h-4 w-4" />,
          onClick: () => setAddPeopleOpen(true),
          variant: 'outline' as const,
        }]
      : []),
    ...(hasChat ? [buildChatToggleAction(t, showChat, () => setShowChat(v => !v))] : []),
  ];

  const normalizedCall = buildNormalizedCall(meeting, meetingId, latestSession, recordingDuration, {
    meetingUrl: isUpcoming ? (shareUrl ?? undefined) : undefined,
    notScheduledLabel: t.meetingDetailPage.notScheduled,
  });

  const handleTranscribeRequest = canOfferTranscribe
    ? () =>
        new Promise<TranscribeResult>((resolve) => {
          transcribeResolverRef.current = resolve;
          setAiDialog('transcribe');
        })
    : undefined;

  const transcriptionActions: TranscriptionActions | undefined = showIntelligenceTabs
    ? buildTranscriptionActions(getClient, handleTranscribeRequest, (data) => setSummaryText(data.summary))
    : undefined;

  // Nothing to play: say why (still recording / processing / failed / expired / deleted).
  let mediaSlot: React.ReactNode;
  if (recording.isError && !recording.data) {
    mediaSlot = <RecordingStatePanel kind="loadFailed" onRetry={() => void refetchRecording()} />;
  } else if (recordingInfo && recordingStatus !== null && !playbackUrl) {
    if (!canViewRecording) mediaSlot = <RecordingStatePanel kind="forbidden" />;
    else if (recordingStatus === 'ready') {
      mediaSlot = recording.isFetching
        ? <RecordingStatePanel kind="processing" />
        : <RecordingStatePanel kind="loadFailed" onRetry={() => void refetchRecording()} />;
    } else {
      mediaSlot = <RecordingStatePanel kind={recordingStatus} error={recordingInfo.error} />;
    }
  }

  return (
    <>
    <MeetingIntelligence
      call={normalizedCall}
      recordingUrl={playbackUrl}
      recordingUrlExpiresAt={recording.data?.expiresAt}
      onRefreshRecordingUrl={playbackUrl ? handleRefreshPlaybackUrl : undefined}
      mediaType={mediaType}
      mediaSlot={mediaSlot}
      transcriptionActions={transcriptionActions}
      transcriptionPending={transcriptPending}
      transcriptionRefreshKey={transcriptionRefreshKey}
      transcriptEmptyHint={transcriptExpected ? t.recording.transcript.expected : undefined}
      tabs={intelligenceTabs}
      tabLabels={{ summary: t.recording.summary.tab }}
      renderSummary={() => (
        <MeetingSummaryPanel
          summaryText={summaryText}
          summaryStatus={summaryStatus}
          summaryError={recordingInfo?.summary.error ?? null}
          hasTranscript={hasTranscript}
          transcriptPending={transcriptPending}
          summaryExpected={!!recordingInfo?.ai.summarize}
          canGenerate={canUseRecordingAi && recordingStatus !== null && recordingStatus !== 'deleted'}
          onGenerate={() => setAiDialog('summarize')}
        />
      )}
      enableWeldAgent
      layout="full-width"
      onDelete={async (id) => {
        try {
          await deleteMeeting(id);
          return { success: true };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error && err.message ? err.message : t.meetingDetailPage.meetingDeleteFailed,
          };
        }
      }}
      deleteSuccessMessage={t.meetingDetailPage.meetingDeleted}
      deleteRedirectUrl={listUrl}
      backUrl={listUrl}
      breadcrumbs={[
        { label: isUpcoming ? navLabels.upcoming : navLabels.history, href: listUrl },
        { label: meeting.title },
      ]}
      headerMenuActions={buildHeaderMenuActions({
        t,
        shareUrl,
        onDownloadRecording:
          canViewRecording && recordingStatus === 'ready' && recordingSessionId
            ? () => void downloadRecording(recordingSessionId)
            : undefined,
        onDeleteRecording:
          canDeleteRecording && isDeletableRecordingStatus(recordingStatus) && recordingSessionId
            ? () => setDeleteRecordingOpen(true)
            : undefined,
        hasRecording: hasRecording && hasTranscript,
        onRename: () => {
          setRenameDraft(meeting.title);
          setRenameOpen(true);
        },
        onScheduleAgain: () => {
          void navigate({ to: '/weldmeet/new', search: { from: meetingId } });
        },
      })}
      headerActions={headerActions.length > 0 ? headerActions : undefined}
      renderSidebar={hasChat && showChat ? () => (
        <ChatHistorySidebar t={t} meetingId={meetingId} onClose={() => setShowChat(false)} />
      ) : undefined}
    />

    {/* Add people dialog */}
    {canInvite && (
      <Dialog open={addPeopleOpen} onOpenChange={setAddPeopleOpen}>
        <DialogContent className="sm:max-w-[480px] p-4">
          <DialogHeader>
            <DialogTitle className="text-[17px]">{t.meetingDetailPage.addPeople}</DialogTitle>
            <DialogDescription className="sr-only">{t.meetingDetailPage.addPeopleDescription}</DialogDescription>
          </DialogHeader>
          <MeetingInvitePicker meetingId={meetingId} />
        </DialogContent>
      </Dialog>
    )}

    {/* Host controls (organizer only, before and during the meeting) */}
    {canEditHostControls && (
      <Dialog open={hostControlsOpen} onOpenChange={setHostControlsOpen}>
        <DialogContent className="sm:max-w-[480px] p-4">
          <DialogHeader>
            <DialogTitle className="text-[17px]">{t.meetingDetailPage.hostControls}</DialogTitle>
            <DialogDescription className="sr-only">{t.meetingDetailPage.hostControlsDescription}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <HostControlsPanel
              meeting={null}
              controls={hostControlsValue}
              onChange={(patch) => {
                updateMeetingPolicy(
                  { meetingId, patch },
                  { onError: () => toast.error(t.meetingDetailPage.hostControlsUpdateFailed) },
                );
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    )}

    {/* Transcribe / summarize, with the credit estimate */}
    {aiDialog && recordingSessionId && (
      <RecordingAiEstimateDialog
        open
        kind={aiDialog}
        sessionId={recordingSessionId}
        seconds={estimateSeconds}
        onStarted={() => settleTranscribe({ success: true })}
        onOpenChange={(open) => {
          if (open) return;
          // Closed without starting: the pending Transcribe click is cancelled quietly.
          settleTranscribe({ success: false, cancelled: true });
          setAiDialog(null);
        }}
      />
    )}

    {/* Delete the recording (video, audio, transcript, summary) */}
    {recordingSessionId && (
      <DeleteRecordingDialog
        open={deleteRecordingOpen}
        sessionId={recordingSessionId}
        onOpenChange={setDeleteRecordingOpen}
        onDeleted={() => setSummaryText(null)}
      />
    )}

    {/* Rename dialog */}
    <RenameMeetingDialog
      t={t}
      open={renameOpen}
      onOpenChange={setRenameOpen}
      draft={renameDraft}
      onDraftChange={setRenameDraft}
      onRename={(title) => updateMeeting({ id: meetingId, data: { title } })}
    />
  </>
  );
}
