import * as React from 'react';

import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { cn } from '@weldsuite/ui/lib/utils';

/** A faux, read-only form field that displays a label + a "filled" value. */
export function FormField({
  label,
  value,
  placeholder,
}: {
  label: string;
  value?: React.ReactNode;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div
        className={cn(
          'flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm',
          value === undefined && 'text-muted-foreground',
        )}
      >
        {value ?? placeholder}
      </div>
    </label>
  );
}

/** A label / value row for detail panels and info cards. */
export function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

/** A round initials avatar with an optional adjacent name. */
export function PersonChip({
  initials,
  name,
  subtitle,
  size = 'sm',
}: {
  initials: string;
  name?: string;
  subtitle?: string;
  size?: 'sm' | 'lg';
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar className={size === 'lg' ? 'h-10 w-10' : 'h-7 w-7'}>
        <AvatarFallback className={size === 'lg' ? 'text-sm' : 'text-xs'}>
          {initials}
        </AvatarFallback>
      </Avatar>
      {name ? (
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{name}</div>
          {subtitle ? (
            <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Simple vertical activity timeline. */
export function ActivityTimeline({
  items,
}: {
  items: { id: string; title: string; body: string; author: string; when: string }[];
}) {
  return (
    <ol className="relative space-y-5 border-l border-border pl-5">
      {items.map((item) => (
        <li key={item.id} className="relative">
          <span className="absolute -left-[23px] top-1 h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-background" />
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium text-foreground">{item.title}</p>
            <span className="flex-shrink-0 text-xs text-muted-foreground">{item.when}</span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{item.body}</p>
          <p className="mt-0.5 text-xs text-muted-foreground/70">{item.author}</p>
        </li>
      ))}
    </ol>
  );
}

/** Formats an ISO date as a short, locale-stable label. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
