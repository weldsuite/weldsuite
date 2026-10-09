/**
 * Tiny wrapper around `lucide-react/dynamic` that accepts either kebab-case
 * (`shopping-cart`) or PascalCase (`ShoppingCart`) icon names. Using this
 * lets the bundler ship icons one chunk at a time instead of pulling the
 * full ~1500-icon set whenever someone does `import * as LucideIcons`.
 */
import { DynamicIcon as LucideDynamic } from 'lucide-react/dynamic';
import dynamicIconImports from 'lucide-react/dynamicIconImports';
import { Hash } from 'lucide-react';

function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/(?<![A-Z])([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

export interface LucideDynamicIconProps {
  name: string;
  className?: string;
  size?: number;
}

export function LucideDynamicIcon({ name, className, size }: Readonly<LucideDynamicIconProps>) {
  const kebab = name.includes('-') ? name : toKebab(name);
  // lucide's DynamicIcon logs an error for an unknown name, so an unknown name
  // never reaches it: a Hash icon renders instead.
  if (!Object.hasOwn(dynamicIconImports, kebab)) return <Hash className={className} />;
  return <LucideDynamic name={kebab as never} className={className} size={size} />;
}
