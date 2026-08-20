import { useParams } from '@/lib/router';
import { EcommerceConnectorSettingsPage } from '@/app/settings/integrations/connectors/ecommerce-connector-client';
import { IntegrationDetailClient } from './integration-detail-client';

export default function IntegrationDetailPage() {
  const params = useParams();
  const id = params.id as string;

  if (id === 'woocommerce' || id === 'shopify') {
    return <EcommerceConnectorSettingsPage provider={id} />;
  }

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-y-auto">
      <IntegrationDetailClient integrationId={id} />
    </div>
  );
}
