import { atom } from 'jotai';
import type { ChatMessage } from '@/hooks/queries/use-ai-chat';

/**
 * What the WeldAgent side panel remembers while the panel is closed: the agent
 * picked in its header and the conversation so far. The panel itself unmounts
 * on close (Esc, Ctrl+J), so the state lives in a module-level atom for the
 * rest of the browser session.
 */
export interface PanelSession {
  /** The workspace agent chosen in the header; '' is the general WeldAgent. */
  agentId: string;
  messages: ChatMessage[];
}

export const EMPTY_PANEL_SESSION: PanelSession = { agentId: '', messages: [] };

export const panelSessionAtom = atom<PanelSession>(EMPTY_PANEL_SESSION);

/**
 * The messages worth keeping: a reply that has not produced any text yet (the
 * empty bubble of a stream that was just opened) is left out.
 */
export function messagesToRemember(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1);
  if (last?.role === 'assistant' && !last.content.trim()) return messages.slice(0, -1);
  return messages;
}
