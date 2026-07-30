import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, AppWindow } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { getDesktop } from '@/lib/desktop';
import { getTranslations } from '@/lib/i18n';
import type { DesktopSource } from '@/types/weldsuite-desktop';

/** Screen source ids look like `screen:0:0`; windows are `window:1234:0`. */
function isScreen(source: DesktopSource): boolean {
  return source.id.startsWith('screen:');
}

interface PendingRequest {
  sources: DesktopSource[];
  resolve: (sourceId: string | null) => void;
}

/**
 * Screen-share source picker for the Electron shell.
 *
 * The desktop app can't show this itself — Electron gives no built-in picker
 * on Windows/X11 — so it hands us the capturable sources and waits for a
 * choice. Registering this handler is also what tells the shell screen sharing
 * is allowed at all: with no picker mounted it denies every request rather
 * than silently capturing the primary display.
 *
 * Renders nothing outside the desktop shell, and nothing until a request
 * arrives, so it is safe to mount unconditionally at the root.
 */
export function DesktopSourcePicker() {
  const t = getTranslations('common').desktop.sourcePicker;
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'screens' | 'windows'>('screens');

  // The live request, for the unmount path. Kept in a ref so the registration
  // effect doesn't need `pending` as a dependency — re-running it would
  // deregister and re-register the picker on every open.
  const pendingRef = useRef<PendingRequest | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;

    const unsubscribe = desktop.onSelectSource(
      (sources) =>
        new Promise<string | null>((resolve) => {
          // A fresh request while one is still open replaces it, so cancel the
          // old one rather than leaving the shell to wait out its timeout.
          pendingRef.current?.resolve(null);

          // Open on whichever tab has something in it — one display and no
          // other apps open shouldn't land the user on an empty tab.
          const firstScreen = sources.find(isScreen);
          setPending({ sources, resolve });
          setTab(firstScreen ? 'screens' : 'windows');
          setSelectedId((firstScreen ?? sources[0])?.id ?? null);
        }),
    );

    return () => {
      unsubscribe();
      // Never leave the shell waiting on a dialog that no longer exists.
      pendingRef.current?.resolve(null);
    };
  }, []);

  const settle = useCallback((sourceId: string | null) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    setSelectedId(null);
    current?.resolve(sourceId);
  }, []);

  const { screens, windows } = useMemo(() => {
    const all = pending?.sources ?? [];
    return {
      screens: all.filter(isScreen),
      windows: all.filter((s) => !isScreen(s)),
    };
  }, [pending]);

  if (!pending) return null;

  // Move the selection with the tab, so Share always refers to something the
  // user can actually see highlighted.
  const selectTab = (next: 'screens' | 'windows') => {
    setTab(next);
    setSelectedId((next === 'screens' ? screens : windows)[0]?.id ?? null);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Esc, overlay click, and the × all land here. Closing is cancelling.
        if (!open) settle(null);
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => selectTab(v as 'screens' | 'windows')}>
          <TabsList>
            <TabsTrigger value="screens" disabled={screens.length === 0}>
              <Monitor className="mr-2 h-4 w-4" />
              {t.screens}
            </TabsTrigger>
            <TabsTrigger value="windows" disabled={windows.length === 0}>
              <AppWindow className="mr-2 h-4 w-4" />
              {t.windows}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="screens">
            <SourceGrid sources={screens} selectedId={selectedId} onSelect={setSelectedId} onConfirm={settle} emptyLabel={t.noScreens} />
          </TabsContent>
          <TabsContent value="windows">
            <SourceGrid sources={windows} selectedId={selectedId} onSelect={setSelectedId} onConfirm={settle} emptyLabel={t.noWindows} />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => settle(null)}>
            {t.cancel}
          </Button>
          <Button disabled={!selectedId} onClick={() => selectedId && settle(selectedId)}>
            {t.share}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SourceGrid({
  sources,
  selectedId,
  onSelect,
  onConfirm,
  emptyLabel,
}: {
  sources: DesktopSource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onConfirm: (id: string) => void;
  emptyLabel: string;
}) {
  if (sources.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="grid max-h-[46vh] grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-3">
      {sources.map((source) => {
        const selected = source.id === selectedId;
        return (
          <button
            key={source.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(source.id)}
            onDoubleClick={() => onConfirm(source.id)}
            className={`group flex flex-col overflow-hidden rounded-lg border text-left transition-colors ${
              selected ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/50'
            }`}
          >
            <img
              src={source.thumbnailDataUrl}
              alt=""
              className="aspect-video w-full bg-muted object-contain"
            />
            <span className="flex items-center gap-2 px-2.5 py-2">
              {source.appIconDataUrl && (
                <img src={source.appIconDataUrl} alt="" className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate text-xs font-medium" title={source.name}>
                {source.name}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
