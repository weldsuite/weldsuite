import { createFileRoute } from '@tanstack/react-router';
import DirectoriesPage from '@/app/weldchat/directories/page';

export const Route = createFileRoute('/weldchat/directories')({
  component: DirectoriesPage,
});
