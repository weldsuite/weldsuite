import { useState } from 'react';
import { Menubar } from '@weldsuite/ui/components/menubar';
import { FileMenu } from './file-menu';
import { EditMenu } from './edit-menu';
import { ViewMenu } from './view-menu';
import { InsertMenu } from './insert-menu';
import { FormatMenu } from './format-menu';
import { HelpMenu } from './help-menu';
import type { DocCommand, DocActions } from './menu-kit';

export type { DocCommand, DocActions } from './menu-kit';

export interface PaginatedDocMenubarProps {
  /** Editor command surface (execCommand-backed). */
  cmd: DocCommand;
  /** Optional document-level callbacks (rename/delete/save-now). */
  actions?: DocActions;
  editable?: boolean;
}

/**
 * Google-Docs-style File / Edit / View / Insert / Format / Help menu bar for
 * the standalone paginated (contenteditable) editor. Every command is driven
 * through the `DocCommand` object, so this bar has no editor-engine
 * dependency of its own.
 *
 * Hover-swap is wired manually: while any menu is open, moving the pointer
 * over a different trigger switches the active menu (mirrors the legacy
 * BlockNote menubar's behaviour and works around Radix hover-swap timing).
 */
export function PaginatedDocMenubar({ cmd, actions, editable = true }: PaginatedDocMenubarProps) {
  const [value, setValue] = useState<string>('');

  return (
    <Menubar
      value={value}
      onValueChange={setValue}
      onMouseOver={(e) => {
        if (!value) return;
        const trigger = (e.target as HTMLElement | null)?.closest(
          '[data-menu-value]',
        ) as HTMLElement | null;
        if (!trigger) return;
        const next = trigger.getAttribute('data-menu-value');
        if (next && next !== value) setValue(next);
      }}
      className={
        'border-0 bg-transparent p-0 h-auto gap-0.5 ' +
        '[&_[data-slot=menubar-trigger]]:bg-transparent ' +
        '[&_[data-slot=menubar-trigger]]:hover:bg-accent ' +
        '[&_[data-slot=menubar-trigger]]:hover:text-accent-foreground ' +
        '[&_[data-slot=menubar-trigger][data-state=open]]:bg-accent ' +
        '[&_[data-slot=menubar-trigger][data-state=open]]:text-accent-foreground ' +
        '[&_[data-slot=menubar-trigger]]:rounded-md ' +
        '[&_[data-slot=menubar-trigger]]:px-2 ' +
        '[&_[data-slot=menubar-trigger]]:py-1 ' +
        '[&_[data-slot=menubar-trigger]]:h-auto ' +
        '[&_[data-slot=menubar-trigger]]:text-sm ' +
        '[&_[data-slot=menubar-trigger]]:font-medium ' +
        '[&_[data-slot=menubar-trigger]]:text-muted-foreground'
      }
    >
      <FileMenu cmd={cmd} actions={actions} menuValue="file" editable={editable} />
      <EditMenu cmd={cmd} actions={actions} menuValue="edit" editable={editable} />
      <ViewMenu cmd={cmd} actions={actions} menuValue="view" editable={editable} />
      <InsertMenu cmd={cmd} actions={actions} menuValue="insert" editable={editable} />
      <FormatMenu cmd={cmd} actions={actions} menuValue="format" editable={editable} />
      <HelpMenu cmd={cmd} actions={actions} menuValue="help" editable={editable} />
    </Menubar>
  );
}
