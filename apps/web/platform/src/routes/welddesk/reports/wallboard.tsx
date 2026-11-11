import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/analytics/wallboard/page';

// `?team=` keeps the team filter in the URL so a TV can be bookmarked on one team.
export const Route = createFileRoute('/welddesk/reports/wallboard')({
  validateSearch: (search: Record<string, unknown>): { team?: string } =>
    typeof search.team === 'string' && search.team ? { team: search.team } : {},
  component: PageComponent,
});
