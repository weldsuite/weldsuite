import { useState } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { consumeSkipNextEntitySheetAnimation } from './skip-animation';
import type { EntitySheetView } from './types';

interface EntitySheetShellProps {
  title: string;
  subtitle?: string;
  /**
   * Page route for this entity. Kept on the props so callers continue to pass
   * it (renderers may surface it elsewhere, e.g. inline "View on full page"
   * links in the body) but the shell itself no longer renders a duplicate
   * navigation button — the in-place expand toggle covers the "go big" UX,
   * and Cmd-click on the originating search result already opens the page in
   * a new tab.
   */
  openHref?: string;
  view: EntitySheetView;
  onClose: () => void;
  onToggleView: () => void;
  width?: number;
  topOffset?: number;
  children: React.ReactNode;
}

/**
 * Default chrome for entity sheet renderers that don't bring their own panel layout.
 *
 * Two visual states driven by `view`:
 *  - 'default' → right-side panel (~500px), top-offset to clear the header
 *  - 'full'    → fills the content area (left module sidebar stays visible)
 *
 * Renderers that already manage their own chrome (e.g. CustomerDetailView in panel
 * mode) should NOT use this — they wire `view`/`onToggleView` directly to their
 * existing isExpanded/onToggleExpand props.
 */
function EntitySheetShell({
  title,
  subtitle,
  view,
  onClose,
  onToggleView,
  width = 500,
  topOffset = 60,
  children,
}: EntitySheetShellProps) {
  const t = useTranslations();
  const isFull = view === 'full';
  // One-shot consume — set by callers that want an instant swap (e.g. WeldChat
  // mention click while the members panel is up). Lazy useState initializer
  // ensures we read the flag exactly once on mount.
  const [skipMountAnimation] = useState(() => consumeSkipNextEntitySheetAnimation());

  return (
    <div
      className={cn(
        'fixed bg-white dark:bg-background z-50 flex flex-col border-l shadow-xl',
        'inset-0 md:inset-auto md:right-0',
        !skipMountAnimation && 'animate-in slide-in-from-right fade-in-50 duration-200',
      )}
      style={{
        top: `${topOffset}px`,
        height: `calc(100vh - ${topOffset}px)`,
        // Full mode reserves space for the workspace + module sidebars on the left
        // (matches CustomerDetailView's expanded width: 64px workspace + 16rem module).
        width: isFull ? 'calc(100% - 64px - 16rem)' : `${width}px`,
      }}
    >
      <div className="flex items-center gap-2 px-4 h-[56px] border-b border-gray-200 dark:border-border shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-foreground truncate">
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs text-gray-500 truncate">{subtitle}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onToggleView}
          title={isFull ? t('sweep.entities.collapse') : t('sweep.entities.expand')}
        >
          {isFull ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          title={t('sweep.entities.close')}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
