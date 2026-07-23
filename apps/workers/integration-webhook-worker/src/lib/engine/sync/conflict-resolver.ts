/**
 * CRM Sync Engine — Conflict Resolver
 *
 * Determines how to handle conflicts when both WeldSuite and an external
 * CRM have modified the same record since the last sync.
 */

import type { ConflictStrategy } from '@weldsuite/db/schema';

export type ConflictAction = 'use_internal' | 'use_external' | 'queue_manual';

export interface ConflictResolution {
  action: ConflictAction;
}

export class ConflictResolver {
  constructor(private strategy: ConflictStrategy) {}

  /**
   * Determine how to resolve a conflict.
   *
   * @param internalUpdatedAt - When the internal record was last updated
   * @param externalUpdatedAt - When the external record was last updated
   * @returns The action to take
   */
  resolve(
    internalUpdatedAt: Date,
    externalUpdatedAt: Date,
  ): ConflictResolution {
    switch (this.strategy) {
      case 'external_wins':
        return { action: 'use_external' };

      case 'internal_wins':
        return { action: 'use_internal' };

      case 'manual':
        return { action: 'queue_manual' };

      case 'last_write_wins':
      default:
        return {
          action: internalUpdatedAt > externalUpdatedAt
            ? 'use_internal'
            : 'use_external',
        };
    }
  }
}
