
import { useParams } from '@/lib/router';
import { ProjectWorkloadClient } from './workload-client';
import { useProjectWorkload } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';

export default function ProjectWorkloadPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const { data, isLoading, error } = useProjectWorkload(projectId);

  if (isLoading) return <PageLoader fullScreen={false} />;

  return <ProjectWorkloadClient initialData={data?.data} error={error ? String(error) : null} projectId={projectId} />;
}
