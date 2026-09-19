import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldcommerce/')({
  beforeLoad: () => {
    throw redirect({ href: '/apps/weldcommerce' });
  },
});
