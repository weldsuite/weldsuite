import type { ComponentType } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { getAppIcon, getAppLogo } from '@/lib/apps/app-registry';
import { cn } from '@/lib/utils';

export type AppLogoIconComponent = ComponentType<{ className?: string }>;

const cache = new Map<string, AppLogoIconComponent>();

/**
 * Grey like the app rail's logos, in colour on what is selected (the open
 * chat's sidebar row, `data-active`; the chosen tab, `aria-selected`; the
 * checked menu option, `aria-checked`) and while the row, link, button or
 * menu option it sits in is hovered (`data-highlighted` for a menu option).
 */
const GREY_UNLESS_SELECTED = [
  'grayscale opacity-60',
  'in-data-[active=true]:grayscale-0 in-data-[active=true]:opacity-100',
  'in-aria-selected:grayscale-0 in-aria-selected:opacity-100',
  'in-aria-checked:grayscale-0 in-aria-checked:opacity-100',
  'in-data-highlighted:grayscale-0 in-data-highlighted:opacity-100',
  'in-[a:hover,button:hover,li:hover]:grayscale-0 in-[a:hover,button:hover,li:hover]:opacity-100',
].join(' ');

/** Classes for a logo that stands for the selected record (the open chat's header): always in colour. */
export const APP_LOGO_IN_COLOUR = 'grayscale-0 opacity-100';

/**
 * An icon component that draws an app's own logo (WeldBoard's, WeldCRM's, …),
 * sized like a Lucide icon and grey unless selected. Decorative: the row or
 * button around it carries the name.
 */
export function appLogoIcon(appCode: string): AppLogoIconComponent {
  const cached = cache.get(appCode);
  if (cached) return cached;
  function AppLogoIcon({ className }: Readonly<{ className?: string }>) {
    const { resolvedTheme } = useTheme();
    const src = getAppLogo(appCode, resolvedTheme === 'dark' ? 'dark' : 'light') ?? getAppIcon(appCode);
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        data-app-logo={appCode}
        className={cn('h-4 w-4 shrink-0 object-contain', GREY_UNLESS_SELECTED, className)}
      />
    );
  }
  AppLogoIcon.displayName = `AppLogoIcon(${appCode})`;
  cache.set(appCode, AppLogoIcon);
  return AppLogoIcon;
}
