import { createFileRoute, redirect } from '@tanstack/react-router';

// WeldSocial's pages live under /social. A /weldsocial/… link, named the way
// every other app's path is, lands on the same page instead of on Home.
export const Route = createFileRoute('/weldsocial/$')({
  beforeLoad: ({ params, location }) => {
    const hash = location.hash ? `#${location.hash}` : '';
    throw redirect({
      href: `/social/${params._splat ?? ''}${location.searchStr}${hash}`,
      replace: true,
    });
  },
});
