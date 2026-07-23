import { useState } from 'react';
import { Search, LifeBuoy, Keyboard, Bug, Send, Info } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import {
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSeparator,
} from '@weldsuite/ui/components/menubar';
import type { MenuProps } from './menu-kit';
import { useStub, useMenuAlign } from './menu-kit';
import { useTranslations } from '@weldsuite/i18n/client';

export function HelpMenu({ menuValue }: MenuProps) {
  const t = useTranslations();
  const stub = useStub();
  const align = useMenuAlign(menuValue);
  const [aboutOpen, setAboutOpen] = useState(false);
  const aboutLabel = t('sweep.entities.docMenuAboutProduct', { product: 'WeldFlow' });

  return (
    <>
      <MenubarMenu value={menuValue}>
        <MenubarTrigger data-menu-value={menuValue}>{t('sweep.entities.docMenuHelp')}</MenubarTrigger>
        <MenubarContent align={align}>
          <MenubarItem onSelect={stub(t('sweep.entities.docMenuSearchTheMenus'))}>
            <Search />
            {t('sweep.entities.docMenuSearchTheMenus')}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={stub(t('sweep.entities.docMenuHelpCenter'))}>
            <LifeBuoy />
            {t('sweep.entities.docMenuHelpCenter')}
          </MenubarItem>
          <MenubarItem onSelect={stub(t('sweep.entities.docMenuKeyboardShortcuts'))}>
            <Keyboard />
            {t('sweep.entities.docMenuKeyboardShortcuts')}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={stub(t('sweep.entities.docMenuReportAProblem'))}>
            <Bug />
            {t('sweep.entities.docMenuReportAProblem')}
          </MenubarItem>
          <MenubarItem onSelect={stub(t('sweep.entities.docMenuSendFeedback'))}>
            <Send />
            {t('sweep.entities.docMenuSendFeedback')}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => setAboutOpen(true)}>
            <Info />
            {aboutLabel}
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>{aboutLabel}</DialogTitle>
            <DialogDescription>
              {t('sweep.entities.docMenuAboutDescription', { product: 'WeldFlow', suite: 'WeldSuite' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setAboutOpen(false)}>{t('sweep.entities.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
