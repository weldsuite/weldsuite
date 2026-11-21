import { atom, useAtomValue } from 'jotai';
import type { AiMeta } from '@weldsuite/app-api-client/schemas/ai-settings';
import { AiMetaBadge } from './ai-meta-badge';

/**
 * Who answered the last WeldMail AI call (`meta.ai` of its response), kept
 * for the AI bars that show it. Empty on Global, whose responses carry none.
 */
export const lastMailAiAtom = atom<AiMeta | null>(null);

/** "Claude · outside the EU" next to WeldMail's AI results; nothing until an answer carries `meta.ai`. */
export function MailAiBadge({ className }: Readonly<{ className?: string }>) {
  const ai = useAtomValue(lastMailAiAtom);
  return <AiMetaBadge ai={ai} className={className} />;
}
