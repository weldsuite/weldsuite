import {
  Type,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Superscript,
  Subscript,
  Pilcrow,
  Heading1,
  Heading2,
  Heading3,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  IndentIncrease,
  IndentDecrease,
  ListTree,
  List,
  ListOrdered,
  Quote,
  Eraser,
} from 'lucide-react';
import {
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSub,
  MenubarSubTrigger,
  MenubarSubContent,
  MenubarSeparator,
  MenubarShortcut,
} from '@weldsuite/ui/components/menubar';
import type { MenuProps } from './menu-kit';
import { useMenuAlign } from './menu-kit';
import { useTranslations } from '@weldsuite/i18n/client';

export function FormatMenu({ cmd, menuValue }: MenuProps) {
  const t = useTranslations();
  const align = useMenuAlign(menuValue);

  return (
    <MenubarMenu value={menuValue}>
      <MenubarTrigger data-menu-value={menuValue}>{t('sweep.entities.docMenuFormat')}</MenubarTrigger>
      <MenubarContent align={align}>
        <MenubarSub>
          <MenubarSubTrigger>
            <Type />
            {t('sweep.entities.docMenuTextSub')}
          </MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarItem onSelect={() => cmd.exec('bold')}>
              <Bold />
              {t('sweep.entities.docMenuBold')}
              <MenubarShortcut>⌘B</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.exec('italic')}>
              <Italic />
              {t('sweep.entities.docMenuItalic')}
              <MenubarShortcut>⌘I</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.exec('underline')}>
              <Underline />
              {t('sweep.entities.docMenuUnderline')}
              <MenubarShortcut>⌘U</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.exec('strikeThrough')}>
              <Strikethrough />
              {t('sweep.entities.docMenuStrikethrough')}
              <MenubarShortcut>⌥⇧5</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onSelect={() => cmd.exec('superscript')}>
              <Superscript />
              {t('sweep.entities.docMenuSuperscript')}
              <MenubarShortcut>⌘.</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.exec('subscript')}>
              <Subscript />
              {t('sweep.entities.docMenuSubscript')}
              <MenubarShortcut>⌘,</MenubarShortcut>
            </MenubarItem>
          </MenubarSubContent>
        </MenubarSub>

        <MenubarSub>
          <MenubarSubTrigger>
            <Pilcrow />
            {t('sweep.entities.docMenuParagraphStyles')}
          </MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarItem onSelect={() => cmd.setBlock('P')}>
              <Pilcrow />
              {t('sweep.entities.docMenuNormalText')}
              <MenubarShortcut>⌘⌥0</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.setBlock('H1')}>
              <Heading1 />
              {t('sweep.entities.docMenuHeading1')}
              <MenubarShortcut>⌘⌥1</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.setBlock('H2')}>
              <Heading2 />
              {t('sweep.entities.docMenuHeading2')}
              <MenubarShortcut>⌘⌥2</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.setBlock('H3')}>
              <Heading3 />
              {t('sweep.entities.docMenuHeading3')}
              <MenubarShortcut>⌘⌥3</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onSelect={() => cmd.setBlock('BLOCKQUOTE')}>
              <Quote />
              {t('sweep.entities.docMenuQuote')}
            </MenubarItem>
          </MenubarSubContent>
        </MenubarSub>

        <MenubarSub>
          <MenubarSubTrigger>
            <AlignLeft />
            {t('sweep.entities.docMenuAlignAndIndent')}
          </MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarItem onSelect={() => cmd.exec('justifyLeft')}>
              <AlignLeft />
              {t('sweep.entities.docMenuLeft')}
              <MenubarShortcut>⌘⇧L</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.exec('justifyCenter')}>
              <AlignCenter />
              {t('sweep.entities.docMenuCenter')}
              <MenubarShortcut>⌘⇧E</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.exec('justifyRight')}>
              <AlignRight />
              {t('sweep.entities.docMenuRight')}
              <MenubarShortcut>⌘⇧R</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.exec('justifyFull')}>
              <AlignJustify />
              {t('sweep.entities.docMenuJustify')}
              <MenubarShortcut>⌘⇧J</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onSelect={() => cmd.exec('indent')}>
              <IndentIncrease />
              {t('sweep.entities.docMenuIncreaseIndent')}
              <MenubarShortcut>Tab</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.exec('outdent')}>
              <IndentDecrease />
              {t('sweep.entities.docMenuDecreaseIndent')}
              <MenubarShortcut>⇧Tab</MenubarShortcut>
            </MenubarItem>
          </MenubarSubContent>
        </MenubarSub>

        <MenubarSub>
          <MenubarSubTrigger>
            <ListTree />
            {t('sweep.entities.docMenuBulletsAndNumbering')}
          </MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarItem onSelect={() => cmd.exec('insertUnorderedList')}>
              <List />
              {t('sweep.entities.docMenuBulletedList')}
              <MenubarShortcut>⌘⇧8</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cmd.exec('insertOrderedList')}>
              <ListOrdered />
              {t('sweep.entities.docMenuNumberedList')}
              <MenubarShortcut>⌘⇧7</MenubarShortcut>
            </MenubarItem>
          </MenubarSubContent>
        </MenubarSub>

        <MenubarSeparator />
        <MenubarItem onSelect={() => cmd.exec('removeFormat')}>
          <Eraser />
          {t('sweep.entities.docMenuClearFormatting')}
          <MenubarShortcut>⌘\\</MenubarShortcut>
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}
