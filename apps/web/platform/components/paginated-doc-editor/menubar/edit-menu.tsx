import {
  Undo2,
  Redo2,
  Scissors,
  Copy,
  ClipboardPaste,
  ClipboardCopy,
  MousePointerSquareDashed,
  Search,
  Replace,
  Eraser,
} from 'lucide-react';
import {
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSeparator,
  MenubarShortcut,
} from '@weldsuite/ui/components/menubar';
import type { MenuProps } from './menu-kit';
import { useStub, useMenuAlign } from './menu-kit';
import { useTranslations } from '@weldsuite/i18n/client';

export function EditMenu({ cmd, menuValue }: MenuProps) {
  const t = useTranslations();
  const stub = useStub();
  const align = useMenuAlign(menuValue);
  const pasteLabel = t('sweep.entities.docMenuPaste');
  const pasteWithoutFormattingLabel = t('sweep.entities.docMenuPasteWithoutFormatting');
  const findLabel = t('sweep.entities.docMenuFind');
  const findAndReplaceLabel = t('sweep.entities.docMenuFindAndReplace');

  return (
    <MenubarMenu value={menuValue}>
      <MenubarTrigger data-menu-value={menuValue}>{t('sweep.entities.docMenuEdit')}</MenubarTrigger>
      <MenubarContent align={align}>
        <MenubarItem onSelect={() => cmd.exec('undo')}>
          <Undo2 />
          {t('sweep.entities.docMenuUndo')}
          <MenubarShortcut>⌘Z</MenubarShortcut>
        </MenubarItem>
        <MenubarItem onSelect={() => cmd.exec('redo')}>
          <Redo2 />
          {t('sweep.entities.docMenuRedo')}
          <MenubarShortcut>⇧⌘Z</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onSelect={() => cmd.exec('cut')}>
          <Scissors />
          {t('sweep.entities.docMenuCut')}
          <MenubarShortcut>⌘X</MenubarShortcut>
        </MenubarItem>
        <MenubarItem onSelect={() => cmd.exec('copy')}>
          <Copy />
          {t('sweep.entities.docMenuCopy')}
          <MenubarShortcut>⌘C</MenubarShortcut>
        </MenubarItem>
        <MenubarItem onSelect={stub(pasteLabel)}>
          <ClipboardPaste />
          {pasteLabel}
          <MenubarShortcut>⌘V</MenubarShortcut>
        </MenubarItem>
        <MenubarItem onSelect={stub(pasteWithoutFormattingLabel)}>
          <ClipboardCopy />
          {pasteWithoutFormattingLabel}
          <MenubarShortcut>⇧⌘V</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onSelect={() => cmd.exec('selectAll')}>
          <MousePointerSquareDashed />
          {t('sweep.entities.docMenuSelectAll')}
          <MenubarShortcut>⌘A</MenubarShortcut>
        </MenubarItem>
        <MenubarItem onSelect={() => cmd.exec('removeFormat')}>
          <Eraser />
          {t('sweep.entities.docMenuClearFormatting')}
          <MenubarShortcut>⌘\\</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onSelect={stub(findLabel)}>
          <Search />
          {findLabel}
          <MenubarShortcut>⌘F</MenubarShortcut>
        </MenubarItem>
        <MenubarItem onSelect={stub(findAndReplaceLabel)}>
          <Replace />
          {findAndReplaceLabel}
          <MenubarShortcut>⌘H</MenubarShortcut>
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}
