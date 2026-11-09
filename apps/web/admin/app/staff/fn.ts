import { createServerFn } from '@tanstack/react-start';
import { kubernetesOnly } from '@/lib/edition';
import { loadStaffPage } from './data';

/** The staff list's data, on the server; the Kubernetes editions only (Global's staff are in Clerk). */
export const getStaffPage = createServerFn({ method: 'GET' })
  .middleware([kubernetesOnly])
  .handler(() => loadStaffPage());
