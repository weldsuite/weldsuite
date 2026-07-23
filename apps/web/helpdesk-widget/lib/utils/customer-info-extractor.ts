/**
 * Utility to extract customer information (email, name) from chat messages
 * Used when WeldAgent asks for customer details during conversation
 */

export interface ExtractedCustomerInfo {
  email?: string;
  name?: string;
  hasEmail: boolean;
  hasName: boolean;
}

// Email regex pattern
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Common name patterns (captures words that look like names)
// This is a simple heuristic - names are hard to detect perfectly
const NAME_PATTERNS = [
  // "My name is John" or "I'm John" or "I am John"
  /(?:my name is|i'?m|i am|call me|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  // "John here" or "It's John"
  /(?:it'?s|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  // Just a capitalized name at the start of a short message
  /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)$/,
];

/**
 * Extract email address from a message
 */
export function extractEmail(message: string): string | undefined {
  const match = message.match(EMAIL_REGEX);
  return match ? match[0].toLowerCase() : undefined;
}

/**
 * Extract name from a message
 * This uses simple heuristics and may not catch all cases
 */
export function extractName(message: string): string | undefined {
  // Clean up the message
  const cleanMessage = message.trim();

  // Try each name pattern
  for (const pattern of NAME_PATTERNS) {
    const match = cleanMessage.match(pattern);
    if (match && match[1]) {
      // Validate it doesn't look like a common word
      const potentialName = match[1].trim();
      if (!isCommonWord(potentialName)) {
        return potentialName;
      }
    }
  }

  // If message is short (1-3 words) and contains capitalized words, it might be a name
  const words = cleanMessage.split(/\s+/);
  if (words.length <= 3 && words.length >= 1) {
    const capitalizedWords = words.filter(w => /^[A-Z][a-z]+$/.test(w) && !isCommonWord(w));
    if (capitalizedWords.length >= 1 && capitalizedWords.length <= 2) {
      return capitalizedWords.join(' ');
    }
  }

  return undefined;
}

/**
 * Extract both email and name from a message
 */
export function extractCustomerInfo(message: string): ExtractedCustomerInfo {
  const email = extractEmail(message);
  const name = extractName(message);

  return {
    email,
    name,
    hasEmail: !!email,
    hasName: !!name,
  };
}

/**
 * Check if a word is a common English word (not a name)
 */
function isCommonWord(word: string): boolean {
  const commonWords = new Set([
    'hello', 'hi', 'hey', 'thanks', 'thank', 'please', 'yes', 'no', 'okay',
    'ok', 'sure', 'the', 'and', 'but', 'for', 'not', 'you', 'all', 'can',
    'had', 'her', 'was', 'one', 'our', 'out', 'are', 'has', 'his', 'how',
    'its', 'let', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did',
    'get', 'got', 'him', 'just', 'help', 'here', 'need', 'want', 'have',
    'issue', 'problem', 'question', 'support', 'customer', 'service',
  ]);

  return commonWords.has(word.toLowerCase());
}

/**
 * Check if we're still waiting for customer info based on conversation context
 */
export interface CustomerInfoCollectionState {
  waitingForName: boolean;
  waitingForEmail: boolean;
  collectedName?: string;
  collectedEmail?: string;
}

/**
 * Determine what info is still needed based on what we have
 */
export function getNeededInfo(
  currentEmail?: string,
  currentName?: string
): { needsEmail: boolean; needsName: boolean } {
  return {
    needsEmail: !currentEmail,
    needsName: !currentName,
  };
}

/**
 * Generate AI prompt suffix to ask for missing customer info
 */
export function getCustomerInfoPrompt(needsEmail: boolean, needsName: boolean): string {
  if (needsEmail && needsName) {
    return 'Before we continue, could you please share your name and email address so I can better assist you?';
  } else if (needsEmail) {
    return 'Could you please share your email address so I can follow up with you if needed?';
  } else if (needsName) {
    return 'May I know your name so I can address you properly?';
  }
  return '';
}
