import { createFileRoute, redirect } from '@tanstack/react-router';
import { withQuery } from '@/lib/with-query';

// Customers and suppliers are one Contacts list; old links and bookmarks land there with the role set
// (and every other parameter, such as an open panel's `?stack=`, kept).
export const Route = createFileRoute('/weldbooks/suppliers/')({
  beforeLoad: ({ location }) => {
    const params = new URLSearchParams(location.searchStr);
    params.set('role', 'supplier');
    throw redirect({ href: withQuery('/weldbooks/contacts', params.toString()), replace: true });
  },
});
