/**
 * Tiny wrapper around `lucide-react/dynamic` that accepts either kebab-case
 * (`shopping-cart`) or PascalCase (`ShoppingCart`) icon names. Using this
 * lets the bundler ship icons one chunk at a time instead of pulling the
 * full ~1500-icon set whenever someone does `import * as LucideIcons`.
 */
import type { ReactNode } from 'react';
import { DynamicIcon as LucideDynamic } from 'lucide-react/dynamic';
import { Hash } from 'lucide-react';

function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

export function LucideDynamicIcon({
  name,
  className,
  size,
  fallback,
}: {
  name: string;
  className?: string;
  size?: number;
  /** Rendered for an unknown icon name. Defaults to a `Hash` icon. */
  fallback?: () => ReactNode;
}) {
  const kebab = name.includes('-') ? name : toKebab(name);
  // `name` is loosely typed here — lucide's DynamicIcon throws on unknown
  // names. We use a Hash fallback (by default) to keep the UI rendering
  // instead of surfacing a console error during sidebar resolution.
  return (
    <LucideDynamic
      name={kebab as never}
      className={className}
      size={size}
      fallback={fallback ?? (() => <Hash className={className} />)}
    />
  );
}
