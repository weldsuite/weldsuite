import { useState } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useMeeting, useMeetingRecordingUrl, useTranscribeMeeting, useUpdateMeeting, useDeleteMeeting, useLatestSession, type Meeting } from '@/hooks/queries/use-weldmeet-queries';
import type { MeetingAttendee } from '@/lib/api/domains/weldmeet';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { MeetingIntelligence } from '@/components/weldcrm/calls/meeting-intelligence';
import type { TranscriptionActions, MeetingIntelligenceCall, TranscriptionData } from '@/components/weldcrm/calls/meeting-intelligence';
import { MeetingChatHistory } from '../components/meeting-chat-history';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { X, MessageSquare, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

// The attendee resolver also links to a workspace member or CRM contact; not
// yet reflected in the shared MeetingAttendee client type.
type MeetingAttendeeWithLinks = MeetingAttendee & { workspaceMemberId?: string; contactId?: string };

interface TranscriptionStatusResponse {
  exists: boolean;
  status?: string;
  errorMessage?: string;
}

export default function MeetingDetailPage() {
  const t = getTranslations('weldmeet');
  const { meetingId } = useParams({ from: '/weldmeet/$meetingId/' });
  const { data: meeting, isLoading } = useMeeting(meetingId);
  const { data: latestSession } = useLatestSession(meetingId);
  const { data: recordingData } = useMeetingRecordingUrl(meetingId);
  const { getClient } = useAppApiClient();
  const transcribeMut = useTranscribeMeeting();
  const navigate = useNavigate();
  const [showChat, setShowChat] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const { mutate: updateMeeting } = useUpdateMeeting();
  const { mutate: deleteMeeting } = useDeleteMeeting();

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

  const recordingUrl = recordingData?.url;
  const recordingDuration = recordingData?.duration;
  const hasRecording = !!recordingUrl;
  // Backend also emits a `failed` status (see MeetingStatus in the DB schema),
  // not yet reflected in the shared Meeting client type.
  const meetingStatus = meeting.status as Meeting['status'] | 'failed';
  const hasChat = meetingStatus === 'completed' || meetingStatus === 'failed';

  const normalizedCall: MeetingIntelligenceCall = {
    id: meetingId,
    subject: meeting.title,
    description: meeting.description,
    date: meeting.scheduledStart || meeting.createdAt,
    duration: recordingDuration ?? undefined,
    attendees: meeting.attendees?.map((a: MeetingAttendeeWithLinks) => a.name) ?? [],
    attendeeDetails: meeting.attendees?.map((a: MeetingAttendeeWithLinks) => ({
      name: a.name,
      email: a.email,
      avatar: a.avatar,
      role: a.role,
      workspaceMemberId: a.workspaceMemberId,
      contactId: a.contactId,
    })) ?? [],
    sessionParticipants: latestSession?.participants?.map((p) => ({
      userId: p.userId,
      userName: p.userName,
      userAvatar: p.userAvatar,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt,
    })),
    sessionDuration: latestSession?.duration ?? undefined,
    sessionStartedAt: latestSession?.startedAt ?? undefined,
    sessionEndedAt: latestSession?.endedAt ?? undefined,
  };

  const transcriptionActions: TranscriptionActions | undefined = hasRecording ? {
    onTranscribe: async (id) => {
      // app-api returns { data: { id, status } } — no success/error/message fields
      await transcribeMut.mutateAsync({ meetingId: id });
      return { success: true };
    },
    onFetchTranscription: async (id) => {
      const client = await getClient();
      // app-api returns { data: { ...transcription, segments: [...] } }
      const result = await client.get<{ data: TranscriptionData }>(`/meetings/${id}/recording/transcription`);
      return { success: true, transcription: result.data };
    },
    onPollStatus: async (id) => {
      const client = await getClient();
      // app-api returns { data: { exists, status?, ... } }
      const result = await client.get<{ data: TranscriptionStatusResponse }>(`/meetings/${id}/recording/transcription-status`);
      return { status: result.data };
    },
  } : undefined;

  return (
    <>
    <MeetingIntelligence
      call={normalizedCall}
      recordingUrl={recordingUrl}
      mediaType={hasRecording ? 'video' : 'none'}
      fetchTranscriptionOnMount={hasRecording}
      transcriptionActions={transcriptionActions}
      tabs={hasRecording ? ['transcript', 'speakers', 'meeting'] : ['meeting']}
      enableWeldAgent
      layout="full-width"
      onDelete={async (id) => {
        deleteMeeting(id);
        toast.success(t.meetingDetailPage.meetingDeleted);
        return { success: true };
      }}
      deleteRedirectUrl="/weldmeet/history"
      backUrl="/weldmeet/history"
      breadcrumbs={[
        { label: t.meetingDetailPage.breadcrumbMeetings, href: '/weldmeet/history' },
        { label: meeting.title },
      ]}
      headerMenuActions={{
        onCopyLink: () => {
          navigator.clipboard.writeText(`${window.location.origin}/weldmeet/${meetingId}`);
          toast.success(t.meetingDetailPage.meetingLinkCopied);
        },
        onRename: () => {
          setRenameDraft(meeting.title);
          setRenameOpen(true);
        },
        onScheduleAgain: () => {
          navigate({ to: '/weldmeet/new' });
        },
        onDownloadRecording: recordingUrl ? () => window.open(recordingUrl, '_blank') : undefined,
        onExportTranscript: hasRecording ? () => {
          toast.success(t.meetingDetailPage.transcriptExported);
        } : undefined,
      }}
      headerActions={hasChat ? [
        {
          label: showChat ? t.meetingDetailPage.hideChat : t.meetingDetailPage.chat,
          icon: <MessageSquare className="h-4 w-4" />,
          onClick: () => setShowChat(v => !v),
          variant: showChat ? 'default' : 'ghost',
        },
      ] : undefined}
      renderSidebar={hasChat && showChat ? () => (
        <>
          <div className="px-4 border-b flex-shrink-0 h-[53px] flex items-center justify-between">
            <span className="text-[15px] font-semibold">{t.meetingDetailPage.chatHistoryTitle}</span>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowChat(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <MeetingChatHistory meetingId={meetingId} hideHeader />
        </>
      ) : undefined}
    />

    {/* Rename dialog */}
    <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t.meetingDetailPage.renameMeeting.title}</DialogTitle>
        </DialogHeader>
        <Input
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && renameDraft.trim()) {
              updateMeeting({ id: meetingId, data: { title: renameDraft.trim() } });
              toast.success(t.meetingDetailPage.meetingRenamed);
              setRenameOpen(false);
            }
          }}
          placeholder={t.meetingDetailPage.renameMeeting.placeholder}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setRenameOpen(false)}>{t.meetingDetailPage.renameMeeting.cancel}</Button>
          <Button
            onClick={() => {
              if (renameDraft.trim()) {
                updateMeeting({ id: meetingId, data: { title: renameDraft.trim() } });
                toast.success(t.meetingDetailPage.meetingRenamed);
                setRenameOpen(false);
              }
            }}
            disabled={!renameDraft.trim()}
          >
            {t.meetingDetailPage.renameMeeting.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
  );
}
