import type { ReactNode } from 'react';

/** A label and its value, for people who may look at a setting but not change it. */
export function ReadOnlyField({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="grid gap-1 sm:grid-cols-[200px_1fr] sm:gap-4">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="min-w-0 text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}

/** A list of values as chips: domains and page patterns. */
export function ReadOnlyChips({ values, empty }: Readonly<{ values: readonly string[]; empty: string }>) {
  if (values.length === 0) return <>{empty}</>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <li key={value} className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[13px] break-all text-foreground">
          {value}
        </li>
      ))}
    </ul>
  );
}
