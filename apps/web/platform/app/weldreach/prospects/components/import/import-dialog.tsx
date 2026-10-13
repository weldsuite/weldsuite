/** "Import prospects": a CSV file, a WeldCRM list or a WeldData list. */

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { CsvImport } from './csv-import';
import { ListImport } from './list-import';

type Source = 'csv' | 'crm' | 'welddata';

export function ImportDialog({
  onClose,
  onViewList,
}: Readonly<{
  onClose: () => void;
  /** Filter the prospects table to the list an import filled. */
  onViewList: (listId: string) => void;
}>) {
  const t = useTranslations();
  const [source, setSource] = useState<Source>('csv');

  function viewList(listId: string) {
    onViewList(listId);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('reachEngage.import.title')}</DialogTitle>
          <DialogDescription>{t('reachEngage.import.description')}</DialogDescription>
        </DialogHeader>

        <Tabs value={source} onValueChange={(value) => setSource(value as Source)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="csv">{t('reachEngage.import.sources.csv')}</TabsTrigger>
            <TabsTrigger value="crm">{t('reachEngage.import.sources.crm')}</TabsTrigger>
            <TabsTrigger value="welddata">{t('reachEngage.import.sources.welddata')}</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Keyed by source so switching starts that source fresh. */}
        {source === 'csv' && <CsvImport key="csv" onClose={onClose} onViewList={viewList} />}
        {source === 'crm' && <ListImport key="crm" source="crm" onClose={onClose} onViewList={viewList} />}
        {source === 'welddata' && (
          <ListImport key="welddata" source="welddata" onClose={onClose} onViewList={viewList} />
        )}
      </DialogContent>
    </Dialog>
  );
}
