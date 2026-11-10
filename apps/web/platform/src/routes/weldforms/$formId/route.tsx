import { createFileRoute, Outlet } from '@tanstack/react-router';
import FormShell from '@/app/weldforms/form/shell';

/** The builder shell: header, tabs and the editor state; each tab is a child route. */
export const Route = createFileRoute('/weldforms/$formId')({
  component: () => (
    <FormShell>
      <Outlet />
    </FormShell>
  ),
});
