export interface EscalationResult {
  shouldEscalate: boolean;
  reason?: string;
  triggeredBy: 'ai' | 'user' | 'none';
  urgency?: 'low' | 'medium' | 'high' | 'urgent';
}

/**
 * User phrases that indicate they want to speak with a human
 */
const USER_ESCALATION_PHRASES = [
  'speak to a person',
  'talk to a human',
  'real person',
  'actual person',
  'human agent',
  'live agent',
  'customer service',
  'speak to someone',
  'talk to someone',
  'representative',
  'real agent',
  'not helpful',
  'this isn\'t working',
  'doesn\'t help',
  'not solving',
  'frustrated',
  'angry',
  'upset',
  'supervisor',
  'manager',
  'escalate',
  'complaint',
];

/**
 * AI marker for when it determines it cannot help
 */
const AI_ESCALATION_MARKER = '[NEEDS_HUMAN_AGENT]';

/**
 * Detect if a message (user or AI) should trigger escalation to human agent
 */
export function detectEscalation(
  message: string,
  role: 'user' | 'assistant'
): EscalationResult {
  const lowerMessage = message.toLowerCase();

  // Check for AI marker
  if (role === 'assistant' && message.includes(AI_ESCALATION_MARKER)) {
    // Extract reason if provided after marker
    const markerIndex = message.indexOf(AI_ESCALATION_MARKER);
    const afterMarker = message.substring(markerIndex + AI_ESCALATION_MARKER.length).trim();
    const reason = afterMarker || 'AI determined it cannot adequately help with this request';

    return {
      shouldEscalate: true,
      reason: reason.replace(/^[:–-]\s*/, ''), // Remove leading punctuation
      triggeredBy: 'ai',
      urgency: determineUrgency(lowerMessage)
    };
  }

  // Check for user escalation phrases
  if (role === 'user') {
    const foundPhrase = USER_ESCALATION_PHRASES.find(phrase =>
      lowerMessage.includes(phrase)
    );

    if (foundPhrase) {
      return {
        shouldEscalate: true,
        reason: `Customer requested: "${foundPhrase}"`,
        triggeredBy: 'user',
        urgency: determineUrgency(lowerMessage)
      };
    }
  }

  return {
    shouldEscalate: false,
    triggeredBy: 'none'
  };
}

/**
 * Determine urgency based on message content
 */
function determineUrgency(lowerMessage: string): 'low' | 'medium' | 'high' | 'urgent' {
  const urgentKeywords = ['urgent', 'emergency', 'critical', 'immediately', 'asap', 'right now'];
  const highKeywords = ['important', 'soon', 'quickly', 'frustrated', 'angry', 'upset'];
  const mediumKeywords = ['help', 'issue', 'problem', 'question'];

  if (urgentKeywords.some(keyword => lowerMessage.includes(keyword))) {
    return 'urgent';
  }

  if (highKeywords.some(keyword => lowerMessage.includes(keyword))) {
    return 'high';
  }

  if (mediumKeywords.some(keyword => lowerMessage.includes(keyword))) {
    return 'medium';
  }

  return 'low';
}

/**
 * Remove escalation markers from AI response before showing to user
 */
export function cleanAiResponse(response: string): string {
  return response
    .replace(AI_ESCALATION_MARKER, '')
    .replace(/\[ACTION:.*?\]/g, '') // Also remove action markers
    .trim();
}

/**
 * Check if user has been waiting too long (repeated messages without resolution)
 */
function detectFrustrationFromHistory(
  messages: Array<{ role: string; content: string }>,
  threshold: number = 5
): boolean {
  if (messages.length < threshold) {
    return false;
  }

  // Get last N messages
  const recentMessages = messages.slice(-threshold);

  // Count user messages vs AI messages
  const userMessages = recentMessages.filter(m => m.role === 'user').length;

  // If more than 70% are from user, they might be frustrated
  const userRatio = userMessages / recentMessages.length;

  return userRatio > 0.7;
}
