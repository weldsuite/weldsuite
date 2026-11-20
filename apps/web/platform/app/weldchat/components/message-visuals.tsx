/**
 * The visuals an agent showed in its reply (`metadata.visuals`, ADR
 * AGENT-016): charts, stat tiles, tables and record cards under the message
 * text. "Ask about this" writes `@Agent Tell me more about …` in the composer
 * of the thread the message is in.
 */

import { lazy, Suspense, useMemo } from 'react';
import { readVisualsMetadata } from '@weldsuite/app-api-client/schemas/chat-visuals';
import { ChatVisualActionsProvider } from '@/components/weldagent/visuals/visual-actions-context';
import { requestCompose } from './chat-context';

// Charts pull in recharts: loaded only when a message carries a visual.
const ChatVisual = lazy(() =>
  import('@/components/weldagent/visuals/chat-visual').then((m) => ({ default: m.ChatVisual })),
);

interface MessageVisualsProps {
  message: {
    authorId?: string | null;
    authorType?: string;
    parentId?: string | null;
    metadata?: unknown;
  };
}

export function MessageVisuals({ message }: Readonly<MessageVisualsProps>) {
  const visuals = useMemo(() => readVisualsMetadata(message.metadata), [message.metadata]);
  const agentId = message.authorId;
  const parentId = message.parentId ?? null;
  const ask = useMemo(
    () => (agentId ? (prompt: string) => requestCompose(parentId, `<@${agentId}> ${prompt}`) : undefined),
    [agentId, parentId],
  );
  if (message.authorType !== 'agent' || visuals.length === 0) return null;

  return (
    <ChatVisualActionsProvider ask={ask}>
      <div data-testid="chat-message-visuals" className="mt-2 max-w-3xl space-y-2">
        {visuals.map((visual, i) => (
          <Suspense
            // Specs have no id; position in the message is stable.
            key={`${visual.type}-${i}`}
            fallback={<div className="h-48 rounded-xl border" aria-hidden />}
          >
            <ChatVisual visual={visual} className="my-0" />
          </Suspense>
        ))}
      </div>
    </ChatVisualActionsProvider>
  );
}
