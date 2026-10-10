import { createFileRoute, redirect } from '@tanstack/react-router';

// WeldCall's Contacts page became People; keep old links and bookmarks working.
export const Route = createFileRoute('/weldcall/contacts/')({
  beforeLoad: () => {
    throw redirect({ to: '/weldcall/people', replace: true });
  },
});
