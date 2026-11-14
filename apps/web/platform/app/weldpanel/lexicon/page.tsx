import { useMemo, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelDefinitionKind, PanelLexiconEntry } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Switch } from '@weldsuite/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useUpdateWeldPanelLexicon, useWeldPanelLexicon } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { formatDateTime, formatNumber } from '../lib/format';

interface LexiconRowProps {
  kind: PanelDefinitionKind;
  entry: PanelLexiconEntry;
  canEdit: boolean;
  onChange: (patch: { description?: string | null; hidden?: boolean; verified?: boolean }) => void;
}

function LexiconRow({ kind, entry, canEdit, onChange }: Readonly<LexiconRowProps>) {
  const { t, language } = useI18n();
  const tl = t.weldpanel.analytics.lexicon;
  // The description saves when the field loses focus, and only when it changed.
  const [description, setDescription] = useState(entry.description ?? '');
  const [synced, setSynced] = useState(entry.description ?? '');
  if ((entry.description ?? '') !== synced) {
    setSynced(entry.description ?? '');
    setDescription(entry.description ?? '');
  }

  let seenText = tl.notSeen;
  if (entry.seen) {
    seenText = kind === 'event' && entry.count30d !== null ? tl.seenCount.replace('{count}', formatNumber(entry.count30d, language)) : tl.seenProperty;
  }

  return (
    <TableRow className={entry.hidden ? 'opacity-60' : undefined}>
      <TableCell className="max-w-64">
        <p className="truncate font-mono text-sm" title={entry.name}>
          {entry.name}
        </p>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
        {seenText}
      </TableCell>
      <TableCell className="min-w-48">
        {canEdit ? (
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={() => {
              const next = description.trim();
              if (next !== (entry.description ?? '')) onChange({ description: next === '' ? null : next });
            }}
            placeholder={tl.descriptionPlaceholder}
            aria-label={tl.descriptionLabel.replace('{name}', entry.name)}
            maxLength={2000}
            className="h-8"
          />
        ) : (
          <span className="text-sm text-muted-foreground">{entry.description}</span>
        )}
      </TableCell>
      <TableCell className="text-center">
        <Switch checked={entry.hidden} disabled={!canEdit} onCheckedChange={(hidden) => onChange({ hidden })} aria-label={tl.hiddenLabel.replace('{name}', entry.name)} />
      </TableCell>
      <TableCell className="text-center">
        <Switch checked={entry.verified} disabled={!canEdit} onCheckedChange={(verified) => onChange({ verified })} aria-label={tl.verifiedLabel.replace('{name}', entry.name)} />
      </TableCell>
    </TableRow>
  );
}

function Lexicon({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language } = useI18n();
  const tl = t.weldpanel.analytics.lexicon;
  const canEdit = useCan('panel_reports:update');
  const [kind, setKind] = useState<PanelDefinitionKind>('event');
  const [search, setSearch] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const { data, isLoading, isError, refetch } = useWeldPanelLexicon(projectId);
  const update = useUpdateWeldPanelLexicon(projectId);

  const entries = kind === 'event' ? data?.events : data?.properties;
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (entries ?? [])
      .filter((e) => (showHidden || !e.hidden) && (needle === '' || e.name.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.verified) - Number(a.verified) || (b.count30d ?? 0) - (a.count30d ?? 0) || a.name.localeCompare(b.name));
  }, [entries, search, showHidden]);

  async function change(entry: PanelLexiconEntry, patch: { description?: string | null; hidden?: boolean; verified?: boolean }) {
    try {
      await update.mutateAsync({ kind, name: entry.name, ...patch });
      toast.success(tl.saved);
    } catch {
      toast.error(tl.saveFailed);
    }
  }

  if (isError) return <ErrorState message={tl.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={kind} onValueChange={(next) => setKind(next as PanelDefinitionKind)}>
          <TabsList aria-label={tl.title}>
            <TabsTrigger value="event">{tl.events}</TabsTrigger>
            <TabsTrigger value="property">{tl.properties}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tl.search} aria-label={tl.search} className="h-9 w-56 max-w-full" />
        <div className="flex items-center gap-2">
          <Switch id="weldpanel-lexicon-hidden" checked={showHidden} onCheckedChange={setShowHidden} />
          <Label htmlFor="weldpanel-lexicon-hidden" className="text-sm font-normal">
            {tl.showHidden}
          </Label>
        </div>
        {data?.scannedAt && <span className="ml-auto text-xs text-muted-foreground">{tl.scannedAt.replace('{time}', formatDateTime(data.scannedAt, language))}</span>}
      </div>
      <p className="text-xs text-muted-foreground">{canEdit ? tl.hiddenNote : tl.needsPermission}</p>

      {isLoading && <Skeleton className="h-48 w-full" />}
      {!isLoading && (entries ?? []).length === 0 && <EmptyState icon={BookOpen} title={tl.emptyTitle} description={tl.emptyDescription} />}
      {!isLoading && (entries ?? []).length > 0 && visible.length === 0 && <EmptyState icon={BookOpen} title={tl.noMatches} />}
      {!isLoading && visible.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tl.columns.name}</TableHead>
                <TableHead className="hidden sm:table-cell">{tl.columns.seen}</TableHead>
                <TableHead>{tl.columns.description}</TableHead>
                <TableHead className="text-center">{tl.columns.hidden}</TableHead>
                <TableHead className="text-center">{tl.columns.verified}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((entry) => (
                <LexiconRow key={`${kind}:${entry.name}`} kind={kind} entry={entry} canEdit={canEdit} onChange={(patch) => void change(entry, patch)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function LexiconPage() {
  const { t } = useI18n();
  const tl = t.weldpanel.analytics.lexicon;
  return (
    <AnalyticsPage title={tl.title} description={tl.description}>
      {(project) => <Lexicon key={project.id} projectId={project.id} />}
    </AnalyticsPage>
  );
}
