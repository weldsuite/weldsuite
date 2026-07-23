/**
 * Weld SDK - Security Utilities
 * Security validation and origin checking for postMessage communication
 */

import type { SecurityConfig } from '../types/config';
import { Logger } from './logger';

/**
 * SecurityManager class
 */
export class SecurityManager {
  private config: SecurityConfig;
  private logger: Logger;
  private allowedOrigins: Set<string>;

  constructor(config: SecurityConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.allowedOrigins = new Set(config.allowedOrigins || []);

    // Always allow same origin
    this.allowedOrigins.add(window.location.origin);
  }

  /**
   * Validate message origin
   */
  public isOriginAllowed(origin: string): boolean {
    // Check if origin is in allowed list (includes same-origin and programmatically added origins)
    if (this.allowedOrigins.has(origin)) {
      return true;
    }

    // Check for wildcard patterns
    for (const allowed of this.allowedOrigins) {
      if (this.matchesPattern(origin, allowed)) {
        return true;
      }
    }

    this.logger.warn('Origin not allowed', { origin });
    return false;
  }

  /**
   * Match origin against pattern (supports wildcards)
   */
  private matchesPattern(origin: string, pattern: string): boolean {
    // Exact match
    if (origin === pattern) {
      return true;
    }

    // Wildcard pattern (e.g., "https://*.example.com")
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
      );
      return regex.test(origin);
    }

    return false;
  }

  /**
   * Validate postMessage event
   */
  public validateMessageEvent(event: MessageEvent): boolean {
    // Check origin
    if (!this.isOriginAllowed(event.origin)) {
      this.logger.warn('Invalid message origin', { origin: event.origin });
      return false;
    }

    // Check if message has data
    if (!event.data) {
      this.logger.warn('Message has no data');
      return false;
    }

    // Check if message is an object
    if (typeof event.data !== 'object') {
      this.logger.warn('Message data is not an object');
      return false;
    }

    return true;
  }

  /**
   * Sanitize message data
   */
  public sanitizeMessageData(data: any): any {
    if (!this.config.sanitizeInput) {
      return data;
    }

    // Deep clone to avoid modifying original
    const sanitized = JSON.parse(JSON.stringify(data));

    // Recursively sanitize strings
    this.sanitizeObject(sanitized);

    return sanitized;
  }

  /**
   * Recursively sanitize object properties
   */
  private sanitizeObject(obj: any): void {
    if (typeof obj !== 'object' || obj === null) {
      return;
    }

    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        obj[key] = this.sanitizeString(obj[key]);
      } else if (typeof obj[key] === 'object') {
        this.sanitizeObject(obj[key]);
      }
    }
  }

  /**
   * Sanitize string to prevent XSS
   */
  private sanitizeString(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '');
  }

  /**
   * Generate secure random ID
   */
  public generateSecureId(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Validate iframe source
   */
  public isValidIframeSource(src: string): boolean {
    try {
      const url = new URL(src, window.location.origin);

      // Check if URL is from allowed origin
      if (!this.isOriginAllowed(url.origin)) {
        this.logger.warn('Invalid iframe source origin', { src });
        return false;
      }

      // Prevent javascript: protocol
      if (url.protocol === 'javascript:') {
        this.logger.warn('Javascript protocol not allowed in iframe source');
        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn('Invalid iframe source URL', { src, error });
      return false;
    }
  }

  /**
   * Create Content Security Policy
   */
  public createCSP(): string {
    const origins = Array.from(this.allowedOrigins).join(' ');

    return [
      `default-src 'self' ${origins}`,
      `script-src 'self' 'unsafe-inline' ${origins}`,
      `style-src 'self' 'unsafe-inline' ${origins}`,
      `img-src 'self' data: https: ${origins}`,
      `font-src 'self' data: ${origins}`,
      `connect-src 'self' ${origins}`,
      `frame-src 'self' ${origins}`,
      `media-src 'self' ${origins}`,
    ].join('; ');
  }

  /**
   * Add allowed origin
   */
  public addAllowedOrigin(origin: string): void {
    this.allowedOrigins.add(origin);
    this.logger.debug('Added allowed origin', { origin });
  }

  /**
   * Remove allowed origin
   */
  public removeAllowedOrigin(origin: string): void {
    this.allowedOrigins.delete(origin);
    this.logger.debug('Removed allowed origin', { origin });
  }

  /**
   * Get all allowed origins
   */
  public getAllowedOrigins(): string[] {
    return Array.from(this.allowedOrigins);
  }
}

/**
 * Rate limiting utility
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number = 100, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if request is allowed
   */
  public isAllowed(key: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(key) || [];

    // Remove old requests outside window
    const validRequests = requests.filter((time) => now - time < this.windowMs);

    // Check if limit exceeded
    if (validRequests.length >= this.maxRequests) {
      return false;
    }

    // Add current request
    validRequests.push(now);
    this.requests.set(key, validRequests);

    return true;
  }

  /**
   * Reset rate limit for key
   */
  public reset(key: string): void {
    this.requests.delete(key);
  }

  /**
   * Clear all rate limits
   */
  public clearAll(): void {
    this.requests.clear();
  }
}

/**
 * Token validation utilities
 */
export class TokenValidator {
  private static readonly TOKEN_PATTERN = /^[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*$/;

  /**
   * Check if string looks like a JWT token
   */
  public static isJWT(token: string): boolean {
    return this.TOKEN_PATTERN.test(token);
  }

  /**
   * Decode JWT payload (without verification)
   */
  public static decodeJWT(token: string): any | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return null;
      }

      const payload = parts[1];
      const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }

  /**
   * Check if JWT is expired
   */
  public static isExpired(token: string): boolean {
    const payload = this.decodeJWT(token);
    if (!payload || !payload.exp) {
      return true;
    }

    return Date.now() >= payload.exp * 1000;
  }
}
