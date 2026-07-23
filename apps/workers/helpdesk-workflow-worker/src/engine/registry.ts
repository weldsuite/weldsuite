/**
 * Step Handler Registry
 *
 * Simple map-based registry. Handlers self-register via registerHandler().
 * The engine calls getHandler(type) to find the right handler for each step.
 */

import type { StepHandler } from '../types';

const handlers = new Map<string, StepHandler>();

/** Register a step handler. Throws if type is already registered. */
export function registerHandler(handler: StepHandler): void {
  if (handlers.has(handler.type)) {
    console.warn(`[WorkflowRegistry] Handler for "${handler.type}" already registered, overwriting`);
  }
  handlers.set(handler.type, handler);
}

/** Get handler for a step type. Returns undefined if not found. */
export function getHandler(type: string): StepHandler | undefined {
  return handlers.get(type);
}

/** Get all registered handler types (for debugging). */
export function getRegisteredTypes(): string[] {
  return Array.from(handlers.keys());
}
