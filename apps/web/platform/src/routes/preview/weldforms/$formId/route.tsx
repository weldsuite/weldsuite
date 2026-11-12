import { createFileRoute, Outlet } from '@tanstack/react-router';
import FormShell from '@/app/weldforms/form/shell';

/** The builder shell of /preview/weldforms/$formId: header, tabs and the editor state. */
export const Route = createFileRoute('/preview/weldforms/$formId')({
  component: () => (
    <FormShell>
      <Outlet />
    </FormShell>
  ),
});
