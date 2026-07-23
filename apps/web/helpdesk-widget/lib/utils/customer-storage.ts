/**
 * Customer profile storage for persisting customer identification across sessions
 */

export interface CustomerProfile {
  email?: string;
visitorId?: string;
  name?: string;
  lastUpdated: Date;
}

const STORAGE_KEY_PREFIX = 'weldsuite_helpdesk_customer_';
const VISITOR_ID_KEY = 'weldsuite_helpdesk_visitor_id';

/**
 * Generate a unique visitor ID
 */
function generateVisitorId(): string {
  return `visitor_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Get or create a persistent visitor ID for anonymous users
 */
export function getOrCreateVisitorId(): string {
  try {
    let visitorId = localStorage.getItem(VISITOR_ID_KEY);
    if (!visitorId) {
      visitorId = generateVisitorId();
      localStorage.setItem(VISITOR_ID_KEY, visitorId);
    }
    return visitorId;
  } catch (error) {
    // If localStorage is not available, generate a temporary ID
    return generateVisitorId();
  }
}

/**
 * Get the visitor ID without creating a new one
 */
export function getVisitorId(): string | null {
  try {
    return localStorage.getItem(VISITOR_ID_KEY);
  } catch (error) {
    return null;
  }
}

/**
 * Get storage key for a specific widget
 */
function getStorageKey(widgetId: string): string {
  return `${STORAGE_KEY_PREFIX}${widgetId}`;
}

/**
 * Get customer profile for a widget
 */
export function getCustomerProfile(widgetId: string): CustomerProfile | null {
  try {
    const key = getStorageKey(widgetId);
    const data = localStorage.getItem(key);

    if (!data) {
      return null;
    }

    const profile = JSON.parse(data);
    return {
      ...profile,
      lastUpdated: new Date(profile.lastUpdated),
    };
  } catch (error) {
    console.error('Failed to get customer profile from storage:', error);
    return null;
  }
}

/**
 * Save customer profile for a widget
 */
export function saveCustomerProfile(widgetId: string, profile: Omit<CustomerProfile, 'lastUpdated'>): void {
  try {
    const key = getStorageKey(widgetId);
    const data: CustomerProfile = {
      ...profile,
      lastUpdated: new Date(),
    };
    localStorage.setItem(key, JSON.stringify(data));
  } catch (error) {
    console.error('Failed to save customer profile to storage:', error);
  }
}

/**
 * Clear customer profile for a widget
 */
export function clearCustomerProfile(widgetId: string): void {
  try {
    const key = getStorageKey(widgetId);
    localStorage.removeItem(key);
  } catch (error) {
    console.error('Failed to clear customer profile from storage:', error);
  }
}

/**
 * Check if customer is identified (has email)
 */
export function isCustomerIdentified(widgetId: string): boolean {
  const profile = getCustomerProfile(widgetId);
  return !!(profile?.email);
}
