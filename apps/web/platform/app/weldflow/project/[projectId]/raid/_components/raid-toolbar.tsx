import { Button } from '@weldsuite/ui/components/button';
import { ListToolbar, type FilterConfig } from '@weldsuite/ui/components/list-toolbar';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import type { RaidItem, RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import { useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { categoryLabel, statusLabel } from '../_lib/copy';
import {
  FILTER_FIELDS,
  NO_OWNER,
  RAID_KINDS,
  RAID_KIND_PATHS,
  SHOWS_CLOSED_ALWAYS,
  categoriesIn,
  itemsOfKind,
  ownerIdsOf,
  statusesOf,
} from '../_lib/raid';
import { isOpenItem } from '../_lib/risk';
import { useRaid } from './raid-context';

/** Items a sub-tab counts: open risks, issues and dependencies; every assumption (validated and wrong ones stay listed). */
function tabCount(items: readonly RaidItem[], kind: RaidKind): number {
  const ofKind = itemsOfKind(items, kind);
  return SHOWS_CLOSED_ALWAYS[kind] ? ofKind.length : ofKind.filter(isOpenItem).length;
}

/** Risks, Assumptions, Issues, Dependencies: a segmented switch, where My tasks has its view switch. */
function RaidSubTabs() {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const router = useRouter();
  const { projectId, items, isLoading, isError, activeKind } = useRaid();
  const basePath = `/weldflow/project/${projectId}/raid`;
  const loaded = !isLoading && !isError;
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={activeKind}
      onValueChange={(kind) => {
        if (kind) router.push(`${basePath}${RAID_KIND_PATHS[kind as RaidKind]}`);
      }}
      aria-label={copy.subNavLabel}
      className="shadow-none"
    >
      {RAID_KINDS.map((kind) => (
        <ToggleGroupItem
          key={kind}
          value={kind}
          className="h-8 flex-none gap-1.5 px-3 font-normal text-muted-foreground dark:bg-input/30 data-[state=on]:font-medium dark:data-[state=on]:bg-input/50"
        >
          {copy.tabs[kind]}
          {loaded ? <span className="tabular-nums text-muted-foreground">{tabCount(items, kind)}</span> : null}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * The top bar of the RAID tab, the standard list toolbar: the Filter button
 * and the sub-tabs on the left; search, the closed toggle and "New ..." on the
 * right. It acts on the sub-tab on screen, whose filters live in the RAID layout.
 */
export function RaidToolbar() {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const { items, activeKind: kind, memberOf, abilities, openCreate, filters, setFilters, showClosed, toggleShowClosed } = useRaid();

  const all = itemsOfKind(items, kind);
  const closedCount = all.filter((item) => !isOpenItem(item)).length;
  // Only risks are filtered by category, as before the toolbar moved into the bar.
  const categories = kind === 'risk' ? categoriesIn(all) : [];

  const filterConfigs: FilterConfig[] = [
    {
      field: FILTER_FIELDS.status,
      label: copy.toolbar.status,
      options: statusesOf(kind).map((status) => ({ value: status, label: statusLabel(copy, kind, status) })),
    },
    {
      field: FILTER_FIELDS.owner,
      label: copy.toolbar.owner,
      searchable: true,
      options: [
        ...(all.some((item) => !item.ownerId) ? [{ value: NO_OWNER, label: copy.toolbar.unassigned }] : []),
        ...ownerIdsOf(all).map((id) => ({ value: id, label: memberOf(id)?.name ?? copy.register.unknownOwner })),
      ],
    },
    ...(categories.length > 0
      ? [
          {
            field: FILTER_FIELDS.category,
            label: copy.toolbar.category,
            options: categories.map((category) => ({ value: category, label: categoryLabel(copy, category) ?? category })),
          },
        ]
      : []),
  ];

  const closedToggle =
    !SHOWS_CLOSED_ALWAYS[kind] && closedCount > 0 ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-pressed={showClosed}
        onClick={toggleShowClosed}
        className={cn('h-8 px-3 text-sm shadow-none', showClosed ? 'bg-accent text-accent-foreground dark:bg-input/50' : 'text-muted-foreground')}
      >
        {format(showClosed ? copy.toolbar.hideClosed : copy.toolbar.showClosed, { count: closedCount })}
      </Button>
    ) : null;

  return (
    <>
      <ListToolbar
        filterConfigs={filterConfigs}
        filters={filters.filters}
        onFiltersChange={(next) => setFilters({ ...filters, filters: next })}
        search={filters.search}
        onSearchChange={(search) => setFilters({ ...filters, search })}
        searchPlaceholder={copy.toolbar.search[kind]}
        leftActionButtons={<RaidSubTabs />}
        actionButtons={closedToggle}
        createButton={abilities.create ? { label: copy.newItem[kind], onClick: () => openCreate(kind) } : undefined}
        className="shrink-0 pt-2 pb-2"
      />
      {/* The bar keeps its left side for wider screens; on a phone the sub-tabs get a row of their own. */}
      <div className="shrink-0 overflow-x-auto border-b border-border px-3 py-2 md:hidden">
        <RaidSubTabs />
      </div>
    </>
  );
}
