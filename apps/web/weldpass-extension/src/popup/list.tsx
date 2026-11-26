/**
 * Pieces of the popup's lists, in the platform's row-list style (EntityList):
 * the section band with its count, the padded and empty states, and a
 * login's site icon tile. Shared by the logins list and the tools.
 */

import { useState, type ComponentProps, type ReactNode } from 'react';
import { ChevronLeft, CircleAlert, Globe, Info, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button, Button as UiButton } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';
import { errorMessageKey } from '../lib/errors';
import { faviconUrl, imageShape, type IconShape } from '../lib/favicon';
import { t } from '../lib/i18n';

/** The library's `Alert` with an icon per tone: a note, a warning, an error. */
export function PopupAlert({
  tone = 'info',
  children,
}: Readonly<{ tone?: 'info' | 'warning' | 'error'; children: ReactNode }>) {
  const Icon = tone === 'error' ? CircleAlert : tone === 'warning' ? TriangleAlert : Info;
  return (
    <Alert
      variant={tone === 'error' ? 'destructive' : 'default'}
      className={cn('px-3 py-2', tone === 'warning' && 'text-amber-700 dark:text-amber-400')}
    >
      <Icon />
      <AlertDescription className={cn('text-xs', tone === 'warning' && 'text-amber-700 dark:text-amber-400')}>
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** The library's ghost icon `Button`, 28px, with its label as name and tooltip. */
export function IconAction({
  label,
  className,
  children,
  ...rest
}: Readonly<Omit<ComponentProps<typeof Button>, 'aria-label' | 'title'> & { label: string }>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className={cn('size-7 text-muted-foreground hover:text-foreground', className)}
      {...rest}
    >
      {children}
    </Button>
  );
}

/**
 * A group of rows under a header band, in the platform's list style
 * (EntityList's group header): muted band, label, count badge, an optional
 * action on the right. The band sticks to the top while its rows scroll.
 */
export function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  /** Left out while the rows are still loading. */
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="sticky top-0 z-[1] flex h-8 items-center gap-2 border-b border-border/70 bg-background px-3">
        <div className="pointer-events-none absolute inset-0 bg-muted/50" />
        <h2 className="relative truncate text-xs font-medium text-muted-foreground">{title}</h2>
        {count !== undefined && (
          <span className="relative flex h-4 min-w-4 shrink-0 -translate-y-px items-center justify-center rounded-[5px] border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            <span className="translate-y-px">{count}</span>
          </span>
        )}
        {action && <div className="relative ml-auto flex items-center">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function Padded({ children }: { children: ReactNode }) {
  return <div className="px-3 py-3">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="border-b border-border/70 px-3 py-3 text-xs text-muted-foreground">{children}</p>;
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-3">
      <PopupAlert tone="error">{t(errorMessageKey(error))}</PopupAlert>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

/**
 * The site's icon in a small tile, from the browser's favicon cache (no
 * network request), always 32px:
 *
 * - An app-icon style favicon (a full square: LinkedIn, Cloudflare) is the
 *   tile, filling it edge to edge, with a hairline so a white one still has
 *   an edge.
 * - A full circle in its own colour (Vercel) fills it as a circle.
 * - A mark on a transparent or white background (Google, Figma) sits centred
 *   in a bordered tile.
 * - A login without a web address, or an icon that won't load, shows a globe.
 *
 * Decorative: the title next to it names the login.
 */
export function SiteIcon({ url }: Readonly<{ url: string | null }>) {
  const src = faviconUrl(url);
  const [failed, setFailed] = useState<string | null>(null);
  /** The shape of the icon shown, once it has loaded. */
  const [measured, setMeasured] = useState<{ src: string; shape: IconShape } | null>(null);
  const showing = src && failed !== src ? src : null;
  const shape: IconShape = showing && measured?.src === showing ? measured.shape : 'glyph';
  const full = shape !== 'glyph';

  return (
    <span
      aria-hidden
      className={cn(
        'relative flex size-8 shrink-0 items-center justify-center overflow-hidden',
        shape === 'round' ? 'rounded-full' : 'rounded-[10px]',
        shape === 'square' &&
          'after:pointer-events-none after:absolute after:inset-0 after:rounded-[10px] after:ring-1 after:ring-inset after:ring-black/10 dark:after:ring-white/15',
        shape === 'glyph' && 'border bg-card',
      )}
    >
      {showing ? (
        <img
          src={showing}
          alt=""
          width={32}
          height={32}
          decoding="async"
          className={full ? 'size-full object-cover' : 'size-5'}
          onLoad={(event) => setMeasured({ src: showing, shape: imageShape(event.currentTarget) })}
          onError={() => setFailed(showing)}
        />
      ) : (
        <Globe className="size-[18px] text-muted-foreground" />
      )}
    </span>
  );
}

/**
 * The header of every page but Logins (the home page): a chevron back, the
 * page's name, an optional count (as the section bands show it) and action.
 */
export function PageHeader({
  title,
  backLabel,
  onBack,
  count,
  action,
}: Readonly<{ title: string; backLabel: string; onBack: () => void; count?: number; action?: ReactNode }>) {
  return (
    <div className="flex h-10 items-center gap-1 border-b px-1.5">
      <UiButton
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={backLabel}
        title={backLabel}
        onClick={onBack}
      >
        <ChevronLeft className="size-4" />
      </UiButton>
      <h2 className="truncate text-sm font-medium">{title}</h2>
      {count !== undefined && count > 0 && (
        <span className="flex h-4 min-w-4 shrink-0 -translate-y-px items-center justify-center rounded-[5px] border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
          <span className="translate-y-px">{count}</span>
        </span>
      )}
      {action && <div className="ml-auto flex items-center pr-1.5">{action}</div>}
    </div>
  );
}
