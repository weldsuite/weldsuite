/**
 * Customer profile storage for persisting customer identification across sessions,
 * and the visitor token that identifies this browser to helpdesk-widget-api.
 */

export interface CustomerProfile {
  email?: string;
  customerId?: string;
  name?: string;
  lastUpdated: Date;
}

const STORAGE_KEY_PREFIX = 'weldsuite_helpdesk_customer_';
/** Before visitor tokens the widget made its own visitor id; only read to swap it once (see visitor-session). */
const LEGACY_VISITOR_ID_KEY = 'weldsuite_helpdesk_visitor_id';
const VISITOR_TOKEN_KEY_PREFIX = 'weldsuite_helpdesk_visitor_token_';
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

function storageRemove(key: string): void {
  memoryStore.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable: the memory copy is gone already
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

/** Secure random index in [0, length). */
function randomIndex(length: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % length;
}

/**
 * Generate a friendly visitor name (e.g. "Curious Falcon")
 */
function generateFriendlyName(): string {
  const adj = ADJECTIVES[randomIndex(ADJECTIVES.length)];
  const animal = ANIMALS[randomIndex(ANIMALS.length)];
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
 * The visitor token `POST /api/visitor` issued for this widget. It is the
 * visitor's only credential: every other API call carries it as a Bearer.
 */
export function getVisitorToken(widgetId: string): string | null {
  return storageGet(`${VISITOR_TOKEN_KEY_PREFIX}${widgetId}`);
}

export function saveVisitorToken(widgetId: string, token: string): void {
  storageSet(`${VISITOR_TOKEN_KEY_PREFIX}${widgetId}`, token);
}

export function clearVisitorToken(widgetId: string): void {
  storageRemove(`${VISITOR_TOKEN_KEY_PREFIX}${widgetId}`);
}

/** The browser-made visitor id from before visitor tokens, if this browser still has one. */
export function getLegacyVisitorId(): string | null {
  return storageGet(LEGACY_VISITOR_ID_KEY);
}

export function clearLegacyVisitorId(): void {
  storageRemove(LEGACY_VISITOR_ID_KEY);
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
  storageRemove(getStorageKey(widgetId));
}

/**
 * Check if customer is identified (has email)
 */
export function isCustomerIdentified(widgetId: string): boolean {
  const profile = getCustomerProfile(widgetId);
  return !!(profile?.email);
}
