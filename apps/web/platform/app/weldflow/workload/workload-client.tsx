
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { WorkloadView, type WorkloadViewProps } from '@/components/weldflow/workload/workload-view';

export function WorkloadClient({ initialData, error }: Readonly<WorkloadViewProps>) {
  const t = useI18n().t.projects;
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
