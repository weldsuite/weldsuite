import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldpass/page';

export const Route = createFileRoute('/settings/apps/weldpass')({ component: PageComponent });
