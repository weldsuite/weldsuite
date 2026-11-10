import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldforms/$formId/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/weldforms/$formId/edit', params: { formId: params.formId }, replace: true });
  },
});
