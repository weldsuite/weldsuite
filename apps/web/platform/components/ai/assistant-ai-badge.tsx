import { useAiFeature } from '@/hooks/queries/use-ai-settings-queries';
import { AiMetaBadge } from './ai-meta-badge';

/**
 * Which provider the assistant runs on, in its header ("Claude · outside the
 * EU"). It reads the workspace policy, so it shows before the first answer;
 * nothing on Global, which has no AI settings.
 */
export function AssistantAiBadge({ className }: Readonly<{ className?: string }>) {
  const { feature } = useAiFeature('assistant');
  return <AiMetaBadge ai={feature?.effective} className={className} />;
}
