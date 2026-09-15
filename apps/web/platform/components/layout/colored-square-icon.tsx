import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Colored squircle used for project / list icons in sidebars.
 *
 * Glyphs used to render at 10px inside an 18px square (`h-2.5` / `w-[18px]`),
 * which made Lucide strokes look like tiny blobs (or nearly blank) next to
 * the 16px outline icons in GENERAL. Keep the square compact but size the
 * glyph so it fills most of the tile.
 */
export function ColoredSquareIcon({
  icon: Icon,
  color,
  className,
}: {
  icon: LucideIcon;
  color?: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-center size-5 rounded-md shrink-0',
        color || 'bg-gray-500',
        className,
      )}
    >
      <Icon className="size-3.5 text-white" strokeWidth={2.25} aria-hidden />
    </div>
  );
}
