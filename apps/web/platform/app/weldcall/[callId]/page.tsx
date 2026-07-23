import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useVoipCall, useVoipCallTranscription } from '@/hooks/queries/use-voip-calls-queries';
import { CallDetailClient } from './call-detail-client';
import { AlertTriangle } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';

export default function WeldCallDetailPage() {
  const params = useParams<{ callId: string }>();
  const callId = params.callId;
  const t = getTranslations('weldmeet');

  const { data: callData, isLoading: callLoading, isError } = useVoipCall(callId);
  const { data: transcriptionData } = useVoipCallTranscription(callId);

  if (callLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const call = callData?.data;

  if (!call || isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <AlertTriangle className="h-8 w-8" />
        <p>{t.weldcall.callDetailPage.callNotFound}</p>
      </div>
    );
  }

  const transcription = transcriptionData?.success ? transcriptionData.transcription : null;

  return <CallDetailClient call={call} transcription={transcription} />;
}
