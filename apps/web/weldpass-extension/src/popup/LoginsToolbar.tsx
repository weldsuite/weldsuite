/**
 * The logins list's toolbar, built from the platform's own components and
 * laid out like its list toolbar (grid-toolbar.tsx): Sort, then the Filter
 * pills, on the left; the search button on the right, which opens into a
 * field. The field grows leftwards into the free space and stops just after
 * the Filter button: Sort and Filter stay in reach while searching. With many
 * filter pills it keeps a usable width and the row scrolls sideways.
 *
 * - Sort: `DropdownMenu` from @weldsuite/ui, one submenu per field with
 *   Ascending / Descending, and a red "Clear sort", as in the grid toolbar.
 * - Filter: the platform's `FilterPills` (the entity list's), translated.
 * - Search: the platform's search icon button.
 *
 * Typing anywhere in the popup opens the search with that letter, so the
 * popup still searches as soon as it opens, as when the field was always
 * there and focused.
 */

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ArrowDown, ArrowUp, Check, Search, Trash2, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@weldsuite/ui/components/input-group';
import { cn } from '@weldsuite/ui/lib/utils';
import { FilterPills } from '@weldsuite/weldmeet-ui/components/entity-list/filter-pills';
import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import type { FilterPill } from '@weldsuite/app-api-client/schemas/weldpass-items';
import { t, type MessageKey } from '../lib/i18n';
import {
  SORT_FIELDS,
  TOTP_FILTER,
  TOTP_NO,
  TOTP_YES,
  VAULT_FILTER,
  type LoginSort,
  type SortDirection,
  type SortField,
} from '../lib/list-view';

type FilterConfig = ComponentProps<typeof FilterPills>['filterConfigs'][number];

const SORT_FIELD_LABEL: Record<SortField, MessageKey> = {
  name: 'sortFieldName',
  updated: 'sortFieldUpdated',
};

/** The grid toolbar's outline button: Sort, and (in FilterButton) Filter. 10px corners in the popup. */
const TOOLBAR_BUTTON = 'h-8 text-sm px-3 shadow-none text-muted-foreground rounded-[10px]';
const TOOLBAR_BUTTON_ACTIVE =
  'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary dark:border-primary/40 dark:bg-primary/10 dark:hover:bg-primary/15';

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
  /** Enter in the search field. */
  onSubmit: () => void;
  sort: LoginSort | null;
  onSortChange: (sort: LoginSort | null) => void;
  filters: FilterPill[];
  onFiltersChange: (filters: FilterPill[]) => void;
  /** The workspace's vaults, for the vault filter. Empty while loading. */
  vaults: WeldPassVault[];
}

export function LoginsToolbar({
  query,
  onQueryChange,
  onSubmit,
  sort,
  onSortChange,
  filters,
  onFiltersChange,
  vaults,
}: Readonly<Props>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(query !== '');
  const open = searchOpen || query !== '';

  // Type to search.
  useEffect(() => {
    if (open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1 || event.key === ' ') return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Not while typing somewhere else, or moving through a menu.
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]')) {
        return;
      }
      // The logins list is kept mounted, hidden, behind the other popup tabs.
      if (!rootRef.current || rootRef.current.closest('[hidden]')) return;
      event.preventDefault();
      onQueryChange(event.key);
      setSearchOpen(true);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onQueryChange]);

  const filterConfigs: FilterConfig[] = [
    {
      field: VAULT_FILTER,
      label: t('filterVault'),
      options: vaults.map((vault) => ({
        value: vault.id,
        label: vault.kind === 'personal' ? t('personalVault') : vault.name,
      })),
    },
    {
      field: TOTP_FILTER,
      label: t('filterTotp'),
      filterType: 'boolean',
      options: [
        { value: TOTP_YES, label: t('filterYes') },
        { value: TOTP_NO, label: t('filterNo') },
      ],
    },
  ];

  return (
    <div ref={rootRef} className="border-b border-border bg-background py-2.5">
      {/* The row scrolls sideways when many filter pills don't fit, and a scroll
          box also clips vertically: `py-1 -my-1` leaves room for focus rings
          above and below, as the platform's grid toolbar does. */}
      <div className="-my-1 flex w-full items-center gap-2 overflow-x-auto px-3 py-1 [scrollbar-width:none]">
        {/* Left: Sort and the filter pills. They stay while searching. */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Not modal: its scroll lock pads and locks <body>, which in the popup is the whole window. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className={cn(TOOLBAR_BUTTON, sort && TOOLBAR_BUTTON_ACTIVE)}>
                {t('sortButton')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {SORT_FIELDS.map((field) => {
                const active: SortDirection | null = sort?.field === field ? sort.direction : null;
                return (
                  <DropdownMenuSub key={field}>
                    <DropdownMenuSubTrigger className="gap-2">
                      <span>{t(SORT_FIELD_LABEL[field])}</span>
                      {active === 'asc' && <ArrowUp className="h-4 w-4 text-muted-foreground" />}
                      {active === 'desc' && <ArrowDown className="h-4 w-4 text-muted-foreground" />}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => onSortChange({ field, direction: 'asc' })}>
                        <ArrowUp className="h-4 w-4" />
                        <span>{t('sortAscending')}</span>
                        {active === 'asc' && <Check className="ml-auto h-4 w-4" />}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onSortChange({ field, direction: 'desc' })}>
                        <ArrowDown className="h-4 w-4" />
                        <span>{t('sortDescending')}</span>
                        {active === 'desc' && <Check className="ml-auto h-4 w-4" />}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}
              {sort && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onSortChange(null)}
                    className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                  >
                    <Trash2 className="h-4 w-4 text-red-600" />
                    {t('sortClear')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* The Filter (or dashed +) button is FilterPills' only direct button: round it like Sort. */}
          <div className="contents [&>div>button]:rounded-[10px]">
          <FilterPills
            filters={filters}
            filterConfigs={filterConfigs}
            maxFilters={5}
            onFiltersChange={onFiltersChange}
            operatorLabels={{ is: t('filterIs'), 'is not': t('filterIsNot') }}
            labels={{ filter: t('filterButton'), selectCondition: t('filterSelectCondition') }}
          />
          </div>
        </div>

        {/* Right: search, in the rest of the row. */}
        <SearchField
          value={query}
          onChange={onQueryChange}
          onSubmit={onSubmit}
          placeholder={t('searchLabel')}
          clearLabel={t('searchClear')}
          isOpen={open}
          onOpenChange={setSearchOpen}
        />
      </div>
    </div>
  );
}

/**
 * The platform's search icon button (entity-grid's `SearchIconButton`): an
 * outline icon button that opens into a field. Here the field takes the rest
 * of the row, from just after the Filter button to the edge: its slot is
 * right-aligned and the field grows leftwards into it.
 *
 * - Leaving the field empty closes it; with text it stays open.
 * - Escape clears the text, or closes the field when it is already empty.
 * - The × clears the text and keeps the focus in the field.
 */
function SearchField({
  value,
  onChange,
  onSubmit,
  placeholder,
  clearLabel,
  isOpen,
  onOpenChange,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  clearLabel: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Emptied while the focus is elsewhere: there is no blur left to close it on.
  useEffect(() => {
    if (!value && document.activeElement !== inputRef.current) onOpenChange(false);
    // Only when the text changes, so opening (empty, then focused) is untouched.
  }, [value]);

  return (
    // The free part of the row. Open, it keeps a usable width even when many
    // filter pills leave little room (the row then scrolls sideways).
    <div className={cn('flex min-w-0 flex-1 justify-end', isOpen && 'min-w-[140px]')}>
      <div
        className={cn(
          'transition-[width] duration-200 ease-out motion-reduce:transition-none',
          isOpen ? 'w-full' : 'w-8',
        )}
      >
        {isOpen ? (
          // Focused, it shows a darker border rather than the 3px ring, as the platform's search field does.
          <InputGroup className="h-8 rounded-[10px] bg-background has-[[data-slot=input-group-control]:focus-visible]:ring-0">
            <InputGroupAddon className="py-0">
              <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              type="text"
              aria-label={placeholder}
              placeholder={placeholder}
              value={value}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  // Enter fills the first login that belongs on this page.
                  onSubmit();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (value) onChange('');
                  else {
                    onOpenChange(false);
                    inputRef.current?.blur();
                  }
                }
              }}
              onBlur={() => {
                if (!value) onOpenChange(false);
              }}
              className="h-7.5 py-0 text-sm"
            />
            {value && (
              <InputGroupAddon align="inline-end" className="py-0">
                <InputGroupButton
                  size="icon-xs"
                  aria-label={clearLabel}
                  title={clearLabel}
                  // Keep the focus in the field: a blur would otherwise close it.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onChange('');
                    inputRef.current?.focus();
                  }}
                >
                  <X aria-hidden />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        ) : (
          <Button
            variant="outline"
            size="sm"
            aria-label={placeholder}
            title={placeholder}
            className="h-8 w-8 rounded-[10px] p-0 shadow-none"
            onClick={() => onOpenChange(true)}
          >
            <Search className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
