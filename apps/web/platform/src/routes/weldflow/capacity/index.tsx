import { createFileRoute, redirect } from '@tanstack/react-router';

// Capacity is a view of the Workload page now; old links land there.
export const Route = createFileRoute('/weldflow/capacity/')({
  beforeLoad: () => {
    throw redirect({ to: '/weldflow/workload/capacity', replace: true });
  },
});
