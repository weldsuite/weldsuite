
import { useVoipConfigured, useAddresses, useBundles, useNumberPricing } from '@/hooks/use-phone-numbers';
import { NewNumberClient } from './new-number-client';
import { PageLoader } from '@/components/page-loader';

export default function NewNumberPage() {
  const { data: isConfigured, isLoading: isLoadingConfigured } = useVoipConfigured();
  const { data: addresses, isLoading: isLoadingAddresses } = useAddresses();
  const { data: bundles, isLoading: isLoadingBundles } = useBundles();
  const { data: pricingData, isLoading: isLoadingPricing } = useNumberPricing();

  const isLoading = isLoadingConfigured || isLoadingAddresses || isLoadingBundles || isLoadingPricing;

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <NewNumberClient
      isConfigured={isConfigured ?? false}
      addresses={addresses || []}
      bundles={bundles || []}
      pricingData={pricingData || []}
    />
  );
}
