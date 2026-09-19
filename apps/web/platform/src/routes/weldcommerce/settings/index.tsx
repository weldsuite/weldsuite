import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldcommerce/settings/')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/apps/weldcommerce${location.searchStr}${location.hash}` });
  },
});
