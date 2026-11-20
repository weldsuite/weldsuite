/**
 * Lexicon: the event and property names the project has seen, as the standard
 * list (toolbar with the kind switch, a "show hidden" filter and search, a
 * column header, one row per name). Description, hidden and verified are edited
 * in the row.
 */

import { useMemo, useState } from 'react';
import { BookOpen, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelDefinitionKind, PanelLexiconEntry } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Switch } from '@weldsuite/ui/components/switch';
import { PanelEntityList, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/panel-entity-list';
import { useUpdateWeldPanelLexicon, useWeldPanelLexicon } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsListPage } from '../components/analytics-page';
import { formatNumber } from '../lib/format';

type Patch = { description?: string | null; hidden?: boolean; verified?: boolean };
type LexiconItem = PanelLexiconEntry & { id: string };

/** The description saves when the field loses focus, and only when it changed. */
function DescriptionCell({ entry, canEdit, onChange }: Readonly<{ entry: LexiconItem; canEdit: boolean; onChange: (patch: Patch) => void }>) {
  const { t } = useI18n();
  const tl = t.weldpanel.analytics.lexicon;
  const [description, setDescription] = useState(entry.description ?? '');
  const [synced, setSynced] = useState(entry.description ?? '');
  if ((entry.description ?? '') !== synced) {
    setSynced(entry.description ?? '');
    setDescription(entry.description ?? '');
  }
  if (!canEdit) return <span className="block truncate text-sm text-muted-foreground">{entry.description}</span>;
  return (
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
  );
}

function Lexicon({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language } = useI18n();
  const tl = t.weldpanel.analytics.lexicon;
  const canEdit = useCan('panel_reports:update');
  const [kind, setKind] = useState<PanelDefinitionKind>('event');
  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const showHidden = activeFilters.some((f) => f.field === 'hidden' && f.value === 'show');
  const { data, isLoading, isError, refetch } = useWeldPanelLexicon(projectId);
  const update = useUpdateWeldPanelLexicon(projectId);

  const entries = kind === 'event' ? data?.events : data?.properties;
  const visible = useMemo<LexiconItem[]>(() => {
    const needle = search.trim().toLowerCase();
    return (entries ?? [])
      .filter((e) => (showHidden || !e.hidden) && (needle === '' || e.name.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.verified) - Number(a.verified) || (b.count30d ?? 0) - (a.count30d ?? 0) || a.name.localeCompare(b.name))
      .map((e) => ({ ...e, id: `${kind}:${e.name}` }));
  }, [entries, search, showHidden, kind]);

  async function change(entry: PanelLexiconEntry, patch: Patch) {
    try {
      await update.mutateAsync({ kind, name: entry.name, ...patch });
      toast.success(tl.saved);
    } catch {
      toast.error(tl.saveFailed);
    }
  }

  const filters: FilterConfig[] = [{ field: 'hidden', label: tl.columns.hidden, options: [{ value: 'show', label: tl.showHidden }] }];

  const columns: ColumnDef<LexiconItem>[] = [
    {
      id: 'name',
      header: tl.columns.name,
      width: 'flex-1 min-w-[160px]',
      render: (entry) => (
        <span className={entry.hidden ? 'block truncate font-mono text-sm opacity-60' : 'block truncate font-mono text-sm'} title={entry.name}>
          {entry.name}
        </span>
      ),
    },
    {
      id: 'seen',
      header: tl.columns.seen,
      width: 'hidden sm:block sm:w-[140px]',
      render: (entry) => {
        let seenText = tl.notSeen;
        if (entry.seen) {
          seenText = kind === 'event' && entry.count30d !== null ? tl.seenCount.replace('{count}', formatNumber(entry.count30d, language)) : tl.seenProperty;
        }
        return <span className="block truncate whitespace-nowrap text-muted-foreground">{seenText}</span>;
      },
    },
    {
      id: 'description',
      header: tl.columns.description,
      width: 'hidden md:block md:w-[320px]',
      render: (entry) => <DescriptionCell entry={entry} canEdit={canEdit} onChange={(patch) => void change(entry, patch)} />,
    },
    {
      id: 'hidden',
      header: tl.columns.hidden,
      width: 'w-[80px]',
      render: (entry) => <Switch checked={entry.hidden} disabled={!canEdit} onCheckedChange={(hidden) => void change(entry, { hidden })} aria-label={tl.hiddenLabel.replace('{name}', entry.name)} />,
    },
    {
      id: 'verified',
      header: tl.columns.verified,
      width: 'w-[80px]',
      render: (entry) => <Switch checked={entry.verified} disabled={!canEdit} onCheckedChange={(verified) => void change(entry, { verified })} aria-label={tl.verifiedLabel.replace('{name}', entry.name)} />,
    },
  ];

  if (isError) return <ErrorState message={tl.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;
  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  const icon = <BookOpen className="size-8 text-muted-foreground" />;
  return (
    <PanelEntityList<LexiconItem>
      items={visible}
      isLoading={false}
      columns={columns}
      filters={filters}
      activeFilters={activeFilters}
      onFiltersChange={setActiveFilters}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder={tl.search}
      leftActionButtons={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8" aria-label={tl.title}>
              {kind === 'event' ? tl.events : tl.properties}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={kind} onValueChange={(next) => setKind(next as PanelDefinitionKind)}>
              <DropdownMenuRadioItem value="event">{tl.events}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="property">{tl.properties}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      emptyState={{ icon, title: tl.emptyTitle, description: tl.emptyDescription }}
      noResultsState={{ icon, title: tl.noMatches, description: tl.noMatchesDescription }}
    />
  );
}

export default function LexiconPage() {
  const { t } = useI18n();
  return <AnalyticsListPage title={t.weldpanel.analytics.lexicon.title}>{(project) => <Lexicon key={project.id} projectId={project.id} />}</AnalyticsListPage>;
}
