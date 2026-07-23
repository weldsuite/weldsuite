import { useSearchParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { CallIntelligenceClient } from '../call-intelligence-client';
import {
  useVoipCalls,
  useVoipCallStats,
  useVoipPhoneNumbers,
  useVoipConfigured,
} from '@/hooks/queries/use-voip-calls-queries';
import { WeldCallGate } from '../components/weldcall-gate';

function CallHistoryContent() {
  const searchParams = useSearchParams();

  const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1;
  const search = searchParams.get('search') || undefined;
  const direction = searchParams.get('direction') as
    | 'inbound'
    | 'outbound'
    | undefined;
  const status = searchParams.get('status') || undefined;

  const { data: callsData, isLoading: callsLoading } = useVoipCalls({
    page,
    pageSize: 20,
    search,
    direction,
    status,
  });

  const { data: statsData, isLoading: statsLoading } = useVoipCallStats();
  const { data: phoneNumbersData, isLoading: phoneLoading } = useVoipPhoneNumbers();
  const { data: voipConfiguredData, isLoading: configLoading } = useVoipConfigured();

  const isLoading = callsLoading || statsLoading || phoneLoading || configLoading;

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const defaultStats = {
    totalCalls: 0,
    completedCalls: 0,
    totalDuration: 0,
    avgDuration: 0,
    inboundCalls: 0,
    outboundCalls: 0,
    recordedCalls: 0,
    totalCreditsConsumed: 0,
  };

  const defaultPagination = {
    page: 1,
    pageSize: 20,
    totalCount: 0,
    totalPages: 0,
    hasMore: false,
  };

  return (
    <CallIntelligenceClient
      calls={callsData?.data || []}
      pagination={callsData?.pagination || defaultPagination}
      stats={statsData?.data || defaultStats}
      phoneNumbers={phoneNumbersData?.data || []}
      voipConfigured={voipConfiguredData?.configured || false}
      searchParams={{ page: String(page), search, direction, status }}
    />
  );
}

export default function CallHistoryPage() {
  return (
    <WeldCallGate>
      <CallHistoryContent />
    </WeldCallGate>
  );
}
