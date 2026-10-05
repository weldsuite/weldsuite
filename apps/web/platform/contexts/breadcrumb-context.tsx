
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';

export interface BreadcrumbSegment {
  label: string;
  href?: string;
}

interface BreadcrumbContextValue {
  breadcrumbs: BreadcrumbSegment[];
  setBreadcrumbs: (segments: BreadcrumbSegment[]) => void;
  /** Breadcrumbs to fall back to once the page that set them unmounts. */
  defaultBreadcrumbs: BreadcrumbSegment[];
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

interface BreadcrumbProviderProps {
  children: ReactNode;
  /** Default breadcrumbs to show when no page has set them */
  defaultBreadcrumbs?: BreadcrumbSegment[];
}

export function BreadcrumbProvider({ children, defaultBreadcrumbs = [] }: BreadcrumbProviderProps) {
  const [breadcrumbs, setBreadcrumbsState] = useState<BreadcrumbSegment[]>(defaultBreadcrumbs);

  const setBreadcrumbs = useCallback((segments: BreadcrumbSegment[]) => {
    setBreadcrumbsState(segments);
  }, []);

  return (
    <BreadcrumbContext.Provider value={{ breadcrumbs, setBreadcrumbs, defaultBreadcrumbs }}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

/**
 * Hook to access breadcrumb context
 */
function useBreadcrumbContext() {
  const context = useContext(BreadcrumbContext);
  if (!context) {
    throw new Error('useBreadcrumbContext must be used within a BreadcrumbProvider');
  }
  return context;
}

/**
 * Hook to set breadcrumbs for the current page
 * Call this in your page component with the breadcrumbs you want to display
 *
 * @example
 * // In a contact detail page:
 * useBreadcrumbs([
 *   { label: 'CRM', href: '/weldcrm' },
 *   { label: 'Contacts', href: '/weldcrm/contacts' },
 *   { label: contact.name }
 * ]);
 */
export function useBreadcrumbs(
  segments: BreadcrumbSegment[],
  options?: { enabled?: boolean },
) {
  const { setBreadcrumbs, defaultBreadcrumbs } = useBreadcrumbContext();
  const enabled = options?.enabled !== false;
  const segmentsKey = JSON.stringify(segments);

  useEffect(() => {
    if (!enabled) return;
    setBreadcrumbs(segments);
    // Keyed by content (segmentsKey), not array reference — callers routinely
    // pass a fresh inline array each render, so depending on `segments`
    // directly would re-run this effect (and re-render the header) every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setBreadcrumbs, segmentsKey, enabled]);

  // Reset to the provider's default once this page unmounts — otherwise the
  // last page to call useBreadcrumbs (e.g. Sequences) keeps its breadcrumb
  // showing on every page after it, until a full reload resets the
  // provider's initial state. Separate effect with no deps on `segments` so
  // this only fires on true unmount, not on every content change.
  const defaultBreadcrumbsRef = useRef(defaultBreadcrumbs);
  defaultBreadcrumbsRef.current = defaultBreadcrumbs;
  useEffect(() => {
    if (!enabled) return;
    return () => setBreadcrumbs(defaultBreadcrumbsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setBreadcrumbs, enabled]);
}

/**
 * Non-throwing variant of {@link useBreadcrumbs}. When rendered outside a
 * `BreadcrumbProvider` (e.g. a page component reused inside an object panel),
 * it no-ops instead of throwing. Breadcrumbs are only set when a provider is
 * actually present in the tree.
 */
export function useOptionalBreadcrumbs(segments: BreadcrumbSegment[]) {
  const context = useContext(BreadcrumbContext);
  const setBreadcrumbs = context?.setBreadcrumbs;
  const segmentsKey = JSON.stringify(segments);

  useEffect(() => {
    setBreadcrumbs?.(segments);
    // Keyed by content (segmentsKey), not array reference — see useBreadcrumbs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setBreadcrumbs, segmentsKey]);

  // See useBreadcrumbs above — reset to the provider's default on unmount so
  // this page's breadcrumb doesn't stick around on whatever's shown next.
  const defaultBreadcrumbsRef = useRef(context?.defaultBreadcrumbs ?? []);
  defaultBreadcrumbsRef.current = context?.defaultBreadcrumbs ?? [];
  useEffect(() => {
    if (!setBreadcrumbs) return;
    return () => setBreadcrumbs(defaultBreadcrumbsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setBreadcrumbs]);
}

/**
 * Hook to get current breadcrumbs (for the header), or null outside a provider.
 */
export function useCurrentBreadcrumbsMaybe(): BreadcrumbSegment[] | null {
  const context = useContext(BreadcrumbContext);
  return context?.breadcrumbs ?? null;
}

/**
 * Hook to get current breadcrumbs (for the header)
 */
export function useCurrentBreadcrumbs() {
  const { breadcrumbs } = useBreadcrumbContext();
  return breadcrumbs;
}
