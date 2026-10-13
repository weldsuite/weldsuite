/**
 * Import prospects from a WeldCRM people list or a WeldData list. The server
 * reads the list; only people with an email address become prospects.
 */

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachImportReport } from '@weldsuite/app-api-client/schemas/reach';
import { useLists } from '@/hooks/queries/use-lists-queries';
import { useWelddataLists } from '@/hooks/queries/use-welddata-queries';
import {
  useImportReachFromCrmList,
  useImportReachFromWeldData,
} from '@/hooks/queries/use-reach-prospect-queries';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import {
  EmptyText,
  ErrorBanner,
  InlineSpinner,
  Notice,
  errorMessage,
} from '@/app/weldreach/components/engage/kit';
import { ImportReportView } from './import-report';

export type ListSource = 'crm' | 'welddata';

interface SourceList {
  id: string;
  name: string;
  count: number;
}

interface SourceLists {
  lists: SourceList[];
  isLoading: boolean;
  error: Error | null;
}

/** The people lists of one source. Both queries are always declared; only this source's runs. */
function useSourceLists(source: ListSource): SourceLists {
  const crm = useLists('person', undefined, source === 'crm');
  const welddata = useWelddataLists(undefined, source === 'welddata');

  return useMemo(() => {
    if (source === 'crm') {
      const lists = (crm.data?.data ?? []).map((list) => ({
        id: list.id,
        name: list.name,
        count: list.memberCount ?? 0,
      }));
      return { lists, isLoading: crm.isLoading, error: crm.error };
    }
    const lists = (welddata.data?.data ?? [])
      .filter((list) => list.kind === 'person')
      .map((list) => ({ id: list.id, name: list.name, count: list.leadCount ?? 0 }));
    return { lists, isLoading: welddata.isLoading, error: welddata.error };
  }, [source, crm.data, crm.isLoading, crm.error, welddata.data, welddata.isLoading, welddata.error]);
}

/** The list choice and the name of the prospect list the import fills. */
function ListChoice({
  source,
  sourceLists,
  listId,
  listName,
  disabled,
  onChoose,
  onNameChange,
}: Readonly<{
  source: ListSource;
  sourceLists: SourceLists;
  listId: string | undefined;
  listName: string;
  disabled: boolean;
  onChoose: (id: string) => void;
  onNameChange: (name: string) => void;
}>) {
  const t = useTranslations();
  const format = useReachFormat();

  if (sourceLists.isLoading) return <InlineSpinner />;
  if (sourceLists.error) {
    return <ErrorBanner error={errorMessage(sourceLists.error, t('reachEngage.import.list.loadFailed'))} />;
  }
  if (sourceLists.lists.length === 0) {
    return (
      <EmptyText>
        {source === 'crm'
          ? t('reachEngage.import.list.noCrmLists')
          : t('reachEngage.import.list.noWelddataLists')}
      </EmptyText>
    );
  }

  return (
    <>
      <div className="space-y-1.5">
        <Label id="reach-import-source-list">
          {source === 'crm'
            ? t('reachEngage.import.list.crmList')
            : t('reachEngage.import.list.welddataList')}
        </Label>
        <Select value={listId ?? ''} onValueChange={onChoose} disabled={disabled}>
          <SelectTrigger aria-labelledby="reach-import-source-list" className="w-full">
            <SelectValue placeholder={t('reachEngage.import.list.pick')} />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {sourceLists.lists.map((list) => (
              <SelectItem key={list.id} value={list.id}>
                {list.name} ({format.number(list.count)})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="reach-import-list-name">{t('reachEngage.import.list.listName')}</Label>
        <Input
          id="reach-import-list-name"
          autoComplete="off"
          value={listName}
          onChange={(event) => onNameChange(event.target.value)}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">{t('reachEngage.import.list.listNameHint')}</p>
      </div>
    </>
  );
}

export function ListImport({
  source,
  onClose,
  onViewList,
}: Readonly<{ source: ListSource; onClose: () => void; onViewList: (listId: string) => void }>) {
  const t = useTranslations();
  const importCrm = useImportReachFromCrmList();
  const importWeldData = useImportReachFromWeldData();
  const sourceLists = useSourceLists(source);

  const [listId, setListId] = useState<string | undefined>(undefined);
  const [listName, setListName] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [report, setReport] = useState<ReachImportReport | null>(null);

  const pending = importCrm.isPending || importWeldData.isPending;

  function choose(id: string) {
    setListId(id);
    // The new prospect list starts out with the source list's name.
    setListName(sourceLists.lists.find((list) => list.id === id)?.name ?? '');
  }

  async function run() {
    if (!listId) return;
    setFailure(null);
    const name = listName.trim() || undefined;
    try {
      const res =
        source === 'crm'
          ? await importCrm.mutateAsync({ crmListId: listId, listName: name })
          : await importWeldData.mutateAsync({ welddataListId: listId, listName: name });
      setReport(res.data);
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.import.list.failed')));
    }
  }

  if (report) {
    return <ImportReportView report={report} onClose={onClose} onViewList={onViewList} />;
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <p className="text-sm text-muted-foreground">
        {source === 'crm'
          ? t('reachEngage.import.list.crmDescription')
          : t('reachEngage.import.list.welddataDescription')}
      </p>

      <ListChoice
        source={source}
        sourceLists={sourceLists}
        listId={listId}
        listName={listName}
        disabled={pending}
        onChoose={choose}
        onNameChange={setListName}
      />

      <Notice>{t('reachEngage.import.b2bNote')}</Notice>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          {t('reachEngage.common.cancel')}
        </Button>
        <Button type="button" onClick={() => void run()} disabled={!listId || pending}>
          {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('reachEngage.import.list.start')}
        </Button>
      </DialogFooter>
    </div>
  );
}
