import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { hasAppPermission } from '@weldsuite/permissions';

/** Permissions are per app; this app checks them as WeldMail. */
const APP = 'weldmail';
import { appApi } from '@/services/app-api';

interface PermissionContextValue {
  /** Effective permission strings for the active workspace (e.g. `accounts:create`). */
  permissions: string[];
  /** Workspace role name (OWNER / ADMIN / MEMBER / VIEWER / custom). */
  role: string;
  isOwner: boolean;
  /** True until the first successful resolve. `can()` fails closed while loading. */
  isLoading: boolean;
  /**
   * Permission check in WeldMail (`accounts:create` → `weldmail:accounts:create`),
   * wildcard- and deny-aware. Returns false until permissions are loaded.
   */
  can: (permission: string) => boolean;
}

const PermissionContext = createContext<PermissionContextValue | undefined>(undefined);

export function PermissionProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  // Gate the fetch on auth readiness — the app-api client throws when no Clerk
  // token is wired yet, and returns 403 ORG_REQUIRED until the session token
  // carries the active org. This provider mounts above the AuthGuard, so guard
  // both conditions and retry a few times to self-heal (same race MailContext
  // handles for the account list).
  const { user, organizationId } = useClerkAuth();

  const [permissions, setPermissions] = useState<string[]>([]);
  const [denies, setDenies] = useState<string[]>([]);
  // Per-app checks apply only once the server enforces them (log-only rollout).
  const [appEnforced, setAppEnforced] = useState(false);
  const [role, setRole] = useState('');
  const [isOwner, setIsOwner] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const initializedRef = useRef(false);
  const prevOrgIdRef = useRef<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const retryCountRef = useRef(0);
  const MAX_INIT_RETRIES = 5;

  const fetchPermissions = useCallback(async () => {
    try {
      const { data } = await appApi.me.permissions();
      initializedRef.current = true;
      retryCountRef.current = 0;
      setPermissions(data.permissions ?? []);
      setDenies(data.denies ?? []);
      setAppEnforced(!!data.appEnforced);
      setRole(data.role ?? '');
      setIsOwner(!!data.isOwner);
      setIsLoading(false);
    } catch (err) {
      initializedRef.current = false;
      console.error('Failed to fetch permissions:', err);
      if (retryCountRef.current < MAX_INIT_RETRIES) {
        retryCountRef.current += 1;
        setTimeout(() => setRetryTick((t) => t + 1), 600);
      } else {
        // Out of retries — stop showing a loading state. `can()` stays
        // fail-closed (empty permissions), so gated UI simply stays hidden.
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!user || !organizationId) return;

    // Re-resolve from scratch when the active workspace changes.
    if (prevOrgIdRef.current && prevOrgIdRef.current !== organizationId) {
      initializedRef.current = false;
      retryCountRef.current = 0;
      setPermissions([]);
      setDenies([]);
      setRole('');
      setIsOwner(false);
      setIsLoading(true);
    }
    prevOrgIdRef.current = organizationId;

    if (initializedRef.current) return;
    fetchPermissions();
  }, [user, organizationId, retryTick, fetchPermissions]);

  const can = useCallback(
    (permission: string) => {
      if (isLoading) return false;
      return hasAppPermission({ permissions, denies }, permission, appEnforced ? APP : null);
    },
    [isLoading, permissions, denies, appEnforced],
  );

  return (
    <PermissionContext.Provider value={{ permissions, role, isOwner, isLoading, can }}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermissions(): PermissionContextValue {
  const ctx = useContext(PermissionContext);
  if (!ctx) {
    throw new Error('usePermissions must be used within a PermissionProvider');
  }
  return ctx;
}
