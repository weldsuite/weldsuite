import {
  FileText,
  File,
  Pencil,
  Ruler,
  List,
  Pilcrow,
  Maximize,
} from 'lucide-react';
import {
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarCheckboxItem,
  MenubarSub,
  MenubarSubTrigger,
  MenubarSubContent,
  MenubarSeparator,
  MenubarShortcut,
} from '@weldsuite/ui/components/menubar';
import type { MenuProps } from './menu-kit';
import { useStub, useMenuAlign } from './menu-kit';
import { useTranslations } from '@weldsuite/i18n/client';

export function ViewMenu({ cmd, menuValue }: MenuProps) {
  const t = useTranslations();
  const stub = useStub();
  const align = useMenuAlign(menuValue);
  const printLayoutLabel = t('sweep.entities.docMenuPrintLayout');
  const pagelessLabel = t('sweep.entities.docMenuPageless');

  return (
    <MenubarMenu value={menuValue}>
      <MenubarTrigger data-menu-value={menuValue}>{t('sweep.entities.docMenuView')}</MenubarTrigger>
      <MenubarContent align={align}>
        <MenubarCheckboxItem checked onSelect={stub(printLayoutLabel)}>
          {printLayoutLabel}
        </MenubarCheckboxItem>
        <MenubarCheckboxItem onSelect={stub(pagelessLabel)}>{pagelessLabel}</MenubarCheckboxItem>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger>
            <Pencil />
            {t('sweep.entities.docMenuMode')}
          </MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarItem onSelect={stub(t('sweep.entities.docMenuEditingMode'))}>
              <Pencil />
              {t('sweep.entities.docMenuEditing')}
            </MenubarItem>
            <MenubarItem onSelect={stub(t('sweep.entities.docMenuSuggestingMode'))}>
              <FileText />
              {t('sweep.entities.docMenuSuggesting')}
            </MenubarItem>
            <MenubarItem onSelect={stub(t('sweep.entities.docMenuViewingMode'))}>
              <File />
              {t('sweep.entities.docMenuViewing')}
            </MenubarItem>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <MenubarCheckboxItem onSelect={stub(t('sweep.entities.docMenuShowRuler'))}>
          <Ruler />
          {t('sweep.entities.docMenuShowRuler')}
        </MenubarCheckboxItem>
        <MenubarCheckboxItem onSelect={stub(t('sweep.entities.docMenuShowOutline'))}>
          <List />
          {t('sweep.entities.docMenuShowDocumentOutline')}
          <MenubarShortcut>⌘⌥A</MenubarShortcut>
        </MenubarCheckboxItem>
        <MenubarCheckboxItem onSelect={stub(t('sweep.entities.docMenuShowNonPrintingCharacters'))}>
          <Pilcrow />
          {t('sweep.entities.docMenuShowNonPrintingCharacters')}
        </MenubarCheckboxItem>
        <MenubarSeparator />
        <MenubarItem onSelect={() => cmd.toggleFullscreen()}>
          <Maximize />
          {t('sweep.entities.docMenuFullScreen')}
          <MenubarShortcut>F11</MenubarShortcut>
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}
