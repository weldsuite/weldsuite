import { ReactNode, useEffect } from 'react';
import { PageLoader } from '@/components/page-loader';
import {
  useVoipPhoneNumbers,
  useVoipConfigured,
} from '@/hooks/queries/use-voip-calls-queries';
import { useCall } from '@/contexts/call-context';

interface WeldCallGateProps {
  children: ReactNode;
}

// WeldCall is available on every plan: this only holds the page until the
// workspace's phone numbers and VoIP config are loaded into the call context.
export function WeldCallGate({ children }: Readonly<WeldCallGateProps>) {
  const { data: phoneNumbersData, isLoading: phoneLoading } = useVoipPhoneNumbers();
  const { data: voipConfiguredData, isLoading: configLoading } = useVoipConfigured();
  const { setPhoneNumbers, setVoipConfigured } = useCall();

  const isLoading = phoneLoading || configLoading;

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

  return <>{children}</>;
}
