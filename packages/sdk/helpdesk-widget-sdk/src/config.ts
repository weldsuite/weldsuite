/**
 * SDK Configuration
 * Manages environment-specific settings and URLs
 */

export interface SDKConfig {
  /**
   * Base URL for the helpdesk widget
   * Defaults to production URL
   */
  baseUrl?: string;
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG = {
  /**
   * Production widget URL
   * Change this to your production helpdesk widget domain
   */
  baseUrl: 'https://widget.weldsuite.org',
} as const;

/**
 * Get the widget base URL from config or use default
 */
export function getBaseUrl(config?: SDKConfig): string {
  return config?.baseUrl || DEFAULT_CONFIG.baseUrl;
}

/**
 * Development configuration helper
 * Use this for local development
 */
export const DEV_CONFIG: SDKConfig = {
  baseUrl: 'http://localhost:3100',
};

/**
 * Staging configuration helper
 * Use this for staging environment
 */
export const STAGING_CONFIG: SDKConfig = {
  baseUrl: 'https://widget-staging.welddesk.com',
};
