/**
 * Tiny wrapper around `lucide-react/dynamic` that accepts either kebab-case
 * (`shopping-cart`) or PascalCase (`ShoppingCart`) icon names. Using this
 * lets the bundler ship icons one chunk at a time instead of pulling the
 * full ~1500-icon set whenever someone does `import * as LucideIcons`.
 */
import { DynamicIcon as LucideDynamic } from 'lucide-react/dynamic';
import { Hash } from 'lucide-react';

function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

export interface LucideDynamicIconProps {
  name: string;
  className?: string;
  size?: number;
}

export function LucideDynamicIcon({ name, className, size }: LucideDynamicIconProps) {
  const kebab = name.includes('-') ? name : toKebab(name);
  // `name` is loosely typed here — lucide's DynamicIcon throws on unknown
  // names. We use a Hash fallback to keep the UI rendering instead of
  // surfacing a console error during sidebar resolution.
  return (
    <LucideDynamic
      name={kebab as never}
      className={className}
      size={size}
      fallback={() => <Hash className={className} />}
    />
  );
}
