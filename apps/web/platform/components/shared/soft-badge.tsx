import type { ComponentProps } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';

export type SoftTone = 'neutral' | 'success' | 'warning' | 'danger';

/**
 * A status badge in four soft tones. The library's `destructive` badge is solid
 * red, which shouts next to its soft `success` and `warning` badges; `danger`
 * here is the same soft treatment in red.
 */
export function SoftBadge({
  tone,
  className,
  ...props
}: Readonly<{ tone: SoftTone } & Omit<ComponentProps<typeof Badge>, 'variant'>>) {
  if (tone === 'danger') {
    return (
      <Badge
        variant="outline"
        className={cn('border-transparent bg-destructive/10 text-destructive', className)}
        {...props}
      />
    );
  }
  const variant = tone === 'neutral' ? 'secondary' : tone;
  return <Badge variant={variant} className={className} {...props} />;
}
