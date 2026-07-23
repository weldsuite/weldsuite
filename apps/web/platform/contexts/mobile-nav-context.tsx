
import * as React from 'react';
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { MenuGroupProps, AppLogo } from '@/components/app-sidebar-layout';
import { useWeldAgentDrawerOpen } from '@/hooks/use-weldagent-drawer-open';

export interface ModuleInfo {
  name: string;
  icon: LucideIcon;
  logo?: AppLogo;
  hideIconOnMobile?: boolean;
}

export type HeaderVariant = 'default' | 'glass';

interface MobileNavStateContextType {
  isOpen: boolean;
  moduleMenuItems: MenuGroupProps[];
  moduleInfo: ModuleInfo | null;
  showWeldAgent: boolean;
  weldAgentWidth: number;
  weldAgentLastPath: string | null;
  weldAgentPrefill: string | null;
  headerVariant: HeaderVariant;
  weldAgentSkipAnimation: boolean;
}

interface MobileNavActionsContextType {
  setIsOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setModuleMenuItems: (items: MenuGroupProps[]) => void;
  setModuleInfo: (info: ModuleInfo | null) => void;
  setShowWeldAgent: (show: boolean) => void;
  toggleWeldAgent: () => void;
  setWeldAgentWidth: (width: number) => void;
  setWeldAgentLastPath: (path: string | null) => void;
  setWeldAgentPrefill: (text: string | null) => void;
  setHeaderVariant: (variant: HeaderVariant) => void;
  setWeldAgentSkipAnimation: (skip: boolean) => void;
}

// Split into two contexts to prevent unnecessary re-renders
const MobileNavStateContext = createContext<MobileNavStateContextType | null>(null);
const MobileNavActionsContext = createContext<MobileNavActionsContextType | null>(null);

const DEFAULT_WELDAGENT_WIDTH = 400;

export function MobileNavProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpenState] = useState(false);
  const [moduleMenuItems, setModuleMenuItemsState] = useState<MenuGroupProps[]>([]);
  const [moduleInfo, setModuleInfoState] = useState<ModuleInfo | null>(null);
  // Single source of truth for WeldAgent open state: a sessionStorage-backed hook with broadcast events.
  // This guarantees every consumer (provider, layouts, breadcrumb header) reads the same value
  // synchronously on mount, so the panel survives navigation with no flash or layout shift.
  const [showWeldAgent, setShowWeldAgentInternal] = useWeldAgentDrawerOpen();
  const [weldAgentWidth, setWeldAgentWidthState] = useState(DEFAULT_WELDAGENT_WIDTH);
  const [weldAgentLastPath, setWeldAgentLastPathState] = useState<string | null>(null);
  const [weldAgentPrefill, setWeldAgentPrefillState] = useState<string | null>(null);
  const [headerVariant, setHeaderVariantState] = useState<HeaderVariant>('default');
  // If we're restoring an already-open panel, suppress the slide-in animation on the very first paint
  const [weldAgentSkipAnimation, setWeldAgentSkipAnimationState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return window.sessionStorage.getItem('weldagent-open') === 'true'; } catch { return false; }
  });

  // Use refs to track if values actually changed to prevent unnecessary updates
  const menuItemsRef = useRef<MenuGroupProps[]>([]);

  const setIsOpen = useCallback((open: boolean) => {
    setIsOpenState(open);
  }, []);

  const toggleOpen = useCallback(() => {
    setIsOpenState((prev) => !prev);
  }, []);

  const setModuleMenuItems = useCallback((items: MenuGroupProps[]) => {
    // Compare by checking length, group names, and item counts in each group
    const current = menuItemsRef.current;
    const hasChanged =
      current.length !== items.length ||
      items.some((group, i) =>
        current[i]?.group !== group.group ||
        current[i]?.items?.length !== group.items?.length
      );

    if (hasChanged) {
      menuItemsRef.current = items;
      setModuleMenuItemsState(items);
    }
  }, []);

  const setModuleInfo = useCallback((info: ModuleInfo | null) => {
    setModuleInfoState((prev) => {
      if (prev?.name === info?.name) return prev;
      return info;
    });
  }, []);

  // Latest open state, kept in a ref so toggle can read it without depending on a stale closure
  const showWeldAgentRef = useRef(showWeldAgent);
  useEffect(() => { showWeldAgentRef.current = showWeldAgent; }, [showWeldAgent]);

  const setShowWeldAgent = useCallback((show: boolean) => {
    setShowWeldAgentInternal(show);
    if (show) {
      window.dispatchEvent(new CustomEvent('close-detail-panels'));
    }
  }, [setShowWeldAgentInternal]);

  const toggleWeldAgent = useCallback(() => {
    const next = !showWeldAgentRef.current;
    setShowWeldAgentInternal(next);
    if (next) {
      window.dispatchEvent(new CustomEvent('close-detail-panels'));
    }
  }, [setShowWeldAgentInternal]);

  // After the initial render, clear the restored skip-animation flag so future open/close uses the normal animation
  useEffect(() => {
    if (weldAgentSkipAnimation) {
      const id = requestAnimationFrame(() => setWeldAgentSkipAnimationState(false));
      return () => cancelAnimationFrame(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close WeldAgent when a detail panel requests it
  useEffect(() => {
    const handler = () => setShowWeldAgentInternal(false);
    window.addEventListener('close-weldagent', handler);
    return () => window.removeEventListener('close-weldagent', handler);
  }, [setShowWeldAgentInternal]);

  const setWeldAgentWidth = useCallback((width: number) => {
    setWeldAgentWidthState(width);
  }, []);

  const setWeldAgentLastPath = useCallback((path: string | null) => {
    setWeldAgentLastPathState(path);
  }, []);

  const setWeldAgentPrefill = useCallback((text: string | null) => {
    setWeldAgentPrefillState(text);
  }, []);

  const setHeaderVariant = useCallback((variant: HeaderVariant) => {
    setHeaderVariantState(variant);
  }, []);

  const setWeldAgentSkipAnimation = useCallback((skip: boolean) => {
    setWeldAgentSkipAnimationState(skip);
  }, []);

  const stateValue = React.useMemo(
    () => ({ isOpen, moduleMenuItems, moduleInfo, showWeldAgent, weldAgentWidth, weldAgentLastPath, weldAgentPrefill, headerVariant, weldAgentSkipAnimation }),
    [isOpen, moduleMenuItems, moduleInfo, showWeldAgent, weldAgentWidth, weldAgentLastPath, weldAgentPrefill, headerVariant, weldAgentSkipAnimation]
  );

  const actionsValue = React.useMemo(
    () => ({ setIsOpen, toggleOpen, setModuleMenuItems, setModuleInfo, setShowWeldAgent, toggleWeldAgent, setWeldAgentWidth, setWeldAgentLastPath, setWeldAgentPrefill, setHeaderVariant, setWeldAgentSkipAnimation }),
    [setIsOpen, toggleOpen, setModuleMenuItems, setModuleInfo, setShowWeldAgent, toggleWeldAgent, setWeldAgentWidth, setWeldAgentLastPath, setWeldAgentPrefill, setHeaderVariant, setWeldAgentSkipAnimation]
  );

  return (
    <MobileNavActionsContext.Provider value={actionsValue}>
      <MobileNavStateContext.Provider value={stateValue}>
        {children}
      </MobileNavStateContext.Provider>
    </MobileNavActionsContext.Provider>
  );
}

export function useMobileNav() {
  const state = useContext(MobileNavStateContext);
  const actions = useContext(MobileNavActionsContext);
  if (!state || !actions) {
    throw new Error('useMobileNav must be used within a MobileNavProvider');
  }
  return { ...state, ...actions };
}

export function useMobileNavOptional() {
  const state = useContext(MobileNavStateContext);
  const actions = useContext(MobileNavActionsContext);
  if (!state || !actions) return null;
  return { ...state, ...actions };
}

// Separate hooks for when you only need state or actions
function useMobileNavState() {
  const state = useContext(MobileNavStateContext);
  if (!state) {
    throw new Error('useMobileNavState must be used within a MobileNavProvider');
  }
  return state;
}

export function useMobileNavActions() {
  const actions = useContext(MobileNavActionsContext);
  if (!actions) {
    throw new Error('useMobileNavActions must be used within a MobileNavProvider');
  }
  return actions;
}
