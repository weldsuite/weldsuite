/**
 * Security utilities for the Helpdesk Widget SDK
 * Handles origin validation, message validation, and security configuration
 */

/**
 * Valid message types that can be received from widget iframes
 */
export const VALID_MESSAGE_TYPES = [
  'widget:ready',
  'widget:close',
  'widget:error',
  'launcher:clicked',
] as const;

export type ValidMessageType = typeof VALID_MESSAGE_TYPES[number];

/**
 * Structure of messages passed between SDK and widget iframes
 */
export interface WidgetMessage {
  type: ValidMessageType;
  data?: unknown;
}

/**
 * Validates if an origin is allowed to communicate with the SDK
 *
 * @param eventOrigin - The origin from the MessageEvent
 * @param expectedOrigin - The expected widget origin (from baseUrl)
 * @returns true if origin is valid, false otherwise
 */
export function isValidOrigin(eventOrigin: string, expectedOrigin: string): boolean {
  try {
    const eventUrl = new URL(eventOrigin);
    const expectedUrl = new URL(expectedOrigin);

    // Check protocol, hostname, and port match
    return (
      eventUrl.protocol === expectedUrl.protocol &&
      eventUrl.hostname === expectedUrl.hostname &&
      eventUrl.port === expectedUrl.port
    );
  } catch (error) {
    console.error('Invalid origin URL:', error);
    return false;
  }
}

/**
 * Validates if a message has a valid structure and type
 *
 * @param data - The message data from postMessage
 * @returns true if message is valid, false otherwise
 */
export function isValidMessage(data: unknown): data is WidgetMessage {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const message = data as Record<string, unknown>;

  // Check if type exists and is a valid message type
  if (typeof message.type !== 'string') {
    return false;
  }

  return VALID_MESSAGE_TYPES.includes(message.type as ValidMessageType);
}

/**
 * Security configuration for the widget SDK
 */
export const SECURITY_CONFIG = {
  /**
   * Maximum number of messages allowed per minute from a single iframe
   * Prevents message flooding attacks
   */
  MAX_MESSAGES_PER_MINUTE: 100,

  /**
   * Time window for rate limiting (in milliseconds)
   */
  RATE_LIMIT_WINDOW: 60000,
} as const;

/**
 * Simple rate limiter to prevent message flooding
 */
export class MessageRateLimiter {
  private messageTimestamps: number[] = [];
  private readonly maxMessages: number;
  private readonly timeWindow: number;

  constructor(
    maxMessages: number = SECURITY_CONFIG.MAX_MESSAGES_PER_MINUTE,
    timeWindow: number = SECURITY_CONFIG.RATE_LIMIT_WINDOW
  ) {
    this.maxMessages = maxMessages;
    this.timeWindow = timeWindow;
  }

  /**
   * Checks if a new message should be allowed based on rate limits
   *
   * @returns true if message is allowed, false if rate limit exceeded
   */
  public allowMessage(): boolean {
    const now = Date.now();

    // Remove timestamps older than the time window
    this.messageTimestamps = this.messageTimestamps.filter(
      timestamp => now - timestamp < this.timeWindow
    );

    // Check if we're under the limit
    if (this.messageTimestamps.length >= this.maxMessages) {
      console.warn('Rate limit exceeded: Too many messages');
      return false;
    }

    // Add current timestamp
    this.messageTimestamps.push(now);
    return true;
  }

  /**
   * Resets the rate limiter
   */
  public reset(): void {
    this.messageTimestamps = [];
  }
}
