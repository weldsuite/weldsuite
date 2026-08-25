/**
 * Accounting-entity gate.
 *
 * Every WeldBooks endpoint is entity-scoped — without a legal entity they all
 * fail with `400 No accounting entity resolved`. This mirrors the platform's
 * `AccountingLayoutClient` (PR #93): resolve the workspace's entities once, and
 * let the app shell show the setup door instead of letting each screen surface
 * its own error.
 *
 * The selected administration is persisted per workspace and sent as
 * `X-Accounting-Entity-Id` (same header the platform EntitySwitcher writes).
 * Only the initial load gates the UI. A background refresh that fails keeps the
 * cached entities so a flaky network never replaces a working app with an
 * error screen.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import api from '@/services/api';
import { entityStorageKey, resolveActiveEntity } from '@/lib/entity';
import type { AccountingEntity } from '@/types/accounting';

interface AccountingEntityContextValue {
  entities: AccountingEntity[];
  /** The selected administration, falling back to the workspace default. */
  activeEntity: AccountingEntity | null;
  hasEntity: boolean;
  /** True when the workspace has more than one active administration. */
  canSwitch: boolean;
  setActiveEntity: (id: string) => void;
  openSwitcher: () => void;
  closeSwitcher: () => void;
  switcherOpen: boolean;
  /** True only while the first load is in flight. */
  isLoading: boolean;
  /** Set only when the FIRST load failed — a stale-cache refresh error is swallowed. */
  loadError: boolean;
  isRefreshing: boolean;
  refresh: () => Promise<void>;
}

const AccountingEntityContext = createContext<AccountingEntityContextValue | undefined>(undefined);

export function AccountingEntityProvider({ children }: { children: React.ReactNode }) {
  const { user, organizationId } = useClerkAuth();
  const [entities, setEntities] = useState<AccountingEntity[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const hasLoadedRef = useRef(false);

  const load = useCallback(async () => {
    if (!user || !organizationId) {
      setEntities([]);
      setSelectedId(null);
      api.setAccountingEntityId(null);
      setIsLoading(false);
      return;
    }

    if (hasLoadedRef.current) setIsRefreshing(true);

    try {
      const [rows, stored] = await Promise.all([
        api.getEntities(),
        AsyncStorage.getItem(entityStorageKey(organizationId)),
      ]);
      const resolved = resolveActiveEntity(rows, stored);
      setEntities(rows);
      setSelectedId(resolved?.id ?? null);
      api.setAccountingEntityId(resolved?.id ?? null);
      if (resolved && resolved.id !== stored) {
        AsyncStorage.setItem(entityStorageKey(organizationId), resolved.id).catch(() => {});
      }
      setLoadError(false);
      hasLoadedRef.current = true;
    } catch (err) {
      console.error('Failed to load accounting entities:', err);
      // Keep whatever we already had; only a cold failure blocks the app.
      if (!hasLoadedRef.current) setLoadError(true);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [user, organizationId]);

  // Reload on workspace switch — entities are per-tenant.
  useEffect(() => {
    hasLoadedRef.current = false;
    setIsLoading(true);
    load();
  }, [load]);

  const setActiveEntity = useCallback(
    (id: string) => {
      if (id === selectedId) {
        setSwitcherOpen(false);
        return;
      }
      setSelectedId(id);
      api.setAccountingEntityId(id);
      setSwitcherOpen(false);
      if (organizationId) {
        AsyncStorage.setItem(entityStorageKey(organizationId), id).catch((err) => {
          console.error('Failed to persist selected administration:', err);
        });
      }
    },
    [organizationId, selectedId],
  );

  const openSwitcher = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSwitcherOpen(true);
  }, []);

  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);

  const value = useMemo<AccountingEntityContextValue>(() => {
    const activeEntity = resolveActiveEntity(entities, selectedId);
    const switchable = entities.filter((entity) => entity.isActive !== false);
    return {
      entities: switchable,
      activeEntity,
      hasEntity: switchable.length > 0,
      canSwitch: switchable.length > 1,
      setActiveEntity,
      openSwitcher,
      closeSwitcher,
      switcherOpen,
      isLoading,
      loadError,
      isRefreshing,
      refresh: load,
    };
  }, [entities, selectedId, setActiveEntity, openSwitcher, closeSwitcher, switcherOpen, isLoading, loadError, isRefreshing, load]);

  return (
    <AccountingEntityContext.Provider value={value}>{children}</AccountingEntityContext.Provider>
  );
}

export function useAccountingEntity(): AccountingEntityContextValue {
  const context = useContext(AccountingEntityContext);
  if (!context) {
    throw new Error('useAccountingEntity must be used within an AccountingEntityProvider');
  }
  return context;
}
