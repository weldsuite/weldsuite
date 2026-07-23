
import { usePhoneNumbers, useVoipConfigured } from '@/hooks/use-phone-numbers';
import { PhoneNumberSettingsClient } from './phone-number-settings-client';
import { PageLoader } from '@/components/page-loader';

export default function PhoneNumberSettingsPage() {
  const { data: phoneNumbers, isLoading: isLoadingNumbers } = usePhoneNumbers();
  const { data: isConfigured, isLoading: isLoadingConfigured } = useVoipConfigured();

  const isLoading = isLoadingNumbers || isLoadingConfigured;

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <PhoneNumberSettingsClient
      phoneNumbers={phoneNumbers || []}
      isConfigured={isConfigured ?? false}
    />
  );
}
