import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldcalendar/events/')({
  beforeLoad: () => {
    throw redirect({ to: '/weldcalendar' });
  },
});
