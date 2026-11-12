import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/preview/weldforms/$formId/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/preview/weldforms/$formId/edit', params: { formId: params.formId }, replace: true });
  },
});
