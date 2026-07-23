
import { useEffect } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useCall } from '@/contexts/call-context';
import { CallHistoryList } from './call-history-list';
import type { VoipCall, VoipPhoneNumber, CallStats } from '@/lib/api/domains/call-intelligence';
import { useTranslations } from '@weldsuite/i18n/client';

interface CallIntelligenceClientProps {
  calls: VoipCall[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasMore: boolean;
  };
  stats: CallStats;
  phoneNumbers: VoipPhoneNumber[];
  voipConfigured: boolean;
  searchParams: {
    page?: string;
    search?: string;
    direction?: 'inbound' | 'outbound';
    status?: string;
  };
}

export function CallIntelligenceClient({
  calls,
  phoneNumbers,
  voipConfigured,
}: CallIntelligenceClientProps) {
  const { setPhoneNumbers, setVoipConfigured } = useCall();
  const t = useTranslations();

  useBreadcrumbs([
    { label: 'WeldCall', href: '/weldcall' },
    { label: t('sweep.miscB.history') },
  ]);

  // Set phone numbers and voip config in context
  useEffect(() => {
    setPhoneNumbers(phoneNumbers);
    setVoipConfigured(voipConfigured);
  }, [phoneNumbers, voipConfigured, setPhoneNumbers, setVoipConfigured]);

  return (
    <div className="min-h-screen bg-white dark:bg-background">
      <CallHistoryList calls={calls} voipConfigured={voipConfigured} />
    </div>
  );
}
