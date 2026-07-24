export interface TicketSuggestion {
  shouldCreateTicket: boolean;
  reason?: string;
  suggestedSubject?: string;
  suggestedCategory?: string;
  suggestedPriority?: 'low' | 'normal' | 'high' | 'urgent';
}

/**
 * Detect if AI response suggests creating a support ticket.
 *
 * AI has been removed platform-wide, so no assistant messages are generated
 * anymore — this always returns "no suggestion" now. Kept (rather than
 * deleted) because `components/welddesk/chat-widget/exact-intercom-widget.tsx`
 * still imports it for its canned local preview flow.
 */
export function detectTicketSuggestion(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for call-site signature compat, see doc comment above
  _message: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for call-site signature compat, see doc comment above
  _role: 'user' | 'assistant'
): TicketSuggestion {
  return { shouldCreateTicket: false };
}

/**
 * Remove ticket markers from AI response before showing to user.
 * No-op now that AI responses no longer contain markers, but harmless to
 * keep for the same preview call site as above.
 */
export function cleanTicketMarkers(response: string): string {
  return response
    .replace(/\[CREATE_TICKET.*?\]/g, '')
    .trim();
}
