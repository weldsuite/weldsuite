/**
 * Runtime environment variables helper
 *
 * This module provides access to environment variables that are injected at runtime
 * via the __ENV.js script (for Docker deployments) or from import.meta.env (for local dev).
 */

type EnvVars = {
  VITE_CLERK_PUBLISHABLE_KEY: string;
  VITE_API_BASE_URL: string;
  VITE_SIGNALR_HUB_URL: string;
  VITE_CLERK_SIGN_IN_URL: string;
  VITE_CLERK_SIGN_UP_URL: string;
  VITE_BETTERSTACK_SOURCE_TOKEN: string;
  VITE_MIXPANEL_TOKEN: string;
};

declare global {
  interface Window {
    __ENV?: Partial<EnvVars>;
  }
}

/**
 * Get a runtime environment variable
 * Falls back to import.meta.env for SSR and local development
 */
export function getEnv<K extends keyof EnvVars>(key: K): string {
  // Client-side: check window.__ENV first (runtime injection)
  if (typeof window !== "undefined" && window.__ENV?.[key]) {
    return window.__ENV[key] as string;
  }

  // Server-side or fallback: use import.meta.env
  return (import.meta.env[key] as string) ?? "";
}

/**
 * Get all runtime environment variables
 */
export function getAllEnv(): Partial<EnvVars> {
  if (typeof window !== "undefined" && window.__ENV) {
    return window.__ENV;
  }

  return {
    VITE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
    VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
    VITE_SIGNALR_HUB_URL: import.meta.env.VITE_SIGNALR_HUB_URL,
    VITE_CLERK_SIGN_IN_URL: import.meta.env.VITE_CLERK_SIGN_IN_URL,
    VITE_CLERK_SIGN_UP_URL: import.meta.env.VITE_CLERK_SIGN_UP_URL,
    VITE_BETTERSTACK_SOURCE_TOKEN: import.meta.env.VITE_BETTERSTACK_SOURCE_TOKEN,
    VITE_MIXPANEL_TOKEN: import.meta.env.VITE_MIXPANEL_TOKEN,
  };
}
