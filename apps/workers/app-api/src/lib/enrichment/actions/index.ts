/**
 * Enrichment action registry. Register a new provider here (one line) and the
 * enrichment workflow picks it up automatically by `column.type`.
 */

import { aiAction } from './ai';
import { emailFinderAction } from './email-finder';
import { phoneFinderAction } from './phone-finder';
import type { EnrichmentAction } from './types';

const REGISTRY: Record<string, EnrichmentAction> = {
  [aiAction.type]: aiAction,
  [emailFinderAction.type]: emailFinderAction,
  [phoneFinderAction.type]: phoneFinderAction,
};

export function getAction(type: string): EnrichmentAction | undefined {
  return REGISTRY[type];
}

export type { ActionContext, ActionResult, EnrichmentAction } from './types';
