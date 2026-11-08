import { useAtom, type PrimitiveAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { LegalEntity, LegalEntityApp } from '@weldsuite/app-api-client/schemas/legal-entities';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useLegalEntities } from '@/hooks/queries/use-legal-entities-queries';
import { setHrLegalEntityId } from '@/lib/api/legal-entity-scope';

/** The unscoped key WeldBooks used before entities were shared (one value for every workspace). */
export const LEGACY_ACCOUNTING_ENTITY_KEY = 'weldsuite.currentAccountingEntityId';

export function currentLegalEntityStorageKey(workspaceId: string | null | undefined): string {
  return `weldsuite.currentLegalEntityId:${workspaceId ?? 'none'}`;
}

/**
 * Carry the old unscoped WeldBooks selection over to this workspace's key, once.
 * The old key is removed afterwards, so the first workspace that opens claims it;
 * an id this workspace doesn't know is replaced by the fallback on first load.
 */
function migrateLegacySelection(key: string): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const legacy = storage.getItem(LEGACY_ACCOUNTING_ENTITY_KEY);
    if (legacy === null) return;
    if (storage.getItem(key) === null) storage.setItem(key, legacy);
    storage.removeItem(LEGACY_ACCOUNTING_ENTITY_KEY);
  } catch {
    /* storage unavailable: nothing to migrate */
  }
}

const atoms = new Map<string, PrimitiveAtom<string | null>>();

/**
 * One selected-entity atom per workspace, shared by WeldBooks and WeldHR.
 * JSON-encoded like every `atomWithStorage` value, which is also how the old
 * unscoped key was stored, so the migrated value reads as is.
 */
function currentLegalEntityIdAtom(workspaceId: string | null | undefined): PrimitiveAtom<string | null> {
  const key = currentLegalEntityStorageKey(workspaceId);
  let atom = atoms.get(key);
  if (!atom) {
    if (workspaceId) migrateLegacySelection(key);
    atom = atomWithStorage<string | null>(key, null, undefined, { getOnInit: true });
    atoms.set(key, atom);
  }
  return atom;
}

/** Read/write the selected legal entity id of the current workspace (not validated against the entity list). */
export function useCurrentLegalEntityId() {
  const workspaceId = useWorkspaceId();
  const [entityId, setEntityId] = useAtom(currentLegalEntityIdAtom(workspaceId));
  return { entityId, setEntityId };
}

/** The entity to fall back to: the workspace default, else the first active one, else the first. */
export function fallbackLegalEntity<T extends Pick<LegalEntity, 'id' | 'isDefault' | 'isActive'>>(
  entities: readonly T[],
): T | undefined {
  return (
    entities.find((e) => e.isDefault && e.isActive !== false) ??
    entities.find((e) => e.isActive !== false) ??
    entities[0]
  );
}

/**
 * The selected legal entity for an app: the stored selection when it is one of
 * the entities the app is enabled for, else the default (or first) of them.
 * `entityId` is null while the list loads and when the app has no entity.
 */
export function useCurrentLegalEntity(options: { app?: LegalEntityApp; enabled?: boolean } = {}) {
  const { entityId: storedId, setEntityId } = useCurrentLegalEntityId();
  const query = useLegalEntities({ app: options.app, enabled: options.enabled });
  const entities = query.data ?? [];
  const entity = entities.find((e) => e.id === storedId) ?? fallbackLegalEntity(entities);
  return {
    entityId: entity?.id ?? null,
    entity,
    entities,
    isLoading: query.isLoading,
    setEntityId,
  };
}

/**
 * Keep the WeldHR request mirror in step with the selected entity. Call it
 * once, where the WeldHR sidebar renders; `active` is false outside WeldHR,
 * which clears the mirror so other modules' hr-api calls span the member's
 * entities. The mirror is set while rendering so the queries of the same
 * render pass already carry the right key and header. The fallback is not
 * persisted: only a switch by the member changes the stored selection.
 */
export function useSyncHrLegalEntity(active: boolean) {
  const { entityId, entities } = useCurrentLegalEntity({ app: 'weldhr', enabled: active });
  setHrLegalEntityId(active ? entityId : null);
  return { entityId, hasEntities: entities.length > 0 };
}
