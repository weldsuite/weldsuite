/**
 * Timeline sentences for the internal problem events (an incident linked to,
 * or taken off, a problem). Kept out of messages-timeline.tsx, which only
 * calls in here.
 */

import { getTranslations } from '@/lib/i18n';
import type { DeskEventType, DeskMessage } from '@/hooks/queries/use-desk-queries';

const PROBLEM_EVENTS = new Set<DeskEventType>(['problem_linked', 'problem_unlinked']);

/** Problem events only the team sees. */
export function isProblemEvent(message: DeskMessage): boolean {
  const eventType = message.metadata?.eventType;
  return eventType !== undefined && PROBLEM_EVENTS.has(eventType);
}

/** "Ada linked this ticket to problem #4", or null for any other event. */
export function problemEventSentence(message: DeskMessage, actor: string): string | null {
  if (!isProblemEvent(message)) return null;
  const t = getTranslations('deskProblems').timeline;
  const meta = message.metadata ?? {};
  const number = typeof meta.problemNumber === 'number' ? String(meta.problemNumber) : '?';
  const template = meta.eventType === 'problem_linked' ? t.linked : t.unlinked;
  return template.replace('{actor}', actor).replace('{number}', number);
}
