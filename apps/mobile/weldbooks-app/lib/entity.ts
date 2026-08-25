/**
 * Helpers for picking which accounting entity (administration) is active.
 *
 * Kept pure so the fallback order can be unit-tested without the React
 * context or AsyncStorage. Matches the platform EntitySwitcher: honour the
 * user's last choice when it still exists, otherwise the workspace default,
 * otherwise the first active entity.
 */

import type { AccountingEntity } from '@/types/accounting';

export function entityStorageKey(organizationId: string): string {
  return `@weldbooks/active-entity:${organizationId}`;
}

export function isEntityActive(entity: AccountingEntity): boolean {
  return entity.isActive !== false;
}

export function resolveActiveEntity(
  entities: AccountingEntity[],
  selectedId: string | null,
): AccountingEntity | null {
  const active = entities.filter(isEntityActive);
  if (selectedId) {
    const match = active.find((entity) => entity.id === selectedId);
    if (match) return match;
  }
  return active.find((entity) => entity.isDefault) ?? active[0] ?? null;
}
