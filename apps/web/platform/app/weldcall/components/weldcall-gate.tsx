import { ReactNode, useEffect } from 'react';
import { PageLoader } from '@/components/page-loader';
import { useSubscription } from '@/hooks/queries/use-billing-queries';
import {
  useVoipPhoneNumbers,
  useVoipConfigured,
} from '@/hooks/queries/use-voip-calls-queries';
import { useCall } from '@/contexts/call-context';
import { CallIntelligenceUpgradePrompt } from '../call-intelligence-upgrade-prompt';

interface WeldCallGateProps {
  children: ReactNode;
}

export function WeldCallGate({ children }: WeldCallGateProps) {
  const { data: subscription, isLoading: subLoading } = useSubscription();
  const { data: phoneNumbersData, isLoading: phoneLoading } = useVoipPhoneNumbers();
  const { data: voipConfiguredData, isLoading: configLoading } = useVoipConfigured();
  const { setPhoneNumbers, setVoipConfigured } = useCall();

  const hasAccess =
    subscription?.planSlug === 'scale' || subscription?.planSlug === 'enterprise';
  const isLoading = subLoading || phoneLoading || configLoading;

  useEffect(() => {
    if (phoneNumbersData?.data) {
      setPhoneNumbers(phoneNumbersData.data);
    }
  }, [phoneNumbersData, setPhoneNumbers]);

  useEffect(() => {
    if (voipConfiguredData) {
      setVoipConfigured(voipConfiguredData.configured || false);
    }
  }, [voipConfiguredData, setVoipConfigured]);

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (!hasAccess) {
    return <CallIntelligenceUpgradePrompt />;
  }

  return <>{children}</>;
}
