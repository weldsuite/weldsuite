import { createFileRoute, redirect } from '@tanstack/react-router';

// `/weldsocial` → WeldSocial's dashboard at /social (see ./$.tsx).
export const Route = createFileRoute('/weldsocial/')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/social${location.searchStr}`, replace: true });
  },
});
