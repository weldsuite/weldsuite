/**
 * "Add prospects" to a campaign: a saved list, or hand-picked prospects. The
 * API reports what it left out (already enrolled, suppressed, consumer
 * addresses, …) and the dialog shows that report instead of closing.
 */

import { useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  addReachCampaignProspectsSchema,
  type ReachAddProspectsReport,
  type ReachProspect,
} from '@weldsuite/app-api-client/schemas/reach';
import { useDebounce } from '@/hooks/use-debounce';
import { useAddReachCampaignProspects } from '@/hooks/queries/use-reach-campaign-queries';
import {
  useReachProspectLists,
  useReachProspects,
} from '@/hooks/queries/use-reach-prospect-queries';
import { ValidationBadge } from '@/app/weldreach/components/engage/badges';
import { personName, useReachFormat } from '@/app/weldreach/components/engage/format';
import {
  EmptyText,
  ErrorBanner,
  InlineSpinner,
  errorMessage,
} from '@/app/weldreach/components/engage/kit';

type Mode = 'list' | 'prospects';

const SKIP_REASON_KEYS: Record<ReachAddProspectsReport['skipped'][number]['reason'], string> = {
  already_enrolled: 'reachEngage.addProspects.skipped.already_enrolled',
  suppressed: 'reachEngage.addProspects.skipped.suppressed',
  consumer: 'reachEngage.addProspects.skipped.consumer',
  invalid: 'reachEngage.addProspects.skipped.invalid',
  enrolled_elsewhere: 'reachEngage.addProspects.skipped.enrolled_elsewhere',
};

function AddReportView({
  report,
  onClose,
}: Readonly<{ report: ReachAddProspectsReport; onClose: () => void }>) {
  const t = useTranslations();
  const format = useReachFormat();

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">
        {t('reachEngage.addProspects.added', { count: format.number(report.added) })}
      </p>
      {report.skipped.length > 0 && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-sm font-medium">{t('reachEngage.addProspects.skippedTitle')}</p>
          <ul className="space-y-1.5 text-sm">
            {report.skipped.map((entry) => (
              <li key={entry.reason} className="flex items-start justify-between gap-3">
                <span className="text-muted-foreground">{t(SKIP_REASON_KEYS[entry.reason])}</span>
                <span className="font-medium tabular-nums">{format.number(entry.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <DialogFooter>
        <Button onClick={onClose}>{t('reachEngage.common.done')}</Button>
      </DialogFooter>
    </div>
  );
}

function ListPicker({
  listId,
  onChange,
}: Readonly<{ listId: string | undefined; onChange: (listId: string) => void }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const lists = useReachProspectLists();

  if (lists.isLoading) return <InlineSpinner className="py-4" />;
  const items = lists.data ?? [];
  if (items.length === 0) return <EmptyText>{t('reachEngage.addProspects.noLists')}</EmptyText>;

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium" id="reach-add-list-label">
        {t('reachEngage.addProspects.list')}
      </p>
      <Select value={listId ?? ''} onValueChange={onChange}>
        <SelectTrigger aria-labelledby="reach-add-list-label" className="w-full">
          <SelectValue placeholder={t('reachEngage.addProspects.listPlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          {items.map((list) => (
            <SelectItem key={list.id} value={list.id}>
              {list.name} ({format.number(list.prospectCount)})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ProspectRows({
  isLoading,
  rows,
  selected,
  allVisibleSelected,
  hasNextPage,
  isFetchingNextPage,
  onToggle,
  onToggleVisible,
  onLoadMore,
}: Readonly<{
  isLoading: boolean;
  rows: ReachProspect[];
  selected: Set<string>;
  allVisibleSelected: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onToggle: (id: string) => void;
  onToggleVisible: () => void;
  onLoadMore: () => void;
}>) {
  const t = useTranslations();

  if (isLoading) return <InlineSpinner />;
  if (rows.length === 0) return <EmptyText>{t('reachEngage.addProspects.noProspects')}</EmptyText>;

  return (
    <ul className="divide-y">
      <li className="flex items-center gap-3 bg-muted/30 px-3 py-2">
        <Checkbox
          checked={allVisibleSelected}
          onCheckedChange={onToggleVisible}
          aria-label={t('reachEngage.addProspects.selectVisible')}
        />
        <span className="text-xs text-muted-foreground">{t('reachEngage.addProspects.selectVisible')}</span>
      </li>
      {rows.map((prospect) => (
        <li key={prospect.id}>
          <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40">
            <Checkbox checked={selected.has(prospect.id)} onCheckedChange={() => onToggle(prospect.id)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{personName(prospect) ?? prospect.email}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {personName(prospect) ? prospect.email : prospect.companyName}
              </span>
            </span>
            <ValidationBadge validation={prospect.validation} />
          </label>
        </li>
      ))}
      {hasNextPage && (
        <li className="p-2 text-center">
          <Button type="button" variant="ghost" size="sm" disabled={isFetchingNextPage} onClick={onLoadMore}>
            {isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('reachEngage.common.loadMore')}
          </Button>
        </li>
      )}
    </ul>
  );
}

function ProspectPicker({
  selected,
  onSelectedChange,
}: Readonly<{ selected: Set<string>; onSelectedChange: (selected: Set<string>) => void }>) {
  const t = useTranslations();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const prospects = useReachProspects({ search: debouncedSearch });

  const visibleIds = useMemo(() => prospects.prospects.map((prospect) => prospect.id), [prospects.prospects]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  }

  function toggleVisible() {
    const next = new Set(selected);
    for (const id of visibleIds) {
      if (allVisibleSelected) next.delete(id);
      else next.add(id);
    }
    onSelectedChange(next);
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('reachEngage.addProspects.searchPlaceholder')}
          aria-label={t('reachEngage.addProspects.searchPlaceholder')}
          className="pl-8"
        />
      </div>

      <div className="max-h-72 overflow-y-auto rounded-md border">
        <ProspectRows
          isLoading={prospects.isLoading}
          rows={prospects.prospects}
          selected={selected}
          allVisibleSelected={allVisibleSelected}
          hasNextPage={prospects.hasNextPage}
          isFetchingNextPage={prospects.isFetchingNextPage}
          onToggle={toggle}
          onToggleVisible={toggleVisible}
          onLoadMore={() => void prospects.fetchNextPage()}
        />
      </div>
    </div>
  );
}

export function AddProspectsDialog({
  campaignId,
  onClose,
}: Readonly<{ campaignId: string; onClose: () => void }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const add = useAddReachCampaignProspects(campaignId);

  const [mode, setMode] = useState<Mode>('list');
  const [listId, setListId] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<ReachAddProspectsReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const canSubmit = mode === 'list' ? Boolean(listId) : selected.size > 0;

  async function submit() {
    setFailure(null);
    const payload = mode === 'list' ? { listId } : { prospectIds: [...selected] };
    const parsed = addReachCampaignProspectsSchema.safeParse(payload);
    if (!parsed.success) {
      setFailure(t('reachEngage.addProspects.nothingSelected'));
      return;
    }
    try {
      const res = await add.mutateAsync(parsed.data);
      setReport(res.data);
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.addProspects.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !add.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('reachEngage.addProspects.title')}</DialogTitle>
          <DialogDescription>{t('reachEngage.addProspects.description')}</DialogDescription>
        </DialogHeader>

        {report ? (
          <AddReportView report={report} onClose={onClose} />
        ) : (
          <div className="space-y-4">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="list">{t('reachEngage.addProspects.fromList')}</TabsTrigger>
                <TabsTrigger value="prospects">{t('reachEngage.addProspects.fromSelection')}</TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === 'list' && <ListPicker listId={listId} onChange={setListId} />}
            {mode === 'prospects' && <ProspectPicker selected={selected} onSelectedChange={setSelected} />}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={add.isPending}>
                {t('reachEngage.common.cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canSubmit || add.isPending}>
                {add.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === 'prospects' && selected.size > 0
                  ? t('reachEngage.addProspects.submitCount', { count: format.number(selected.size) })
                  : t('reachEngage.addProspects.submit')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
