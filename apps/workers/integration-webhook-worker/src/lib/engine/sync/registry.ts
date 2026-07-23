/**
 * CRM Sync Engine — Adapter Registry
 *
 * Maps provider names to their CrmSyncAdapter implementations.
 * Import and register adapters at startup.
 */

import type { CrmSyncAdapter } from './types';

const adapters: Record<string, CrmSyncAdapter> = {};

/**
 * Register a CRM sync adapter for a provider.
 */
export function registerAdapter(adapter: CrmSyncAdapter): void {
  adapters[adapter.provider] = adapter;
}

/**
 * Get the registered adapter for a provider.
 * Throws if not registered.
 */
export function getAdapter(provider: string): CrmSyncAdapter {
  const adapter = adapters[provider];
  if (!adapter) {
    throw new Error(`No CRM sync adapter registered for provider: ${provider}`);
  }
  return adapter;
}

/**
 * Check if an adapter is registered for a provider.
 */
export function hasAdapter(provider: string): boolean {
  return provider in adapters;
}

/**
 * Get all registered provider names.
 */
export function getRegisteredProviders(): string[] {
  return Object.keys(adapters);
}
