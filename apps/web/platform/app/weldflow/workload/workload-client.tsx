
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { WorkloadView, type WorkloadViewProps } from '@/components/weldflow/workload/workload-view';
import { getTranslations } from '@/lib/i18n';

export function WorkloadClient({ initialData, error }: WorkloadViewProps) {
  const t = getTranslations('projects');
  useBreadcrumbs([
    { label: t.workload.projects, href: '/weldflow' },
    { label: t.workload.title },
  ]);

  return (
    <div className="-mx-3 md:-mx-4 -mt-3 md:-mt-4 flex flex-col h-[calc(100vh-60px)]">
      <WorkloadView initialData={initialData} error={error} />
    </div>
  );
}
