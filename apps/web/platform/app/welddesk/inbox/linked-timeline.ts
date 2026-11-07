/**
 * Timeline sentences for roadmap-2 ticket changes: impact and urgency in an
 * `attributes_changed` event, and the internal linked-ticket events (links,
 * merges, major incidents). Kept out of messages-timeline.tsx, which only
 * calls in here.
 */

import { getTranslations } from '@/lib/i18n';
import type { DeskAttributeChange, DeskEventType, DeskLevel, DeskMessage } from '@/hooks/queries/use-desk-queries';

type Fill = (template: string, value?: unknown, field?: string) => string;

/** The impact or urgency line of an `attributes_changed` event. */
export function impactUrgencySentences(change: DeskAttributeChange, fill: Fill): string[] {
  const t = getTranslations('helpdesk').priorityMatrix;
  const to = typeof change.to === 'string' ? (change.to as DeskLevel) : null;
  const label = to ? t.levels[to] ?? to : null;
  if (change.field === 'impact') return [label ? fill(t.timeline.impactSet, label) : fill(t.timeline.impactCleared)];
  return [label ? fill(t.timeline.urgencySet, label) : fill(t.timeline.urgencyCleared)];
}

const LINK_EVENTS = new Set<DeskEventType>([
  'linked',
  'unlinked',
  'merged_into',
  'merged_from',
  'incident_marked',
  'incident_unmarked',
]);

/** Linked-ticket events only the team sees. */
export function isLinkEvent(message: DeskMessage): boolean {
  const eventType = message.metadata?.eventType;
  return eventType !== undefined && LINK_EVENTS.has(eventType);
}

/** "Ada linked this ticket to #12", or null for any other event. */
export function linkEventSentence(message: DeskMessage, actor: string): string | null {
  const t = getTranslations('helpdesk').ticketLinks.timeline;
  const meta = message.metadata ?? {};
  const number = String(meta.linkedConversationNumber ?? '?');
  const toParent = meta.linkRole === 'parent';
  const fill = (template: string) => template.replace('{actor}', actor).replace('{number}', number);
  switch (meta.eventType) {
    case 'linked':
      return fill(toParent ? t.linkedToParent : t.linkedChild);
    case 'unlinked':
      return fill(toParent ? t.unlinkedFromParent : t.unlinkedChild);
    case 'merged_into':
      return fill(t.mergedInto);
    case 'merged_from':
      return fill(t.mergedFrom);
    case 'incident_marked':
      return fill(t.incidentMarked);
    case 'incident_unmarked':
      return fill(t.incidentUnmarked);
    default:
      return null;
  }
}
