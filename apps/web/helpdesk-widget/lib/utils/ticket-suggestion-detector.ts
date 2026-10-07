export interface TicketSuggestion {
  shouldCreateTicket: boolean;
  subject?: string;
  category?: string;
  priority?: string;
  description?: string;
}

/**
 * Detect if an AI response suggests creating a ticket
 */
export function detectTicketSuggestion(
  message: string,
  role: 'user' | 'assistant'
): TicketSuggestion {
  // Only check assistant messages
  if (role !== 'assistant') {
    return { shouldCreateTicket: false };
  }

  const lowerMessage = message.toLowerCase();

  // Check for ticket creation marker
  if (!lowerMessage.includes('[create_ticket')) {
    return { shouldCreateTicket: false };
  }

  try {
    // Match pattern: [CREATE_TICKET | subject: "..." | category: "..." | priority: "..."]
    const match =
      /\[CREATE_TICKET\s*\|\s*subject:\s*"([^"]+)"\s*\|\s*category:\s*"([^"]+)"\s*\|\s*priority:\s*"([^"]+)"\s*\]/i.exec(message);

    if (match) {
      return {
        shouldCreateTicket: true,
        subject: match[1],
        category: match[2],
        priority: match[3],
      };
    }

    // Fallback: just detected marker but couldn't parse details
    return {
      shouldCreateTicket: true,
      subject: 'Support Request from Chat',
      category: 'general',
      priority: 'medium',
    };
  } catch {
    // Fallback on parse error: a malformed marker still means the AI asked
    // for a ticket, so create one with default details.
    return {
      shouldCreateTicket: true,
      subject: 'Support Request from Chat',
      category: 'general',
      priority: 'medium',
    };
  }
}
