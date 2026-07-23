/**
 * Conversation ID Storage
 *
 * Only stores conversation IDs locally. All conversation data is fetched from the API.
 * The conversation ID acts as an access token - only those who know it can access it.
 */

const STORAGE_KEY_PREFIX = 'weldsuite_helpdesk_conv_ids_';
const MAX_CONVERSATIONS_PER_WIDGET = 50;
const CONVERSATION_EXPIRY_DAYS = 30;

interface StoredConversationRef {
  conversationId: string;
  createdAt: string;
  closedAt?: string;
}

/**
 * Get storage key for a specific widget
 */
function getStorageKey(widgetId: string): string {
  return `${STORAGE_KEY_PREFIX}${widgetId}`;
}

/**
 * Check if a conversation ref has expired
 */
function isExpired(ref: StoredConversationRef): boolean {
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() - CONVERSATION_EXPIRY_DAYS);
  return new Date(ref.createdAt) < expiryDate;
}

/**
 * Get all conversation IDs for a widget
 */
export function getStoredConversationIds(widgetId: string): string[] {
  try {
    const key = getStorageKey(widgetId);
    const data = localStorage.getItem(key);

    if (!data) {
      return [];
    }

    const refs: StoredConversationRef[] = JSON.parse(data);

    // Filter out expired conversations
    const activeRefs = refs.filter(ref => !isExpired(ref));

    // If we filtered out expired conversations, save the cleaned list
    if (activeRefs.length !== refs.length) {
      saveConversationRefs(widgetId, activeRefs);
    }

    return activeRefs.map(ref => ref.conversationId);
  } catch (error) {
    console.error('Failed to get conversation IDs from storage:', error);
    return [];
  }
}

/**
 * Save conversation refs
 */
function saveConversationRefs(widgetId: string, refs: StoredConversationRef[]): void {
  try {
    const key = getStorageKey(widgetId);

    // Keep only the most recent MAX_CONVERSATIONS_PER_WIDGET
    const limitedRefs = refs
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, MAX_CONVERSATIONS_PER_WIDGET);

    localStorage.setItem(key, JSON.stringify(limitedRefs));
  } catch (error) {
    console.error('Failed to save conversation refs to storage:', error);
  }
}

/**
 * Add a conversation ID to storage
 */
export function addConversationId(widgetId: string, conversationId: string): void {
  try {
    const key = getStorageKey(widgetId);
    const data = localStorage.getItem(key);
    const refs: StoredConversationRef[] = data ? JSON.parse(data) : [];

    // Check if already exists
    if (refs.some(ref => ref.conversationId === conversationId)) {
      return;
    }

    refs.push({
      conversationId,
      createdAt: new Date().toISOString(),
    });

    saveConversationRefs(widgetId, refs);
  } catch (error) {
    console.error('Failed to add conversation ID to storage:', error);
  }
}

/**
 * Remove a conversation ID from storage
 */
export function removeConversationId(widgetId: string, conversationId: string): void {
  try {
    const key = getStorageKey(widgetId);
    const data = localStorage.getItem(key);

    if (!data) return;

    const refs: StoredConversationRef[] = JSON.parse(data);
    const filtered = refs.filter(ref => ref.conversationId !== conversationId);
    saveConversationRefs(widgetId, filtered);
  } catch (error) {
    console.error('Failed to remove conversation ID from storage:', error);
  }
}

/**
 * Get the most recent conversation ID
 */
export function getMostRecentConversationId(widgetId: string): string | null {
  try {
    const key = getStorageKey(widgetId);
    const data = localStorage.getItem(key);

    if (!data) return null;

    const refs: StoredConversationRef[] = JSON.parse(data);
    // Filter out expired AND locally-closed conversations
    const activeRefs = refs.filter(ref => !isExpired(ref) && !ref.closedAt);

    if (activeRefs.length === 0) return null;

    const sorted = activeRefs.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return sorted[0]?.conversationId ?? null;
  } catch (error) {
    console.error('Failed to get most recent conversation ID:', error);
    return null;
  }
}

/**
 * Clear all conversation IDs for a widget
 */
export function clearConversationIds(widgetId: string): void {
  try {
    const key = getStorageKey(widgetId);
    localStorage.removeItem(key);
  } catch (error) {
    console.error('Failed to clear conversation IDs:', error);
  }
}

export function conversationExists(widgetId: string, conversationId: string): boolean {
  const ids = getStoredConversationIds(widgetId);
  return ids.includes(conversationId);
}

/**
 * Mark a conversation as closed in local storage.
 * Prevents it from being auto-restored on next widget open.
 */
export function markConversationClosed(widgetId: string, conversationId: string): void {
  try {
    const key = getStorageKey(widgetId);
    const data = localStorage.getItem(key);
    if (!data) return;

    const refs: StoredConversationRef[] = JSON.parse(data);
    const updated = refs.map((ref) =>
      ref.conversationId === conversationId
        ? { ...ref, closedAt: new Date().toISOString() }
        : ref,
    );
    saveConversationRefs(widgetId, updated);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Get the last seen message ID for a conversation
 */
export function getLastSeenMessageId(conversationId: string): string | null {
  try {
    return localStorage.getItem(`weldsuite_helpdesk_last_seen_${conversationId}`);
  } catch {
    return null;
  }
}

/**
 * Save the last seen message ID for a conversation
 */
export function setLastSeenMessageId(conversationId: string, messageId: string): void {
  try {
    localStorage.setItem(`weldsuite_helpdesk_last_seen_${conversationId}`, messageId);
  } catch {
    // Ignore storage errors
  }
}
