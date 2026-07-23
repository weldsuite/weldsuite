/**
 * @weldsuite/permissions — CanDisable component
 *
 * Wraps a single child element. If access is allowed, renders the child
 * unchanged. If denied, clones the child with `disabled: true`, wraps it in a
 * `<span>` (so the tooltip can bind to a non-disabled element), and shows a
 * tooltip explaining the missing permission on hover.
 *
 * Exactly one of `permission`, `any`, `all`, or `object` should be provided.
 *
 * @example
 * ```tsx
 * <CanDisable permission="leads:update" tooltip="Editing leads requires permission">
 *   <Button type="submit">Save</Button>
 * </CanDisable>
 * ```
 */

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cloneElement, isValidElement, type ReactElement } from 'react';
import { usePermissionsMaybe } from './provider';

export interface CanDisableProps {
  permission?: string;
  any?: string[];
  all?: string[];
  object?: string;
  /** Tooltip text when disabled. If omitted, derived from the permission. */
  tooltip?: string;
  /** When true, also passes `aria-disabled` and adds an opacity class on disable. Default true. */
  visualDisabled?: boolean;
  children: ReactElement;
}

function defaultTooltip({
  permission,
  any,
  all,
  object,
}: {
  permission?: string;
  any?: string[];
  all?: string[];
  object?: string;
}): string {
  if (permission) {
    const parts = permission.split(':');
    if (parts.length >= 2) {
      const action = parts[parts.length - 1];
      const obj = parts[parts.length - 2];
      return `You need permission to ${action} ${obj}.`;
    }
    return `You need the "${permission}" permission.`;
  }
  if (object) return `You need permission to access ${object}.`;
  if (any && any.length > 0) {
    return `You need one of: ${any.join(', ')}.`;
  }
  if (all && all.length > 0) {
    return `You need all of: ${all.join(', ')}.`;
  }
  return "You don't have permission for this action.";
}

function countDefined(...values: unknown[]): number {
  return values.reduce<number>((acc, v) => acc + (v !== undefined ? 1 : 0), 0);
}

function isDev(): boolean {
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  return proc?.env?.NODE_ENV !== 'production';
}

export function CanDisable({
  permission,
  any,
  all,
  object,
  tooltip,
  visualDisabled = true,
  children,
}: CanDisableProps): ReactElement {
  const ctx = usePermissionsMaybe();

  if (!isValidElement(children)) {
    if (isDev()) {
      // eslint-disable-next-line no-console
      console.warn('[<CanDisable>] children must be a single React element.');
    }
    return children;
  }

  // Determine allow/deny using the same logic as <Can>.
  let allowed: boolean;

  if (!ctx || ctx.isLoading) {
    allowed = false;
  } else if (ctx.isOwner) {
    allowed = true;
  } else {
    const provided = countDefined(permission, any, all, object);
    if (provided > 1) {
      if (isDev()) {
        // eslint-disable-next-line no-console
        console.warn(
          '[<CanDisable>] Exactly one of `permission`, `any`, `all`, or `object` should be provided. Treating as denied.',
        );
      }
      allowed = false;
    } else if (permission) {
      allowed = ctx.can(permission);
    } else if (any) {
      allowed = ctx.canAny(...any);
    } else if (all) {
      allowed = ctx.canAll(...all);
    } else if (object) {
      allowed = ctx.hasAnyObject([object]);
    } else {
      allowed = true;
    }
  }

  if (allowed) {
    return children;
  }

  // Denied — clone child with disabled props.
  const childProps = (children.props ?? {}) as Record<string, unknown>;
  const existingClassName =
    typeof childProps.className === 'string' ? childProps.className : '';
  const disabledClassName = visualDisabled
    ? `${existingClassName} opacity-50 cursor-not-allowed`.trim()
    : existingClassName;

  const clonedChild = cloneElement(children, {
    ...childProps,
    disabled: true,
    ...(visualDisabled ? { 'aria-disabled': true } : {}),
    ...(disabledClassName ? { className: disabledClassName } : {}),
  } as Record<string, unknown>);

  const text = tooltip ?? defaultTooltip({ permission, any, all, object });

  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          {/*
           * Wrapping span ensures hover events fire even when the inner element
           * is `disabled` (HTML disabled controls don't dispatch pointer events).
           */}
          <span
            className="inline-flex"
            // Stop click bubbling so callers can't accidentally bypass the disable.
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {clonedChild}
          </span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={4}
            className="z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md"
          >
            {text}
            <TooltipPrimitive.Arrow className="fill-foreground" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
