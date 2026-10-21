import { createContext, useContext, type ComponentType } from 'react';
import type { CustomerDetailViewProps } from './types';

/**
 * CustomerDetailView, handed down by the view itself so a section can open a
 * nested detail panel (a contact inside a customer) without importing the
 * view: that import would close a cycle (view -> content -> section -> view).
 */
export const NestedDetailViewContext = createContext<ComponentType<CustomerDetailViewProps> | null>(null);

export function useNestedDetailView(): ComponentType<CustomerDetailViewProps> {
  const view = useContext(NestedDetailViewContext);
  if (!view) throw new Error('useNestedDetailView must be used inside CustomerDetailView');
  return view;
}
