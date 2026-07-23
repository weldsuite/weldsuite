import {
  FilePlus,
  FolderOpen,
  Pencil,
  Copy,
  Move,
  Download,
  FileText,
  FileType,
  Code,
  FileCode,
  Save,
  Share2,
  Mail,
  Globe,
  Info,
  Printer,
  Trash2,
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
import { useStub, useMenuAlign } from './menu-kit';
import { useTranslations } from '@weldsuite/i18n/client';

export function FileMenu({ cmd, actions, menuValue }: MenuProps) {
  const t = useTranslations();
  const stub = useStub();
  const align = useMenuAlign(menuValue);
  const renameLabel = t('sweep.entities.docMenuRename');
  const saveNowLabel = t('sweep.entities.docMenuSaveNow');

  return (
    <MenubarMenu value={menuValue}>
      <MenubarTrigger data-menu-value={menuValue}>{t('sweep.entities.docMenuFile')}</MenubarTrigger>
      <MenubarContent align={align}>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuNewDocument'))}>
          <FilePlus />
          {t('sweep.entities.docMenuNewDocument')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuOpen'))}>
          <FolderOpen />
          {t('sweep.entities.docMenuOpen')}
          <MenubarShortcut>⌘O</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onSelect={() => (actions?.onRename ? actions.onRename() : stub(renameLabel)())}>
          <Pencil />
          {renameLabel}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuMakeACopy'))}>
          <Copy />
          {t('sweep.entities.docMenuMakeACopy')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuMove'))}>
          <Move />
          {t('sweep.entities.docMenuMove')}
        </MenubarItem>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger>
            <Download />
            {t('sweep.entities.docMenuDownload')}
          </MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarItem onSelect={() => cmd.downloadHtml()}>
              <Code />
              {t('sweep.entities.docMenuWebPageHtml')}
            </MenubarItem>
            <MenubarItem onSelect={stub(t('sweep.entities.docMenuMicrosoftWordExport'))}>
              <FileText />
              {t('sweep.entities.docMenuMicrosoftWord')}
            </MenubarItem>
            <MenubarItem onSelect={stub(t('sweep.entities.docMenuPdfExport'))}>
              <FileText />
              {t('sweep.entities.docMenuPdfDocument')}
            </MenubarItem>
            <MenubarItem onSelect={stub(t('sweep.entities.docMenuPlainTextExport'))}>
              <FileType />
              {t('sweep.entities.docMenuPlainText')}
            </MenubarItem>
            <MenubarItem onSelect={stub(t('sweep.entities.docMenuMarkdownExport'))}>
              <FileCode />
              {t('sweep.entities.docMenuMarkdown')}
            </MenubarItem>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <MenubarItem onSelect={() => (actions?.onSaveNow ? actions.onSaveNow() : stub(saveNowLabel)())}>
          <Save />
          {saveNowLabel}
          <MenubarShortcut>⌘S</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuShare'))}>
          <Share2 />
          {t('sweep.entities.docMenuShare')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuEmailAsAttachment'))}>
          <Mail />
          {t('sweep.entities.docMenuEmailAsAttachment')}
        </MenubarItem>
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuPublishToTheWeb'))}>
          <Globe />
          {t('sweep.entities.docMenuPublishToTheWeb')}
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onSelect={stub(t('sweep.entities.docMenuDocumentDetails'))}>
          <Info />
          {t('sweep.entities.docMenuDocumentDetails')}
        </MenubarItem>
        <MenubarItem onSelect={() => cmd.print()}>
          <Printer />
          {t('sweep.entities.docMenuPrint')}
          <MenubarShortcut>⌘P</MenubarShortcut>
        </MenubarItem>
        {actions?.onDelete ? (
          <>
            <MenubarSeparator />
            <MenubarItem variant="destructive" onSelect={() => actions.onDelete?.()}>
              <Trash2 />
              {t('sweep.entities.docMenuMoveToTrash')}
            </MenubarItem>
          </>
        ) : null}
      </MenubarContent>
    </MenubarMenu>
  );
}
