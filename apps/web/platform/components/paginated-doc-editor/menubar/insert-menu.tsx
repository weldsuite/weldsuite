import {
  Image,
  Table,
  Link2,
  Minus,
  Calendar,
  MessageSquare,
  Sigma,
  PenTool,
  BarChart3,
  Hash,
  ListOrdered,
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

const formatToday = () =>
  new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

export function InsertMenu({ cmd, menuValue }: MenuProps) {
  const t = useTranslations();
  const stub = useStub();
  const align = useMenuAlign(menuValue);

  return (
    <MenubarMenu value={menuValue}>
      <MenubarTrigger data-menu-value={menuValue}>{t('sweep.entities.docMenuInsert')}</MenubarTrigger>
      <MenubarContent align={align}>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuImage'))}>
          <Image />
          {t('sweep.entities.docMenuImage')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuTable'))}>
          <Table />
          {t('sweep.entities.docMenuTable')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuDrawing'))}>
          <PenTool />
          {t('sweep.entities.docMenuDrawing')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuChart'))}>
          <BarChart3 />
          {t('sweep.entities.docMenuChart')}
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onSelect={() => cmd.insertLink()}>
          <Link2 />
          {t('sweep.entities.docMenuLink')}
          <MenubarShortcut>⌘K</MenubarShortcut>
        </MenubarItem>
        <MenubarItem onSelect={() => cmd.exec('insertHorizontalRule')}>
          <Minus />
          {t('sweep.entities.docMenuHorizontalLine')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuEquation'))}>
          <Sigma />
          {t('sweep.entities.docMenuEquation')}
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuHeadersAndPageNumbers'))}>
          <Hash />
          {t('sweep.entities.docMenuHeadersAndPageNumbers')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuTableOfContents'))}>
          <ListOrdered />
          {t('sweep.entities.docMenuTableOfContents')}
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onSelect={() => cmd.insertText(formatToday())}>
          <Calendar />
          {t('sweep.entities.docMenuDate')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuComment'))}>
          <MessageSquare />
          {t('sweep.entities.docMenuComment')}
          <MenubarShortcut>⌘⌥M</MenubarShortcut>
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}
