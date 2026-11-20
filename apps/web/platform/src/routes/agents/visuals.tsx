import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/agents/visuals/page';

export const Route = createFileRoute('/agents/visuals')({ component: PageComponent });
