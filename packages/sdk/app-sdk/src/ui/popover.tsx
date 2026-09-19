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
  type FocusEvent,
  type HTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

type Align = 'start' | 'center' | 'end';

interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentId: string;
}

const PopoverContext = createContext<PopoverContextValue | null>(null);

function usePopoverContext(component: string) {
  const ctx = useContext(PopoverContext);
  if (!ctx) throw new Error(`${component} must be used within Popover`);
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

export interface PopoverProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

/** Lightweight anchored popover (MIT, no Radix). */
export function Popover({ open: openProp, onOpenChange, children }: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const contentId = useId();
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  return (
    <PopoverContext.Provider value={{ open, setOpen, triggerRef, contentId }}>
      {children}
    </PopoverContext.Provider>
  );
}

export interface PopoverTriggerProps {
  asChild?: boolean;
  children: ReactNode;
}

export function PopoverTrigger({ asChild, children }: PopoverTriggerProps) {
  const { open, setOpen, triggerRef, contentId } = usePopoverContext('PopoverTrigger');

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
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
      'aria-haspopup': 'dialog',
      'aria-controls': contentId,
      onClick: composeHandlers(child.props.onClick, onClick),
    } as Record<string, unknown>);
  }

  return (
    <button
      type="button"
      ref={triggerRef as React.RefObject<HTMLButtonElement>}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-controls={contentId}
      onClick={onClick}
      className="wui-popover-trigger"
    >
      {children}
    </button>
  );
}

export interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  align?: Align;
  onCloseAutoFocus?: (event: Event) => void;
}

export function PopoverContent({
  align = 'center',
  className,
  children,
  onCloseAutoFocus,
  ...props
}: PopoverContentProps) {
  const { open, setOpen, triggerRef, contentId } = usePopoverContext('PopoverContent');
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

  useEffect(() => {
    if (open) return;
    if (!onCloseAutoFocus) return;
    const id = requestAnimationFrame(() => {
      onCloseAutoFocus(new Event('closeAutoFocus'));
    });
    return () => cancelAnimationFrame(id);
  }, [open, onCloseAutoFocus]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={contentRef}
      id={contentId}
      role="dialog"
      data-state={open ? 'open' : 'closed'}
      className={cn('wui-popover-content', `wui-popover-content--align-${align}`, className)}
      style={{ position: 'absolute', top: position.top, left: position.left, zIndex: 50 }}
      onBlur={(e: FocusEvent) => {
        const next = e.relatedTarget as Node | null;
        if (next && contentRef.current?.contains(next)) return;
        if (next && triggerRef.current?.contains(next)) return;
      }}
      {...props}
    >
      {children}
    </div>,
    document.body,
  );
}
