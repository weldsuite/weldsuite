import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog';
import { Kbd } from './kbd';

export interface KeyboardHelpShortcut {
  /** The keys of one shortcut, as written on the keycaps: `['J']`, `['Enter']`. Shown side by side. */
  keys: readonly string[];
  /** What the shortcut does. */
  label: string;
}

export interface KeyboardHelpGroup {
  title: string;
  shortcuts: readonly KeyboardHelpShortcut[];
}

export interface KeyboardHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  groups: readonly KeyboardHelpGroup[];
}

/**
 * A dialog that lists the keyboard shortcuts of the current screen, grouped.
 * Labels come from the caller (library components hold no translations).
 */
export function KeyboardHelp({ open, onOpenChange, title, description, groups }: Readonly<KeyboardHelpProps>) {
  const ids = React.useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="keyboard-help">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-4">
          {groups.map((group, index) => (
            <section key={group.title} aria-labelledby={`${ids}-${index}`} className="space-y-1.5">
              <h3 id={`${ids}-${index}`} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.title}
              </h3>
              <dl className="divide-y divide-border/60">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.label} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                    <dt>{shortcut.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <Kbd key={key} className="h-6 min-w-6 justify-center text-xs">
                          {key}
                        </Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
