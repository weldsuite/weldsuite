import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import type { Status } from './hooks';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
};

export function Button({ variant = 'secondary', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-primary text-primary-foreground hover:opacity-90',
        variant === 'secondary' && 'border bg-card hover:bg-muted',
        variant === 'ghost' && 'hover:bg-muted',
        className,
      )}
      {...rest}
    />
  );
}

/** An icon-only button. `label` is both the tooltip and the accessible name. */
export function IconButton({
  label,
  className,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cx(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground',
        'transition-colors hover:bg-muted hover:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'error';
  children: ReactNode;
}) {
  return (
    <p
      className={cx(
        'rounded-md border px-2.5 py-2 text-xs',
        tone === 'info' && 'bg-muted text-muted-foreground',
        tone === 'warning' && 'border-warning/40 bg-warning/10 text-foreground',
        tone === 'error' && 'border-destructive/40 bg-destructive/10 text-foreground',
      )}
    >
      {children}
    </p>
  );
}

export function Brand() {
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold">
      <span className="inline-flex size-5 items-center justify-center rounded bg-primary text-primary-foreground">
        <KeyRound className="size-3" aria-hidden />
      </span>
      WeldPass
    </span>
  );
}

/** A full-popup message: the signed-out, no-workspace and not-configured states. */
export function Screen({
  title,
  body,
  action,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-3 py-2.5">
        <Brand />
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-sm font-semibold">{title}</h1>
        <div className="text-muted-foreground">{body}</div>
        {action}
      </div>
    </div>
  );
}

export function StatusBar({ status }: { status: Status | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'min-h-8 border-t px-3 py-2 text-xs',
        status?.tone === 'error' ? 'text-destructive' : 'text-success',
      )}
    >
      {status?.text}
    </div>
  );
}

export { cx };
