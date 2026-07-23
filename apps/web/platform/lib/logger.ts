/**
 * BetterStack Logger
 *
 * Centralized logging via @logtail/browser.
 * Falls back to console-only when no source token is configured (local dev).
 *
 * Stores references to the original console methods so that the
 * console.error intercept in main.tsx doesn't cause infinite loops.
 */

import { Logtail } from '@logtail/browser';
import { getEnv } from '@/lib/env';

// Keep original console references — used by `log.*` so the
// global console.error override in main.tsx won't recurse.
const _console = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let logtail: Logtail | null = null;

function getLogtail(): Logtail | null {
  if (logtail) return logtail;

  const token = getEnv('VITE_BETTERSTACK_SOURCE_TOKEN');
  if (!token) return null;

  logtail = new Logtail(token);
  return logtail;
}

export const log = {
  debug(message: string, context?: Record<string, unknown>) {
    _console.debug(`[DEBUG] ${message}`, context ?? '');
    getLogtail()?.debug(message, context);
  },

  info(message: string, context?: Record<string, unknown>) {
    _console.info(`[INFO] ${message}`, context ?? '');
    getLogtail()?.info(message, context);
  },

  warn(message: string, context?: Record<string, unknown>) {
    _console.warn(`[WARN] ${message}`, context ?? '');
    getLogtail()?.warn(message, context);
  },

  error(message: string, context?: Record<string, unknown>) {
    _console.error(`[ERROR] ${message}`, context ?? '');
    getLogtail()?.error(message, context);
  },
};

/**
 * Send a log directly to Logtail only (no console output).
 * Used by the console.error intercept to avoid double-printing.
 */
export function sendToLogtail(message: string, context?: Record<string, unknown>) {
  getLogtail()?.error(message, context);
}

/**
 * Flush pending logs. Call before page unload / visibility hidden.
 */
export function flush(): Promise<void> {
  const instance = getLogtail();
  if (!instance) return Promise.resolve();
  return instance.flush().then(() => {});
}
