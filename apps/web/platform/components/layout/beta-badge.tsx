import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';

/**
 * BETA pill for an app. Which apps are Beta is set per app in the admin
 * console (app catalog → Beta) and read with `useBetaAppCodes()`.
 *
 * `corner` pins it to the top-right of a rail icon (the parent must be
 * `relative`); `inline` sits next to a title.
 */
export function BetaBadge({
  variant = 'corner',
  className,
}: Readonly<{ variant?: 'corner' | 'inline'; className?: string }>) {
  const st = useTranslations();
  return (
    <span
      className={cn(
        'text-[10px] font-mono text-white bg-black border border-black h-[16px] flex items-center justify-center rounded-[5px] px-1 pointer-events-none shrink-0',
        variant === 'corner' && 'absolute -top-1 -right-1 z-10',
        className
      )}
    >
      <span className="-translate-y-[0.5px]">{st('sweep.shared.beta')}</span>
    </span>
  );
}
