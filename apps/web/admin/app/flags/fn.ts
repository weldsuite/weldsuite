import { createServerFn } from '@tanstack/react-start';
import { kubernetesOnly } from '@/lib/edition';
import { loadFlagsPage } from './data';

/** The feature flags page's data, on the server; the Kubernetes editions only (Global's flags are in Flagship). */
export const getFlagsPage = createServerFn({ method: 'GET' })
  .middleware([kubernetesOnly])
  .handler(() => loadFlagsPage());
