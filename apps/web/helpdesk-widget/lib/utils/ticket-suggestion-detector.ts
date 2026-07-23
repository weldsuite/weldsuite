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
    const match = message.match(
      /\[CREATE_TICKET\s*\|\s*subject:\s*"([^"]+)"\s*\|\s*category:\s*"([^"]+)"\s*\|\s*priority:\s*"([^"]+)"\s*\]/i
    );

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
  } catch (error) {
    // Fallback on parse error
    return {
      shouldCreateTicket: true,
      subject: 'Support Request from Chat',
      category: 'general',
      priority: 'medium',
    };
  }
}
