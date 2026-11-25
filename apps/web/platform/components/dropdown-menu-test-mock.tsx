/**
 * Stand-in for `@weldsuite/ui/components/dropdown-menu` in tests that render a
 * row menu inline (see `panel-entity-list-test-mock.tsx`): every item is a
 * plain button, so a test clicks it without opening a Radix menu first.
 *
 * Not a test file itself, and nothing in the app imports it.
 */

import type { ReactNode } from 'react';

export const DropdownMenu = ({ children }: Readonly<{ children?: ReactNode }>) => <div>{children}</div>;
export const DropdownMenuTrigger = ({ children }: Readonly<{ children?: ReactNode }>) => <div>{children}</div>;
export const DropdownMenuContent = ({ children }: Readonly<{ children?: ReactNode }>) => <div>{children}</div>;
export const DropdownMenuGroup = ({ children }: Readonly<{ children?: ReactNode }>) => <div>{children}</div>;
export const DropdownMenuLabel = ({ children }: Readonly<{ children?: ReactNode }>) => <div>{children}</div>;
export const DropdownMenuSeparator = () => <hr />;
export const DropdownMenuItem = ({
  children,
  onClick,
  disabled,
}: Readonly<{ children?: ReactNode; onClick?: () => void; disabled?: boolean; variant?: string }>) => (
  <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
    {children}
  </button>
);
