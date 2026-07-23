/**
 * @weldsuite/permissions — PermissionFormProvider
 *
 * Wraps a form subtree, computes `canEdit` once based on the given
 * permission(s), and (by default) renders a `<fieldset disabled={!canEdit}>`
 * so all native form controls inside are auto-disabled. A context is also
 * exposed so non-native children (e.g. a custom Save button that wants to
 * render a tooltip) can react to the edit state.
 *
 * @example
 * ```tsx
 * <PermissionFormProvider permission="leads:update">
 *   <form onSubmit={handleSubmit}>
 *     <Input name="title" />
 *     <Select ... />
 *     <SaveButton />
 *   </form>
 * </PermissionFormProvider>
 * ```
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { usePermissionsMaybe } from './provider';

export interface PermissionFormContextValue {
  canEdit: boolean;
  permission: string;
  isLoading: boolean;
}

const PermissionFormContext = createContext<PermissionFormContextValue | null>(null);

export interface PermissionFormProviderProps {
  /** Permission required to edit this form. */
  permission: string;
  /** Optional: extra perms that ALSO allow editing (any-of). */
  any?: string[];
  children: ReactNode;
  /** Render the wrapping fieldset or not. Default true. */
  wrapInFieldset?: boolean;
  /**
   * className passed to the fieldset. Defaults to `'contents'` so the
   * fieldset stays out of layout flow.
   */
  className?: string;
}

export function PermissionFormProvider({
  permission,
  any,
  children,
  wrapInFieldset = true,
  className,
}: PermissionFormProviderProps) {
  const ctx = usePermissionsMaybe();

  const value = useMemo<PermissionFormContextValue>(() => {
    if (!ctx) {
      return { canEdit: false, permission, isLoading: true };
    }
    if (ctx.isLoading) {
      return { canEdit: false, permission, isLoading: true };
    }
    if (ctx.isOwner) {
      return { canEdit: true, permission, isLoading: false };
    }
    const allowedByMain = ctx.can(permission);
    const allowedByAny = any && any.length > 0 ? ctx.canAny(...any) : false;
    return {
      canEdit: allowedByMain || allowedByAny,
      permission,
      isLoading: false,
    };
  }, [ctx, permission, any]);

  const content = wrapInFieldset ? (
    <fieldset disabled={!value.canEdit} className={className ?? 'contents'}>
      {children}
    </fieldset>
  ) : (
    children
  );

  return (
    <PermissionFormContext.Provider value={value}>
      {content}
    </PermissionFormContext.Provider>
  );
}

/**
 * Access the form-permission context. Throws if used outside
 * <PermissionFormProvider>. Use `useFormPermissionMaybe()` for an
 * exception-free variant.
 */
export function useFormPermission(): PermissionFormContextValue {
  const ctx = useContext(PermissionFormContext);
  if (!ctx) {
    throw new Error(
      'useFormPermission must be used within a <PermissionFormProvider>',
    );
  }
  return ctx;
}

/**
 * Like useFormPermission() but returns null when used outside the provider.
 */
export function useFormPermissionMaybe(): PermissionFormContextValue | null {
  return useContext(PermissionFormContext);
}
