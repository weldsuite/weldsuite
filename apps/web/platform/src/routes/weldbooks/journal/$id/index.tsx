import { createFileRoute, redirect } from '@tanstack/react-router';

// A journal entry opens in the shared object panel on the journal list; the
// old detail URL lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldbooks/journal/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldbooks/journal?stack=journal_entry:${encodeURIComponent(params.id)}:fullscreen`,
      replace: true,
    });
  },
});
