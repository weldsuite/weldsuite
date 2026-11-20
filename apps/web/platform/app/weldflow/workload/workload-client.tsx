import { WorkloadView, type WorkloadViewProps } from '@/components/weldflow/workload/workload-view';
import { WorkloadShell, WorkloadViewSwitch } from './workload-shell';

export function WorkloadClient({ initialData, error }: Readonly<WorkloadViewProps>) {
  return (
    <WorkloadShell>
      <WorkloadView initialData={initialData} error={error} leading={<WorkloadViewSwitch />} />
    </WorkloadShell>
  );
}
