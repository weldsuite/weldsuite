'use client';

import type { ComponentProps } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';
import { usePortal } from './portal-context';

/** Primary button that takes the workspace's brand colour when it has one. */
export function BrandButton({ className, style, variant, ...props }: Readonly<ComponentProps<typeof Button>>) {
  const { brandColor, brandForeground } = usePortal();
  const branded = !variant && brandColor && brandForeground;
  return (
    <Button
      variant={variant}
      className={cn(branded && 'hover:opacity-90', className)}
      style={branded ? { backgroundColor: brandColor, color: brandForeground, ...style } : style}
      {...props}
    />
  );
}
