import type { ReactNode } from 'react';
import { Signature } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { safeLogoUrl } from '@/lib/brand';
import { LOCALES, type Locale } from '@/lib/i18n';
import { usePortal } from './portal-context';

const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', nl: 'Nederlands' };

interface PortalFrameProps {
  brand: { name: string; logoUrl: string | null } | null;
  onLocaleChange: (locale: Locale) => void;
  /** Extra controls on the right of the header (the options menu while signing). */
  actions?: ReactNode;
  /** Leave room for the sticky action bar at the bottom. */
  hasBottomBar?: boolean;
  children: ReactNode;
}

/** Page chrome: workspace branding, language switch, a footer line. */
export function PortalFrame({ brand, onLocaleChange, actions, hasBottomBar, children }: Readonly<PortalFrameProps>) {
  const { t, locale } = usePortal();
  const logo = safeLogoUrl(brand?.logoUrl);
  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-3 sm:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {logo ? (
              <img src={logo} alt="" className="max-h-8 max-w-[7rem] shrink-0 object-contain" />
            ) : (
              <Signature className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            {brand ? <span className="truncate text-sm font-semibold">{brand.name}</span> : null}
          </div>
          <div role="group" aria-label={t.language} className="flex shrink-0 overflow-hidden rounded-md border text-xs font-medium">
            {LOCALES.map((code) => (
              <button
                key={code}
                type="button"
                lang={code}
                aria-pressed={locale === code}
                aria-label={LANGUAGE_NAMES[code]}
                onClick={() => onLocaleChange(code)}
                className={cn(
                  'px-2.5 py-1.5 uppercase focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                  locale === code ? 'bg-foreground text-background' : 'bg-background text-muted-foreground hover:bg-muted',
                )}
              >
                {code}
              </button>
            ))}
          </div>
          {actions}
        </div>
      </header>
      <div className={cn('flex flex-1 flex-col', hasBottomBar && 'pb-32 sm:pb-24')}>{children}</div>
      <footer className={cn('px-4 py-4 text-center text-xs text-muted-foreground', hasBottomBar && 'pb-36 sm:pb-28')}>{t.poweredBy}</footer>
    </div>
  );
}
