/**
 * "Try with AI": ask WeldAgent (or a workspace agent) for something to show,
 * see the reply as the chat draws it, and lift each visual's spec into the
 * editor. Runs a real chat turn on the caller's data and credits.
 */

import { useMemo, useState } from 'react';
import { ArrowUpRight, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { splitReplyParts, visualTitle, type ChatVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { AgentChatInput } from '@/components/weldagent/agent-chat-input';
import { AssistantMessage, TypingIndicator, UserMessage } from '@/components/weldagent/chat/chat-message';
import { ChatVisualActionsProvider } from '@/components/weldagent/visuals/visual-actions-context';
import { getTranslations } from '@/lib/i18n';
import { useWeldAgentChat } from '@/hooks/queries/use-ai-chat';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import { fill } from '@/components/weldagent/visuals/chat-visual';
import { specText } from './spec-editor';

const PERSONA = '__weldagent__';

export function TryWithAi({ onOpen }: Readonly<{ onOpen: (visual: ChatVisual) => void }>) {
  const t = getTranslations('common').ai;
  const g = t.visuals.gallery;
  const { data: agents = [] } = useAgents({ status: 'active' });
  const [agent, setAgent] = useState(PERSONA);
  const [input, setInput] = useState('');
  const { messages, sendMessage, isSending, error, reset } = useWeldAgentChat({
    agentId: agent === PERSONA ? null : agent,
  });
  const lastReply = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastPrompt = [...messages].reverse().find((m) => m.role === 'user');
  const visuals = useMemo(
    () =>
      lastReply
        ? splitReplyParts(lastReply.content).parts.flatMap((part) => (part.kind === 'visual' ? [part.visual] : []))
        : [],
    [lastReply],
  );

  const copy = async (visual: ChatVisual) => {
    try {
      await navigator.clipboard.writeText(specText(visual));
      toast.success(g.copied);
    } catch {
      // Clipboard refused: nothing to undo.
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <p className="text-sm text-muted-foreground">{g.tryHint}</p>
        <div className="flex items-end gap-3">
          <div className="w-56 space-y-1.5">
            <Label className="text-xs">{g.agent}</Label>
            <Select
              value={agent}
              onValueChange={(next) => {
                setAgent(next);
                reset();
              }}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PERSONA}>{t.chat.generalAgent}</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <AgentChatInput
          value={input}
          onChange={setInput}
          onSubmit={(text) => {
            if (!text.trim() || isSending) return;
            sendMessage(text);
            setInput('');
          }}
          placeholder={g.promptPlaceholder}
          isSending={isSending}
          recordTags={false}
        />
        {error && <p className="text-sm text-destructive">{error === 'credits' ? t.chat.insufficientCredits : t.chat.error}</p>}
        <ChatVisualActionsProvider ask={(prompt) => toast(fill(g.wouldAsk, { prompt }))}>
          <div className="space-y-4">
            {lastPrompt && <UserMessage>{lastPrompt.content}</UserMessage>}
            {lastReply?.content ? <AssistantMessage content={lastReply.content} /> : isSending && <TypingIndicator label={g.working} />}
          </div>
        </ChatVisualActionsProvider>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{g.spec}</p>
        {lastReply && !isSending && visuals.length === 0 && <p className="text-sm text-muted-foreground">{g.noVisuals}</p>}
        {visuals.map((visual, i) => (
          <div key={`${visual.type}-${i}`} className="rounded-lg border p-2">
            <p className="mb-1 truncate text-xs font-medium">{visualTitle(visual) || t.visuals.kinds[visual.type]}</p>
            <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-[11px] leading-snug">{specText(visual)}</pre>
            <div className="mt-1.5 flex gap-1">
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => onOpen(visual)}>
                <ArrowUpRight className="size-3.5" />
                {g.openInEditor}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => void copy(visual)}>
                <Copy className="size-3.5" />
                {g.copy}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
