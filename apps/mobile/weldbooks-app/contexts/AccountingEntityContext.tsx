/**
 * Accounting-entity gate.
 *
 * Every WeldBooks endpoint is entity-scoped — without a legal entity they all
 * fail with `400 No accounting entity resolved`. This mirrors the platform's
 * `AccountingLayoutClient` (PR #93): resolve the workspace's entities once, and
 * let the app shell show the setup door instead of letting each screen surface
 * its own error.
 *
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
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import api from '@/services/api';
import type { AccountingEntity } from '@/types/accounting';

interface AccountingEntityContextValue {
  entities: AccountingEntity[];
  /** The default entity, falling back to the first one. */
  activeEntity: AccountingEntity | null;
  hasEntity: boolean;
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
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const hasLoadedRef = useRef(false);

  const load = useCallback(async () => {
    if (!user || !organizationId) {
      setEntities([]);
      setIsLoading(false);
      return;
    }

    if (hasLoadedRef.current) setIsRefreshing(true);

    try {
      const rows = await api.getEntities();
      setEntities(rows);
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

  const value = useMemo<AccountingEntityContextValue>(() => {
    const activeEntity = entities.find((e) => e.isDefault) ?? entities[0] ?? null;
    return {
      entities,
      activeEntity,
      hasEntity: entities.length > 0,
      isLoading,
      loadError,
      isRefreshing,
      refresh: load,
    };
  }, [entities, isLoading, loadError, isRefreshing, load]);

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
