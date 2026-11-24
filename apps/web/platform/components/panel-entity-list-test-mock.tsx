/**
 * Stand-in for `@/components/panel-entity-list` (and the dropdown menu its row
 * menus use) in the tests of pages built on it.
 *
 * The real list needs the app shell (virtual scrolling, filter popovers, the
 * object panel host). This one renders what the page hands it: loading, error,
 * the empty state, the groups (or the plain rows), the columns of every row,
 * the row menu inline, a search box over `searchFields` and one button per
 * filter option that run through the page's own `applyFilters`. Use it as the
 * factory of the mocks:
 *
 *   vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
 *   vi.mock('@weldsuite/ui/components/dropdown-menu', () => import('@/components/dropdown-menu-test-mock'));
 *
 * Not a test file itself, and nothing in the app imports it.
 */

import { useState, type ReactNode } from 'react';
import type { ActiveFilter, ColumnDef, FilterConfig, GroupConfig } from '@/components/entity-list';

interface MockProps<T extends { id: string }> {
  items: T[];
  isLoading: boolean;
  error?: Error | null;
  columns: ColumnDef<T>[];
  groups?: GroupConfig<T>[];
  filters?: FilterConfig[];
  applyFilters?: (items: T[], active: ActiveFilter[]) => T[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;
  searchFields?: (keyof T)[];
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  searchPlaceholder?: string;
  rowMenu?: (item: T) => ReactNode;
  onRowClick?: (item: T) => void;
  onEdit?: (item: T) => void;
  onDelete?: (item: T) => void;
  createButton?: { label: string; onClick: () => void };
  actionButtons?: ReactNode;
  leftActionButtons?: ReactNode;
  emptyState: { title: string; description: string; action?: { label: string; onClick: () => void } };
  noResultsState?: { title: string; description: string };
}

/**
 * The page's own `applyFilters` and filter configs of the latest render, for a
 * test that feeds the first what the filter buttons cannot (an empty value, an
 * unknown field) or reads what the second shows. Rows are typed per page, so
 * the test casts them.
 */
export const latest: { applyFilters?: (items: never[], active: ActiveFilter[]) => unknown[]; filters?: FilterConfig[]; onFiltersChange?: (filters: ActiveFilter[]) => void } = {};

export function PanelEntityList<T extends { id: string }>(props: Readonly<MockProps<T>>) {
  latest.applyFilters = props.applyFilters as typeof latest.applyFilters;
  latest.filters = props.filters;
  latest.onFiltersChange = props.onFiltersChange;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<ActiveFilter[]>([]);
  const { items, columns, groups, filters = [], searchFields, rowMenu } = props;

  const searched = query && searchFields
    ? items.filter((item) => searchFields.some((field) => String(item[field] ?? '').toLowerCase().includes(query.toLowerCase())))
    : items;
  const shown = props.applyFilters ? props.applyFilters(searched, active) : searched;

  const renderRow = (item: T) => {
    const menu = rowMenu?.(item) ?? null;
    return (
      <div key={item.id} data-testid={`row-${item.id}`}>
        {props.onRowClick && <button onClick={() => props.onRowClick?.(item)}>{`open ${item.id}`}</button>}
        {columns.map((column) => (
          <div key={column.id} data-column={column.id}>
            {column.render(item, {
              onEdit: () => props.onEdit?.(item),
              onDelete: () => props.onDelete?.(item),
              onDuplicate: () => undefined,
              onUpdate: () => undefined,
            })}
          </div>
        ))}
        {props.onEdit && <button onClick={() => props.onEdit?.(item)}>{`edit ${item.id}`}</button>}
        {props.onDelete && <button onClick={() => props.onDelete?.(item)}>{`delete ${item.id}`}</button>}
        {menu !== null && <div data-testid={`menu-${item.id}`}>{menu}</div>}
      </div>
    );
  };

  let body: ReactNode;
  if (props.isLoading) {
    body = <p>loading</p>;
  } else if (props.error) {
    body = <p role="alert">{props.error.message}</p>;
  } else if (items.length === 0) {
    body = (
      <div data-testid="empty">
        <p>{props.emptyState.title}</p>
        <p>{props.emptyState.description}</p>
        {props.emptyState.action && <button onClick={props.emptyState.action.onClick}>{props.emptyState.action.label}</button>}
      </div>
    );
  } else if (shown.length === 0) {
    body = <p data-testid="no-results">{props.noResultsState?.title ?? 'no results'}</p>;
  } else if (groups) {
    body = [...groups]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((group) => {
        const rows = shown.filter(group.filter);
        if (rows.length === 0) return null;
        return (
          <section key={group.id} aria-label={group.label}>
            <h3>{group.label}</h3>
            {rows.map(renderRow)}
          </section>
        );
      });
  } else {
    body = shown.map(renderRow);
  }

  return (
    <div>
      {props.leftActionButtons}
      {props.actionButtons}
      {props.createButton && <button onClick={props.createButton.onClick}>{props.createButton.label}</button>}
      {(searchFields || props.onSearchChange) && (
        <input
          aria-label="search"
          placeholder={props.searchPlaceholder}
          value={props.searchQuery ?? query}
          onChange={(e) => (props.onSearchChange ? props.onSearchChange(e.target.value) : setQuery(e.target.value))}
        />
      )}
      {filters.map((filter) => (
        <div key={filter.field} role="group" aria-label={`filter ${filter.field}`}>
          {filter.options.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                const next = [{ id: `${filter.field}:${option.value}`, field: filter.field, operator: 'is', value: option.value }];
                setActive(next);
                props.onFiltersChange?.(next);
              }}
            >
              {`${filter.field}=${option.value}`}
            </button>
          ))}
        </div>
      ))}
      {active.length > 0 && <button onClick={() => setActive([])}>clear filters</button>}
      {body}
    </div>
  );
}

export type { ActiveFilter, ColumnDef, FilterConfig, GroupConfig };
