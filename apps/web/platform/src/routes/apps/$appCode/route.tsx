import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldapps/host/page';

/**
 * Host layout for `/apps/{code}` and `/apps/{code}/*`.
 * Subpaths drive platform sidebar active state + iframe route sync;
 * the same host page renders for every section.
 */
export const Route = createFileRoute('/apps/$appCode')({
  component: PageComponent,
});
