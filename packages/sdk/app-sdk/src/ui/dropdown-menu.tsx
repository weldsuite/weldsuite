import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

type Align = 'start' | 'center' | 'end';

interface DropdownContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  menuId: string;
}

const DropdownContext = createContext<DropdownContextValue | null>(null);

function useDropdownContext(component: string) {
  const ctx = useContext(DropdownContext);
  if (!ctx) throw new Error(`${component} must be used within DropdownMenu`);
  return ctx;
}

function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref && typeof ref === 'object') (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

function composeHandlers<E>(
  theirs?: (e: E) => void,
  ours?: (e: E) => void,
) {
  return (e: E) => {
    theirs?.(e);
    ours?.(e);
  };
}

export interface DropdownMenuProps {
  children: ReactNode;
}

/** Lightweight dropdown menu (MIT, no Radix). */
export function DropdownMenu({ children }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuId = useId();

  return (
    <DropdownContext.Provider value={{ open, setOpen, triggerRef, menuId }}>
      {children}
    </DropdownContext.Provider>
  );
}

export interface DropdownMenuTriggerProps {
  asChild?: boolean;
  children: ReactNode;
  onClick?: (e: MouseEvent) => void;
}

export function DropdownMenuTrigger({ asChild, children, onClick }: DropdownMenuTriggerProps) {
  const { open, setOpen, triggerRef, menuId } = useDropdownContext('DropdownMenuTrigger');

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    onClick?.(e);
    setOpen(!open);
  };

  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{
      ref?: React.Ref<HTMLElement>;
      type?: string;
      onClick?: (e: MouseEvent) => void;
    }>;
    return cloneElement(child, {
      ref: mergeRefs(child.props.ref, triggerRef),
      ...(child.type === 'button' ? { type: child.props.type ?? 'button' } : {}),
      'aria-expanded': open,
      'aria-haspopup': 'menu',
      'aria-controls': menuId,
      onClick: composeHandlers(child.props.onClick, handleClick),
    } as Record<string, unknown>);
  }

  return (
    <button
      type="button"
      ref={triggerRef as React.RefObject<HTMLButtonElement>}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-controls={menuId}
      onClick={handleClick}
      className="wui-dropdown-trigger"
    >
      {children}
    </button>
  );
}

export interface DropdownMenuContentProps extends HTMLAttributes<HTMLDivElement> {
  align?: Align;
}

export function DropdownMenuContent({
  align = 'start',
  className,
  children,
  ...props
}: DropdownMenuContentProps) {
  const { open, setOpen, triggerRef, menuId } = useDropdownContext('DropdownMenuContent');
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (!trigger || !content) return;

    const tr = trigger.getBoundingClientRect();
    const cr = content.getBoundingClientRect();
    const gap = 4;
    let left = tr.left;
    if (align === 'center') left = tr.left + tr.width / 2 - cr.width / 2;
    if (align === 'end') left = tr.right - cr.width;

    const top = tr.bottom + gap + window.scrollY;
    left += window.scrollX;

    const maxLeft = window.scrollX + window.innerWidth - cr.width - 8;
    left = Math.max(window.scrollX + 8, Math.min(left, maxLeft));

    setPosition({ top, left });
  }, [align, triggerRef]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition, children]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (contentRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, setOpen, triggerRef, updatePosition]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={contentRef}
      id={menuId}
      role="menu"
      data-state={open ? 'open' : 'closed'}
      className={cn('wui-dropdown-content', `wui-dropdown-content--align-${align}`, className)}
      style={{ position: 'absolute', top: position.top, left: position.left, zIndex: 50 }}
      onClick={(e) => e.stopPropagation()}
      {...props}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface DropdownMenuItemProps extends HTMLAttributes<HTMLButtonElement> {}

export function DropdownMenuItem({ className, onClick, children, ...props }: DropdownMenuItemProps) {
  const { setOpen } = useDropdownContext('DropdownMenuItem');

  return (
    <button
      type="button"
      role="menuitem"
      className={cn('wui-dropdown-item', className)}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) setOpen(false);
      }}
      {...props}
    >
      {children}
    </button>
  );
}

export function DropdownMenuSeparator({ className, ...props }: HTMLAttributes<HTMLHRElement>) {
  return <hr className={cn('wui-dropdown-separator', className)} role="separator" {...props} />;
}
