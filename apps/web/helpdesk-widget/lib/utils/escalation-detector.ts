export interface EscalationResult {
  shouldEscalate: boolean;
  reason?: string;
  source: 'user_request' | 'ai_suggestion' | 'none';
}

// Common phrases users say when they want to speak to a human
const USER_ESCALATION_PHRASES = [
  // Direct requests for human
  'speak to a person',
  'talk to a human',
  'real person',
  'human agent',
  'live agent',
  'speak to someone',
  'talk to someone',
  'actual person',
  'real human',
  'live person',
  'real support',
  'live support',
  'live chat',

  // Wanting a person
  'i want a person',
  'want to talk to a person',
  'want to speak to a person',
  'need a person',
  'need a human',
  'need to talk to someone',
  'need to speak to someone',
  'can i talk to a person',
  'can i speak to a person',
  'can i talk to someone',
  'can i speak to someone',
  'let me talk to',
  'let me speak to',
  'get me a person',
  'get me a human',
  'get me someone',

  // Bot frustration
  'not a bot',
  'stop talking to bot',
  'stop with the bot',
  'done with bot',
  'tired of bot',
  'hate this bot',
  'useless bot',
  'stupid bot',
  'this bot',
  'you are a bot',
  'youre a bot',
  "you're a bot",
  'talking to a bot',
  'stop being a bot',
  'not helping',
  'this is not helping',
  'this isnt helping',
  "this isn't helping",
  'you are not helping',
  "you're not helping",
  'youre not helping',

  // Transfer/escalation requests
  'transfer to agent',
  'transfer me',
  'connect me',
  'escalate',
  'escalate this',

  // Authority figures
  'supervisor',
  'manager',
  'representative',
  'rep please',
  'agent please',
  'human please',
  'person please',
  'someone please',

  // Support team
  'customer service',
  'help desk',
  'support team',
  'support agent',
  'customer support',
  'technical support',
  'tech support',
  'need help from person',

  // Simple/short phrases (common quick requests)
  'human',
  'agent',
  'person',
  'help me',
  'real help',
];

/**
 * Detect if a message indicates the need for human escalation
 */
export function detectEscalation(
  message: string,
  role: 'user' | 'assistant'
): EscalationResult {
  const lowerMessage = message.toLowerCase().trim();

  // Check for AI escalation marker
  if (role === 'assistant' && lowerMessage.includes('[needs_human_agent]')) {
    return {
      shouldEscalate: true,
      reason: 'AI agent determined human assistance is needed',
      source: 'ai_suggestion',
    };
  }

  // Check for user requesting human help
  if (role === 'user') {
    for (const phrase of USER_ESCALATION_PHRASES) {
      if (lowerMessage.includes(phrase)) {
        return {
          shouldEscalate: true,
          reason: `User requested: "${phrase}"`,
          source: 'user_request',
        };
      }
    }
  }

  return {
    shouldEscalate: false,
    source: 'none',
  };
}
