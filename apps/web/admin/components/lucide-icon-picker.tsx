'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as LucideIcons from 'lucide-react';
import { Search, X, HelpCircle, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const SKIP = new Set([
  'createLucideIcon',
  'default',
  'icons',
  'Icon',
  'LucideIcon',
  'LucideProps',
  'IconNode',
  'IconNodeChild',
  'IconNodeChildren',
]);

const ICON_NAMES: string[] = Object.keys(LucideIcons)
  .filter((key) => {
    if (SKIP.has(key)) return false;
    if (!/^[A-Z]/.test(key)) return false;
    if (key.endsWith('Icon')) return false; // duplicate "*Icon" aliases
    const Comp = (LucideIcons as Record<string, unknown>)[key];
    return typeof Comp === 'object' || typeof Comp === 'function';
  })
  .sort();

export function getLucideComponent(name: string | null | undefined): LucideIcon | null {
  if (!name) return null;
  const Comp = (LucideIcons as Record<string, unknown>)[name];
  if (typeof Comp === 'function' || (typeof Comp === 'object' && Comp !== null)) {
    return Comp as LucideIcon;
  }
  return null;
}

export function LucideIconPreview({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const Comp = getLucideComponent(name);
  if (Comp) return <Comp className={className} />;
  return <HelpCircle className={cn('text-muted-foreground', className)} />;
}

export function LucideIconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ICON_NAMES.slice(0, 96);
    return ICON_NAMES.filter((n) => n.toLowerCase().includes(q)).slice(0, 200);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const Selected = getLucideComponent(value);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md border bg-background hover:bg-accent text-sm"
      >
        <span className="h-6 w-6 flex items-center justify-center rounded bg-muted">
          {Selected ? <Selected className="h-4 w-4" /> : <HelpCircle className="h-4 w-4 text-muted-foreground" />}
        </span>
        <span className="font-mono text-xs">{value || 'Pick an icon…'}</span>
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-[420px] rounded-lg border bg-popover shadow-xl p-3">
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search icons…"
              className="w-full pl-8 pr-8 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">No icons match "{query}"</div>
            ) : (
              <div className="grid grid-cols-8 gap-1">
                {filtered.map((name) => {
                  const Comp = getLucideComponent(name);
                  if (!Comp) return null;
                  const isActive = name === value;
                  return (
                    <button
                      key={name}
                      type="button"
                      title={name}
                      onClick={() => {
                        onChange(name);
                        setOpen(false);
                      }}
                      className={cn(
                        'h-10 w-10 flex items-center justify-center rounded-md transition-colors',
                        isActive ? 'bg-accent ring-2 ring-ring' : 'hover:bg-accent',
                      )}
                    >
                      <Comp className="h-5 w-5" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground border-t pt-2">
            <span>{query ? `${filtered.length} matches` : `Showing ${filtered.length} of ${ICON_NAMES.length}`}</span>
            <a
              href="https://lucide.dev/icons"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground"
            >
              Browse all
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
