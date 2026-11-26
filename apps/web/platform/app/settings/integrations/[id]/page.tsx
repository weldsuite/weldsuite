import { useParams } from '@/lib/router';
import {
  EcommerceConnectorSettingsPage,
  isConnectorProvider,
} from '@/app/settings/integrations/connectors/ecommerce-connector-client';
import { sharedPageProviderBySlug } from '@/app/settings/integrations/workflow/providers';
import { WorkflowProviderPage } from '@/app/settings/integrations/workflow/workflow-provider-page';
import { IntegrationDetailClient } from './integration-detail-client';

export default function IntegrationDetailPage() {
  const params = useParams();
  const id = params.id as string;

  if (isConnectorProvider(id)) {
    return <EcommerceConnectorSettingsPage provider={id} />;
  }

  const workflowProvider = sharedPageProviderBySlug(id);
  if (workflowProvider) {
    return <WorkflowProviderPage provider={workflowProvider} />;
  }

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-y-auto">
      <IntegrationDetailClient integrationId={id} />
    </div>
  );
}
