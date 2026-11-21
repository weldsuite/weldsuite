import type { CallStatus } from '@/contexts/weldchat-call-context';

/** The parts of the WeldChat call a conversation page looks at. */
export interface ConversationCall {
  status: CallStatus;
  channelId: string | null;
  isFullscreen: boolean;
  isPiP: boolean;
}

/**
 * Whether a conversation shows its call in place of the chat. A call that has
 * ended no longer does: the chat comes back at once and fades in
 * (`isReturningFromCall`), with no "call ended" screen in between.
 */
export function isInlineCall(call: ConversationCall, channelId: string | null | undefined): boolean {
  return (
    !!channelId &&
    call.status !== 'idle' &&
    call.status !== 'ended' &&
    call.channelId === channelId &&
    !call.isFullscreen &&
    !call.isPiP
  );
}

/** The moment after this conversation's call ended, while its chat fades back in. */
export function isReturningFromCall(call: ConversationCall, channelId: string | null | undefined): boolean {
  return !!channelId && call.status === 'ended' && call.channelId === channelId;
}

/** Fades the chat back in where the call was: slowly, easing in and out. */
export const RETURN_FROM_CALL_CLASS = 'animate-in fade-in duration-[950ms] ease-in-out motion-reduce:animate-none';
