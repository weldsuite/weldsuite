
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { WorkloadView, type WorkloadViewProps } from '@/components/weldflow/workload/workload-view';
import { useI18n } from '@/lib/i18n/provider';

export function ProjectWorkloadClient({ initialData, error, projectId }: WorkloadViewProps & { projectId: string }) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.projects.workload.projects, href: '/weldflow' },
    { label: t.projects.workload.title },
  ]);

  return <WorkloadView initialData={initialData} error={error} projectId={projectId} />;
}
