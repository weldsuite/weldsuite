
import { MeetingIntelligence } from '@/components/weldcrm/calls/meeting-intelligence';
import type { MeetingIntelligenceCall, TranscriptionActions, TranscriptionData } from '@/components/weldcrm/calls/meeting-intelligence';
import {
  useDeleteVoipCall,
  useTranscribeVoipCall,
} from '@/hooks/queries/use-voip-calls-queries';
import type { VoipCall } from '@/lib/api/domains/call-intelligence';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { getTranslations } from '@/lib/i18n';

interface Transcription {
  id: string;
  status: string;
  fullText?: string;
  summary?: string;
  actionItems?: string[];
  speakerCount?: number;
  wordCount?: number;
  segments?: Array<{
    id: string;
    speaker?: string;
    speakerName?: string;
    text: string;
    startTime?: number;
    endTime?: number;
    start?: number;
    end?: number;
  }>;
}

interface CallDetailClientProps {
  call: VoipCall;
  transcription?: Transcription | null;
}

function formatPhoneNumber(number: string): string {
  if (!number) return '';
  const cleaned = number.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+') && cleaned.length > 7) {
    const countryCode = cleaned.slice(0, cleaned.length > 12 ? 3 : 2);
    const rest = cleaned.slice(countryCode.length);
    const groups = rest.match(/.{1,4}/g) || [];
    return `${countryCode} ${groups.join(' ')}`;
  }
  return number;
}

function normalizeTranscription(transcription?: Transcription | null, speakerFallback = 'Speaker'): TranscriptionData | null {
  if (!transcription) return null;

  return {
    id: transcription.id,
    status: transcription.status,
    fullText: transcription.fullText,
    summary: transcription.summary,
    actionItems: transcription.actionItems,
    speakerCount: transcription.speakerCount,
    wordCount: transcription.wordCount,
    segments: transcription.segments?.map((seg) => ({
      id: seg.id,
      speaker: seg.speaker || seg.speakerName || speakerFallback,
      speakerName: seg.speakerName,
      text: seg.text,
      start: seg.start ?? seg.startTime ?? 0,
      end: seg.end ?? seg.endTime ?? 0,
    })),
  };
}

export function CallDetailClient({ call, transcription }: CallDetailClientProps) {
  const { getClient } = useAppApiClient();
  const deleteCallMut = useDeleteVoipCall();
  const transcribeMut = useTranscribeVoipCall();
  const t = getTranslations('weldmeet');
  const td = t.weldcall.callDetail;

  const phoneLabel = call.direction === 'inbound'
    ? call.fromNumberFormatted || formatPhoneNumber(call.fromNumber)
    : call.toNumberFormatted || formatPhoneNumber(call.toNumber);

  const subject = call.direction === 'inbound'
    ? td.inboundCallFrom.replace('{phoneLabel}', phoneLabel)
    : td.outboundCallTo.replace('{phoneLabel}', phoneLabel);

  // Normalize VoipCall to MeetingIntelligenceCall
  const normalizedCall: MeetingIntelligenceCall = {
    id: call.id,
    subject,
    date: call.initiatedAt,
    duration: call.duration || call.recordingDuration,
  };

  const normalizedTranscription = normalizeTranscription(transcription, td.speaker);

  // Wire up transcription actions
  const transcriptionActions: TranscriptionActions = {
    onTranscribe: async (id) => {
      // app-api answers with `{ data: { id } }` on 201 and throws on failure
      // (e.g. 409 when a transcription already exists), rather than the legacy
      // in-band `{ success: false, error }`.
      try {
        await transcribeMut.mutateAsync({ callId: id });
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error?.message || 'Failed to start transcription' };
      }
    },
    onFetchTranscription: async (id) => {
      const client = await getClient();
      // app-api returns the transcription row (with `segments`) under `data`,
      // and 404s when there isn't one yet — the client throws on 404.
      try {
        const result = await client.get<{ data: Transcription }>(
          `/call-intelligence/calls/${id}/transcription`,
        );
        if (!result.data) return { success: false, transcription: null };
        return { success: true, transcription: normalizeTranscription(result.data) };
      } catch {
        return { success: false, transcription: null };
      }
    },
    onPollStatus: async (id) => {
      const client = await getClient();
      // `TranscriptionActions.onPollStatus` wants the status *object*
      // (`{ status, errorMessage }`), which is exactly app-api's `data` payload.
      const result = await client.get<{
        data: { exists: boolean; status?: string; errorMessage?: string };
      }>(`/call-intelligence/calls/${id}/transcription/status`);
      return { status: result.data };
    },
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCallMut.mutateAsync(id);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete call' };
    }
  };

  // `recordingStorageUrl` is the Telnyx-signed mp3 the `call.recording.saved`
  // webhook stores on the row, and app-api's `GET /api/calls/:id` returns it
  // verbatim — it's the same URL the transcription pipeline fetches, so the
  // player can point straight at it with no streaming endpoint in between.
  // Gate on the URL rather than `isRecorded`: that flag is set optimistically
  // when the call is *created*, so it's true long before (and when) no
  // recording ever lands.
  return (
    <MeetingIntelligence
      call={normalizedCall}
      recordingUrl={call.recordingStorageUrl || undefined}
      mediaType="audio"
      initialTranscription={normalizedTranscription}
      transcriptionActions={transcriptionActions}
      enableWeldAgent
      onDelete={handleDelete}
      deleteRedirectUrl="/weldcall/history"
      backUrl="/weldcall/history"
      breadcrumbs={[
        { label: 'WeldCall', href: '/weldcall' },
        { label: td.history, href: '/weldcall/history' },
        { label: phoneLabel || td.callDetails },
      ]}
      tabs={['transcript', 'speakers', 'meeting']}
      layout="full-width"
    />
  );
}
