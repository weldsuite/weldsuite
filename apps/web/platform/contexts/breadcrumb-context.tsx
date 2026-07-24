
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

export interface BreadcrumbSegment {
  label: string;
  href?: string;
}

interface BreadcrumbContextValue {
  breadcrumbs: BreadcrumbSegment[];
  setBreadcrumbs: (segments: BreadcrumbSegment[]) => void;
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
    <BreadcrumbContext.Provider value={{ breadcrumbs, setBreadcrumbs }}>
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
export function useBreadcrumbs(segments: BreadcrumbSegment[]) {
  const { setBreadcrumbs } = useBreadcrumbContext();
  const segmentsKey = JSON.stringify(segments);

  useEffect(() => {
    setBreadcrumbs(segments);
    // Keyed by content (segmentsKey), not array reference — callers routinely
    // pass a fresh inline array each render, so depending on `segments`
    // directly would re-run this effect (and re-render the header) every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setBreadcrumbs, segmentsKey]);
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
}

/**
 * Hook to get current breadcrumbs (for the header)
 */
export function useCurrentBreadcrumbs() {
  const { breadcrumbs } = useBreadcrumbContext();
  return breadcrumbs;
}
