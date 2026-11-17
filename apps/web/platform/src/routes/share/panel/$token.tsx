import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/share/panel/page';

/** The public page of a WeldPanel share link: no session, outside the workspace shell. `?embed=1` drops the header. */
export const Route = createFileRoute('/share/panel/$token')({
  validateSearch: (raw: Record<string, unknown>): { embed?: 1 } => (raw.embed === 1 || raw.embed === '1' || raw.embed === true ? { embed: 1 } : {}),
  component: PageComponent,
});
