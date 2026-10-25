import { toast } from 'sonner';
import { isCollapsed } from '@weldsuite/docs-engine';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { MOD_LABEL } from './model/keyboard';
import { tableContext } from './model/table-actions';
import { TableMenuItems } from './table-menu';

/**
 * The right-click menu on a page: clipboard, link, and the table commands
 * when the caret is in a table. Opened at the pointer by the page view.
 */
export function DocContextMenu({ controller, at, onClose }: { controller: DocController; at: { x: number; y: number }; onClose: () => void }) {
  const { t } = useI18n();
  const tm = t.welddocs.menu;
  const te = t.welddocs.editor;
  const ro = controller.readOnly;
  const hasSelection = !isCollapsed(controller.selection);

  const clipboard = async (kind: 'cut' | 'copy' | 'paste') => {
    try {
      if (kind === 'paste') {
        const items = await navigator.clipboard.read();
        let html = '';
        let text = '';
        for (const item of items) {
          if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
          if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        }
        controller.paste({ html, text });
        return;
      }
      const payload = kind === 'cut' ? controller.cut() : controller.copy();
      if (!payload) return;
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': new Blob([payload.html], { type: 'text/html' }), 'text/plain': new Blob([payload.text], { type: 'text/plain' }) }),
      ]);
    } catch {
      toast.error(kind === 'paste' ? te.pasteFailed : te.copyFailed);
    }
  };

  return (
    <DropdownMenu open onOpenChange={(o) => !o && onClose()} modal={false}>
      <DropdownMenuTrigger asChild>
        <span className="fixed size-0" style={{ left: at.x, top: at.y }} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem disabled={ro || !hasSelection} onSelect={() => void clipboard('cut')}>
          {tm.cut}
          <DropdownMenuShortcut>{MOD_LABEL}+X</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hasSelection} onSelect={() => void clipboard('copy')}>
          {tm.copy}
          <DropdownMenuShortcut>{MOD_LABEL}+C</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={ro} onSelect={() => void clipboard('paste')}>
          {tm.paste}
          <DropdownMenuShortcut>{MOD_LABEL}+V</DropdownMenuShortcut>
        </DropdownMenuItem>
        {!ro && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => controller.openDialog('link')}>
              {controller.link() ? te.editLink : tm.link}
              <DropdownMenuShortcut>{MOD_LABEL}+K</DropdownMenuShortcut>
            </DropdownMenuItem>
            {controller.link() && <DropdownMenuItem onSelect={() => controller.removeLink()}>{te.removeLink}</DropdownMenuItem>}
          </>
        )}
        {tableContext(controller) && !ro && (
          <>
            <DropdownMenuSeparator />
            <TableMenuItems controller={controller} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
