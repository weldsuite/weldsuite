import { AiUnavailable } from '@/components/ai/ai-unavailable';

// AI has been removed platform-wide. This page used to configure WeldDesk's
// AI agent (behavior, tools, integrations, sub-agents) with a live chat
// preview. The route stays mounted so the "Chat Widget" / weldagent sidebar
// link doesn't 404 — it now just shows the shared unavailable state instead
// of calling the helpdesk AI settings API.
export default function HelpdeskAiConfigPage() {
  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      <AiUnavailable />
    </div>
  );
}
