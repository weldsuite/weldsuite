import { createFileRoute } from '@tanstack/react-router';
import VoiceAgentsPage from '@/app/welddesk/ai-agents/page';

export const Route = createFileRoute('/welddesk/ai-agents/')({
  component: VoiceAgentsRoute,
});

function VoiceAgentsRoute() {
  return <VoiceAgentsPage />;
}
