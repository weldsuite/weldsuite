import * as React from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { Button, buttonVariants } from '@weldsuite/ui/components/button';
import { InlineTextEditor } from '@weldsuite/ui/components/inline-text-editor';
import { useUiLabels } from '@weldsuite/ui/providers/ui-labels-provider';

/**
 * The page of a recording: a WeldMeet meeting, a WeldCRM call, a WeldPanel
 * session replay. One shared shell, so these pages always look the same:
 *
 *   ┌ RecordingHeader ─ back · title (renamed in place) ……… actions ┐
 *   │ the player, full width                                        │ sidebar
 *   │ RecordingTabStrip ─ icon tabs (sticky) …………………… tab tools  │ (optional)
 *   │ RecordingTabPanel                                             │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * The page puts its player and tab panels in `children`; the body scrolls and
 * the tab strip sticks to its top.
 */
function RecordingLayout({
  header,
  sidebar,
  className,
  children,
}: Readonly<{
  header: React.ReactNode;
  /** A column on the right (details, a chat), 400px like the WeldAgent panel; full height, beside the header too. */
  sidebar?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}>) {
  return (
    <div data-slot="recording-layout" className={cn('flex h-full overflow-hidden bg-gray-50 dark:bg-background', className)}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {header}
        <div className="flex flex-1 overflow-hidden">
          <div
            data-slot="recording-body"
            className="min-w-0 flex-1 overflow-y-auto bg-white [-ms-overflow-style:none] [scrollbar-width:none] dark:bg-background [&::-webkit-scrollbar]:hidden"
          >
            {children}
          </div>
        </div>
      </div>
      {sidebar ? (
        // 400px: as wide as the WeldAgent panel.
        <aside className="flex w-[400px] flex-shrink-0 flex-col border-l bg-white duration-200 animate-in fade-in-50 slide-in-from-right dark:bg-background">
          {sidebar}
        </aside>
      ) : null}
    </div>
  );
}

/**
 * The 53px header bar, as every editor and detail page has it (WeldSign,
 * WeldForms, WeldDocs): a ghost chevron back button, the title (renamed in
 * place when `onRename` is given), a muted note after it, and the actions on
 * the right.
 */
function RecordingHeader({
  title,
  subtitle,
  icon,
  onBack,
  backLabel,
  onRename,
  titleLabel,
  actions,
}: Readonly<{
  title: string;
  /** A short muted note after the title, such as when it was recorded. */
  subtitle?: React.ReactNode;
  /** A tile between the back button and the title, such as a meeting's platform logo. */
  icon?: React.ReactNode;
  onBack?: () => void;
  /** Accessible name of the back button; the library's "Back" label by default. */
  backLabel?: string;
  /** Saves a new title; without it the title is plain text. */
  onRename?: (next: string) => void;
  /** Accessible name of the title while it is edited ("Meeting title"). */
  titleLabel?: string;
  /** Header buttons and menus, laid out 4px apart. */
  actions?: React.ReactNode;
}>) {
  const labels = useUiLabels();
  const back = backLabel ?? labels.back;
  return (
    <div
      data-slot="recording-header"
      className="flex min-h-[53px] flex-shrink-0 items-center gap-1 border-b bg-white px-3 py-2 dark:bg-background"
    >
      {onBack ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label={back}
          title={back}
          className="size-[30px] flex-shrink-0 text-muted-foreground"
        >
          <ChevronLeft className="!size-[18px]" />
        </Button>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {icon ? (
          <div className="ml-1 flex h-8 w-11 flex-shrink-0 items-center justify-center rounded-lg border bg-muted">{icon}</div>
        ) : null}
        {/* Editing shows the hover's 1px border in blue instead of an added ring. The box is as wide
            as the title, so the note sits right after it; the wrapper's margin keeps the text 8px
            from the back button. */}
        <div className="-ml-[3px] flex min-w-0 max-w-md">
          {onRename ? (
            <InlineTextEditor
              value={title}
              onSave={onRename}
              label={titleLabel}
              singleLine
              className="mx-0 text-[15px] font-medium leading-6 text-foreground focus:border-primary focus:ring-0"
            />
          ) : (
            <h1 className="truncate pl-[7px] text-[15px] font-medium leading-6 text-foreground">{title}</h1>
          )}
        </div>
        {subtitle ? <span className="hidden flex-shrink-0 text-sm text-muted-foreground sm:inline">{subtitle}</span> : null}
      </div>
      {actions ? <div className="ml-auto flex flex-shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export interface RecordingTab {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}

/** The ids that tie a tab to its panel: pass the same `idPrefix` to the strip and to each panel. */
function tabId(idPrefix: string, value: string): string {
  return `${idPrefix}-tab-${value}`;
}

/**
 * The tab strip under the player: icon + label tabs with an underline on the
 * selected one, sticky at the top of the body while the tab scrolls, and the
 * selected tab's own tools (search, a filter…) on the right.
 *
 * A WAI-ARIA tablist: one tab stop, the arrow keys (and Home / End) move the
 * selection, which follows focus.
 */
function RecordingTabStrip({
  tabs,
  value,
  onValueChange,
  label,
  idPrefix,
  tools,
  separated = false,
  className,
}: Readonly<{
  tabs: readonly RecordingTab[];
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the tablist. */
  label: string;
  idPrefix: string;
  /** Tools of the selected tab, on the right of the strip. */
  tools?: React.ReactNode;
  /** A full-width line above the strip, parting it from the player over it. */
  separated?: boolean;
  className?: string;
}>) {
  const listRef = React.useRef<HTMLDivElement>(null);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const index = tabs.findIndex((tab) => tab.id === value);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === -1) return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onValueChange(tab.id);
    listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(idPrefix, tab.id))}`)?.focus();
  }

  return (
    <>
      {/* The line between the player and the tabs, right under the player (space above it is the player's own). Not part of the
          sticky strip, so it does not double the header's border once the strip sticks. */}
      {separated ? <div aria-hidden className="border-t border-gray-200 dark:border-border" /> : null}
      <div data-slot="recording-tab-strip" className={cn('sticky top-0 z-10 overflow-hidden bg-white px-4 pt-[10px] dark:bg-background', className)}>
        <div className="mb-[10px] flex items-center gap-2">
          <div ref={listRef} role="tablist" aria-label={label} className="flex items-center gap-1">
            {tabs.map((tab, index) => {
              const selected = tab.id === value;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={tabId(idPrefix, tab.id)}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onValueChange(tab.id)}
                  onKeyDown={onKeyDown}
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'sm' }),
                    // The underline is a border on a pseudo-element, so forced-colours mode keeps it.
                    'relative flex-none text-xs hover:bg-transparent md:text-sm',
                    "after:absolute after:-bottom-[11px] after:border-b-2 after:border-transparent after:content-[''] after:transition-colors",
                    index === 0 ? '!pl-0 pr-2 after:left-0 md:pr-3' : 'px-2 after:left-[6px] md:px-3 md:after:left-[10px]',
                    'after:right-[6px] md:after:right-[10px]',
                    selected
                      ? 'text-foreground after:border-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:after:border-gray-300 dark:hover:after:border-gray-600',
                  )}
                >
                  {Icon ? <Icon className="mr-0.5 h-3 w-3" /> : null}
                  {tab.label}
                </button>
              );
            })}
          </div>
          {tools ? <div className="ml-auto flex items-center gap-1.5">{tools}</div> : null}
        </div>
        <div className="-mx-4 border-b border-gray-200 dark:border-border" />
      </div>
    </>
  );
}

/** The content of one tab, named by its tab; only the selected one renders. Put padding on a child, not on the panel. */
function RecordingTabPanel({
  idPrefix,
  value,
  selected,
  children,
}: Readonly<{ idPrefix: string; value: string; selected: boolean; children: React.ReactNode }>) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${value}`} aria-labelledby={tabId(idPrefix, value)} hidden={!selected}>
      {selected ? children : null}
    </div>
  );
}

export { RecordingLayout, RecordingHeader, RecordingTabStrip, RecordingTabPanel };
