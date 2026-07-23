/**
 * Customer profile storage for persisting customer identification across sessions
 */

export interface CustomerProfile {
  email?: string;
  visitorId?: string;
  customerId?: string;
  name?: string;
  lastUpdated: Date;
}

const STORAGE_KEY_PREFIX = 'weldsuite_helpdesk_customer_';
const VISITOR_ID_KEY = 'weldsuite_helpdesk_visitor_id';
const VISITOR_NAME_KEY = 'weldsuite_helpdesk_visitor_name';

// In-memory fallback when localStorage is unavailable (incognito, full, disabled)
const memoryStore = new Map<string, string>();

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memoryStore.get(key) ?? null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    memoryStore.set(key, value);
  }
}

const ADJECTIVES = [
  'Brave', 'Bright', 'Calm', 'Clever', 'Cool', 'Curious', 'Daring', 'Eager',
  'Fair', 'Fast', 'Friendly', 'Gentle', 'Happy', 'Honest', 'Keen', 'Kind',
  'Lively', 'Lucky', 'Neat', 'Noble', 'Proud', 'Quick', 'Sharp', 'Smart',
  'Swift', 'Warm', 'Wise', 'Bold', 'Witty', 'Sunny',
];

const ANIMALS = [
  'Bear', 'Cat', 'Deer', 'Dog', 'Dolphin', 'Eagle', 'Falcon', 'Fox',
  'Hawk', 'Horse', 'Koala', 'Lion', 'Lynx', 'Otter', 'Owl', 'Panda',
  'Penguin', 'Phoenix', 'Rabbit', 'Raven', 'Robin', 'Seal', 'Sparrow',
  'Tiger', 'Whale', 'Wolf', 'Wren', 'Zebra', 'Heron', 'Jaguar',
];

/**
 * Generate a friendly visitor name (e.g. "Curious Falcon")
 */
function generateFriendlyName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj} ${animal}`;
}

/**
 * Get or create a persistent friendly name for anonymous visitors
 */
export function getOrCreateVisitorName(): string {
  let name = storageGet(VISITOR_NAME_KEY);
  if (!name) {
    name = generateFriendlyName();
    storageSet(VISITOR_NAME_KEY, name);
  }
  return name;
}

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
  let visitorId = storageGet(VISITOR_ID_KEY);
  if (!visitorId) {
    visitorId = generateVisitorId();
    storageSet(VISITOR_ID_KEY, visitorId);
  }
  return visitorId;
}

/**
 * Get the visitor ID without creating a new one
 */
export function getVisitorId(): string | null {
  return storageGet(VISITOR_ID_KEY);
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
    const data = storageGet(key);
    if (!data) return null;

    const profile = JSON.parse(data);
    return {
      ...profile,
      lastUpdated: new Date(profile.lastUpdated),
    };
  } catch {
    return null;
  }
}

/**
 * Save customer profile for a widget
 */
export function saveCustomerProfile(widgetId: string, profile: Omit<CustomerProfile, 'lastUpdated'>): void {
  const key = getStorageKey(widgetId);
  const data: CustomerProfile = {
    ...profile,
    lastUpdated: new Date(),
  };
  storageSet(key, JSON.stringify(data));
}

/**
 * Clear customer profile for a widget
 */
export function clearCustomerProfile(widgetId: string): void {
  try {
    localStorage.removeItem(getStorageKey(widgetId));
  } catch {
    memoryStore.delete(getStorageKey(widgetId));
  }
}

/**
 * Check if customer is identified (has email)
 */
export function isCustomerIdentified(widgetId: string): boolean {
  const profile = getCustomerProfile(widgetId);
  return !!(profile?.email);
}
