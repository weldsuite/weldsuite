import { createFileRoute, redirect } from '@tanstack/react-router';
import PageComponent from '@/app/weldapps/host/page';

/**
 * First-party modules that briefly shipped as hosted WeldApps and are platform
 * modules again. Old `/apps/{code}/…` links and bookmarks land on the module.
 */
const NATIVE_MODULE_PATHS: Record<string, string> = {
  weldcommerce: '/weldcommerce',
};

/**
 * Host layout for `/apps/{code}` and `/apps/{code}/*`.
 * Subpaths drive platform sidebar active state + iframe route sync;
 * the same host page renders for every section.
 */
export const Route = createFileRoute('/apps/$appCode')({
  beforeLoad: ({ params, location }) => {
    const modulePath = NATIVE_MODULE_PATHS[params.appCode];
    if (!modulePath) return;
    const rest = location.pathname.replace(/^\/apps\/[^/]+\/?/, '');
    const target = rest ? `${modulePath}/${rest}` : modulePath;
    throw redirect({ href: `${target}${location.searchStr}${location.hash}` });
  },
  component: PageComponent,
});
