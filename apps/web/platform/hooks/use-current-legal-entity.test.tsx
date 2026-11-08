import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { Provider, createStore } from 'jotai';

const env = vi.hoisted(() => ({
  workspaceId: 'ws_a' as string | null,
  entities: [] as Array<{ id: string; isDefault: boolean; isActive: boolean }>,
}));

vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => env.workspaceId }));
vi.mock('@/hooks/queries/use-legal-entities-queries', () => ({
  useLegalEntities: () => ({ data: env.entities, isLoading: false }),
}));

import {
  LEGACY_ACCOUNTING_ENTITY_KEY,
  currentLegalEntityStorageKey,
  useCurrentLegalEntity,
  useCurrentLegalEntityId,
  useSyncHrLegalEntity,
} from './use-current-legal-entity';
import { getHrLegalEntityId } from '@/lib/api/legal-entity-scope';

function wrapper(store = createStore()) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  }
  return Wrapper;
}

describe('current legal entity', () => {
  beforeEach(() => {
    localStorage.clear();
    env.workspaceId = 'ws_a';
    env.entities = [
      { id: 'ent_1', isDefault: false, isActive: true },
      { id: 'ent_2', isDefault: true, isActive: true },
    ];
  });

  it('persists the selection per workspace', () => {
    const { result } = renderHook(() => useCurrentLegalEntityId(), { wrapper: wrapper() });
    act(() => result.current.setEntityId('ent_1'));

    expect(localStorage.getItem(currentLegalEntityStorageKey('ws_a'))).toBe(JSON.stringify('ent_1'));
    expect(localStorage.getItem(currentLegalEntityStorageKey('ws_other'))).toBeNull();
  });

  it('moves the old unscoped WeldBooks selection to the first workspace that opens, once', () => {
    localStorage.setItem(LEGACY_ACCOUNTING_ENTITY_KEY, JSON.stringify('ent_1'));
    env.workspaceId = 'ws_migrate';
    const { result } = renderHook(() => useCurrentLegalEntityId(), { wrapper: wrapper() });

    expect(result.current.entityId).toBe('ent_1');
    expect(localStorage.getItem(currentLegalEntityStorageKey('ws_migrate'))).toBe(JSON.stringify('ent_1'));
    expect(localStorage.getItem(LEGACY_ACCOUNTING_ENTITY_KEY)).toBeNull();
  });

  it('falls back to the default entity when the selection is not one of the app entities', () => {
    localStorage.setItem(currentLegalEntityStorageKey('ws_a'), JSON.stringify('ent_gone'));
    const { result } = renderHook(() => useCurrentLegalEntity({ app: 'weldhr' }), { wrapper: wrapper() });

    expect(result.current.entityId).toBe('ent_2');
  });

  it('keeps a valid selection and mirrors it for WeldHR requests only while WeldHR is active', () => {
    localStorage.setItem(currentLegalEntityStorageKey('ws_a'), JSON.stringify('ent_1'));
    const { result, rerender } = renderHook(({ active }) => useSyncHrLegalEntity(active), {
      wrapper: wrapper(),
      initialProps: { active: true },
    });

    expect(result.current.entityId).toBe('ent_1');
    expect(getHrLegalEntityId()).toBe('ent_1');

    rerender({ active: false });
    expect(getHrLegalEntityId()).toBeNull();
  });
});
