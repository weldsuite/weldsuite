import { useSyncExternalStore, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { MOD_LABEL } from './model/keyboard';
import { downloadDocument } from './download';
import { PARAGRAPH_STYLES, ZOOMS } from './toolbar';

/** File, Edit, View, Insert, Format, Tools and Help, as in Google Docs. */
export function Menubar({ controller, name, onRename }: { controller: DocController; name: string; onRename?: () => void }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const tm = t.welddocs.menu;
  const te = t.welddocs.editor;
  const ts = t.welddocs.styles;
  const tx = t.welddocs.text;
  const tt = t.welddocs.toolbar;
  const navigate = useNavigate();
  const preview = usePreviewMode();
  const ro = controller.readOnly;
  const home = preview ? '/preview/welddocs' : '/welddocs';

  const clipboard = async (kind: 'cut' | 'copy' | 'paste' | 'pastePlain') => {
    try {
      if (kind === 'paste' || kind === 'pastePlain') {
        const items = await navigator.clipboard.read();
        let html = '';
        let text = '';
        for (const item of items) {
          if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
          if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        }
        controller.paste({ html, text }, kind === 'pastePlain');
        return;
      }
      const payload = kind === 'cut' ? controller.cut() : controller.copy();
      if (!payload) return;
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': new Blob([payload.html], { type: 'text/html' }), 'text/plain': new Blob([payload.text], { type: 'text/plain' }) }),
      ]);
    } catch {
      toast.error(kind.startsWith('paste') ? te.pasteFailed : te.copyFailed);
    }
  };

  return (
    <div className="-ml-1 flex items-center text-sm" role="menubar">
      <TopMenu label={tm.file}>
        <Item onSelect={() => navigate({ to: home }).catch(() => undefined)}>{tm.openHome}</Item>
        {onRename && !ro && <Item onSelect={onRename}>{tm.rename}</Item>}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{tm.download}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <Item onSelect={() => downloadDocument(controller.doc, name, 'html')}>{t.welddocs.download.html}</Item>
            <Item onSelect={() => downloadDocument(controller.doc, name, 'markdown')}>{t.welddocs.download.markdown}</Item>
            <Item onSelect={() => downloadDocument(controller.doc, name, 'text')}>{t.welddocs.download.text}</Item>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <Item disabled={ro} onSelect={() => controller.openDialog('pageSetup')}>{tm.pageSetup}</Item>
        <Item shortcut={`${MOD_LABEL}+P`} onSelect={() => controller.setPrinting(true)}>
          {tm.print}
        </Item>
      </TopMenu>

      <TopMenu label={tm.edit}>
        <Item disabled={ro || !controller.canUndo} shortcut={`${MOD_LABEL}+Z`} onSelect={() => controller.undo()}>
          {tm.undo}
        </Item>
        <Item disabled={ro || !controller.canRedo} shortcut={`${MOD_LABEL}+Y`} onSelect={() => controller.redo()}>
          {tm.redo}
        </Item>
        <DropdownMenuSeparator />
        <Item disabled={ro} shortcut={`${MOD_LABEL}+X`} onSelect={() => void clipboard('cut')}>
          {tm.cut}
        </Item>
        <Item shortcut={`${MOD_LABEL}+C`} onSelect={() => void clipboard('copy')}>
          {tm.copy}
        </Item>
        <Item disabled={ro} shortcut={`${MOD_LABEL}+V`} onSelect={() => void clipboard('paste')}>
          {tm.paste}
        </Item>
        <Item disabled={ro} shortcut={`${MOD_LABEL}+Shift+V`} onSelect={() => void clipboard('pastePlain')}>
          {tm.pastePlain}
        </Item>
        <DropdownMenuSeparator />
        <Item shortcut={`${MOD_LABEL}+A`} onSelect={() => controller.selectAll()}>
          {tm.selectAll}
        </Item>
        <Item shortcut={`${MOD_LABEL}+H`} onSelect={() => controller.openFind()}>
          {tm.findReplace}
        </Item>
      </TopMenu>

      <TopMenu label={tm.view}>
        <Item checked={controller.showRuler} onSelect={() => controller.setView({ showRuler: !controller.showRuler })}>
          {tm.showRuler}
        </Item>
        <Item checked={controller.showOutline} onSelect={() => controller.setView({ showOutline: !controller.showOutline })}>
          {tm.showOutline}
        </Item>
        <Item checked={!!controller.doc.props.pageless} disabled={ro} onSelect={() => controller.setPageless(!controller.doc.props.pageless)}>
          {tm.pageless}
        </Item>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{tm.zoom}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {ZOOMS.map((z) => (
              <Item key={z} checked={controller.zoom === z} onSelect={() => controller.setZoom(z)}>
                {Math.round(z * 100)}%
              </Item>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </TopMenu>

      {!ro && (
        <TopMenu label={tm.insert}>
          <Item shortcut={`${MOD_LABEL}+K`} onSelect={() => controller.openDialog('link')}>
            {tm.link}
          </Item>
          <Item onSelect={() => controller.insertHorizontalRule()}>{tm.horizontalLine}</Item>
          <Item shortcut={`${MOD_LABEL}+Enter`} onSelect={() => controller.insertPageBreak()}>
            {tm.pageBreak}
          </Item>
          <Item disabled={controller.selection.story !== 'body'} onSelect={() => controller.insertFootnote()}>
            {tm.footnote}
          </Item>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{tm.headersFooters}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <Item disabled={!!controller.doc.props.pageless} onSelect={() => controller.editHeader('header', controller.caretPage())}>
                {tm.header}
              </Item>
              <Item disabled={!!controller.doc.props.pageless} onSelect={() => controller.editHeader('footer', controller.caretPage())}>
                {tm.footer}
              </Item>
              <DropdownMenuSeparator />
              <Item checked={!!controller.section.titlePage} onSelect={() => controller.setSection({ titlePage: !controller.section.titlePage })}>
                {tm.differentFirstPage}
              </Item>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <Item onSelect={() => controller.insertPageNumber('page')}>{tm.pageNumber}</Item>
          <Item onSelect={() => controller.insertPageNumber('pages')}>{tm.pageCount}</Item>
          <Item onSelect={() => controller.insertDate()}>{tm.date}</Item>
        </TopMenu>
      )}

      {!ro && (
        <TopMenu label={tm.format}>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{tm.text}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <Item checked={controller.isActive('bold')} shortcut={`${MOD_LABEL}+B`} onSelect={() => controller.toggle('bold')}>
                {tx.bold}
              </Item>
              <Item checked={controller.isActive('italic')} shortcut={`${MOD_LABEL}+I`} onSelect={() => controller.toggle('italic')}>
                {tx.italic}
              </Item>
              <Item checked={controller.isActive('underline')} shortcut={`${MOD_LABEL}+U`} onSelect={() => controller.toggle('underline')}>
                {tx.underline}
              </Item>
              <Item checked={controller.isActive('strike')} shortcut="Alt+Shift+5" onSelect={() => controller.toggle('strike')}>
                {tx.strikethrough}
              </Item>
              <Item checked={controller.textStyle().script === 'super'} shortcut={`${MOD_LABEL}+.`} onSelect={() => controller.toggleScript('super')}>
                {tx.superscript}
              </Item>
              <Item checked={controller.textStyle().script === 'sub'} shortcut={`${MOD_LABEL}+,`} onSelect={() => controller.toggleScript('sub')}>
                {tx.subscript}
              </Item>
              <Item checked={controller.isActive('smallCaps')} onSelect={() => controller.setTextStyle({ smallCaps: controller.isActive('smallCaps') ? null : true })}>
                {tx.smallCaps}
              </Item>
              <Item checked={controller.isActive('allCaps')} onSelect={() => controller.setTextStyle({ allCaps: controller.isActive('allCaps') ? null : true })}>
                {tx.allCaps}
              </Item>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{tm.paragraphStyles}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {PARAGRAPH_STYLES.map((id, i) => (
                <Item key={id} checked={controller.paragraphStyle() === id} shortcut={i === 0 ? `${MOD_LABEL}+Alt+0` : id.startsWith('heading') ? `${MOD_LABEL}+Alt+${id.slice(7)}` : undefined} onSelect={() => controller.setParagraphStyle(id)}>
                  {ts[id]}
                </Item>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{tm.alignIndent}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <Item onSelect={() => controller.setParagraph({ align: null })}>{tt.alignLeft}</Item>
              <Item onSelect={() => controller.setParagraph({ align: 'center' })}>{tt.alignCenter}</Item>
              <Item onSelect={() => controller.setParagraph({ align: 'right' })}>{tt.alignRight}</Item>
              <Item onSelect={() => controller.setParagraph({ align: 'justify' })}>{tt.justify}</Item>
              <DropdownMenuSeparator />
              <Item onSelect={() => controller.indent(1)}>{tt.increaseIndent}</Item>
              <Item onSelect={() => controller.indent(-1)}>{tt.decreaseIndent}</Item>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{tm.bulletsNumbering}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <Item onSelect={() => controller.toggleList('bullet')}>{tt.bulleted}</Item>
              <Item onSelect={() => controller.toggleList('numbered')}>{tt.numbered}</Item>
              <Item onSelect={() => controller.toggleList('check')}>{tt.checklist}</Item>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <Item shortcut={`${MOD_LABEL}+\\`} onSelect={() => controller.clearFormatting()}>
            {tm.clearFormatting}
          </Item>
        </TopMenu>
      )}

      <TopMenu label={tm.tools}>
        <Item shortcut={`${MOD_LABEL}+Shift+C`} onSelect={() => controller.openDialog('wordCount')}>
          {tm.wordCount}
        </Item>
      </TopMenu>

      <TopMenu label={tm.help}>
        <Item shortcut={`${MOD_LABEL}+/`} onSelect={() => controller.openDialog('shortcuts')}>
          {tm.shortcuts}
        </Item>
      </TopMenu>
    </div>
  );
}

function TopMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-accent data-[state=open]:bg-accent" onMouseDown={(e) => e.preventDefault()}>
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Item({
  children,
  onSelect,
  shortcut,
  checked,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled}>
      <span className="w-4 text-center text-xs">{checked ? '✓' : ''}</span>
      <span className="flex-1">{children}</span>
      {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
}
