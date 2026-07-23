
import { useParams, useRouter } from '@/lib/router';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { IntegrationDetailClient } from './integration-detail-client';

export default function IntegrationDetailPage() {
  const params = useParams();
  const id = params.id as string;

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-y-auto">
      <IntegrationDetailClient integrationId={id} />
    </div>
  );
}
