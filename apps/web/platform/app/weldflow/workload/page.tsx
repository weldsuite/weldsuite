
import { useProjectWorkload } from '@/hooks/queries/use-projects-queries';
import { WorkloadClient } from './workload-client';
import { PageLoader } from '@/components/page-loader';

export default function WorkloadPage() {
  const { data, isLoading, error } = useProjectWorkload();

  if (isLoading) return <PageLoader fullScreen={false} />;

  return <WorkloadClient initialData={data?.data} error={error ? String(error) : null} />;
}
