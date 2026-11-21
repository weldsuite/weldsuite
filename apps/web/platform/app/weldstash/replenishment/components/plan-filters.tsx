import {
  PLAN_CONFIDENCES,
  PLAN_REVIEW_STATUSES,
  PLAN_URGENCIES,
  type ListPlansQuery,
  type PlanConfidence,
  type PlanReviewStatus,
  type PlanUrgency,
} from '@weldsuite/app-api-client/schemas/replenishment';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { getTranslations } from '@/lib/i18n';
import { useWeldstashSuppliers, useWeldstashWarehouses } from '@/hooks/queries/use-weldstash-queries';

export interface PlanFilterState {
  search: string;
  supplierId?: string;
  warehouseId?: string;
  urgency?: PlanUrgency;
  confidence?: PlanConfidence;
  status?: PlanReviewStatus;
}

export const EMPTY_PLAN_FILTERS: PlanFilterState = { search: '' };

/** The list query for a filter state; the caller passes the (debounced) search text. */
export function planFilterQuery(state: PlanFilterState, search: string): Omit<ListPlansQuery, 'cursor' | 'limit'> {
  return {
    ...(search ? { search } : {}),
    ...(state.supplierId ? { supplierId: state.supplierId } : {}),
    ...(state.warehouseId ? { warehouseId: state.warehouseId } : {}),
    ...(state.urgency ? { urgency: state.urgency } : {}),
    ...(state.confidence ? { confidence: state.confidence } : {}),
    ...(state.status ? { status: state.status } : {}),
  };
}

interface PlanFiltersProps {
  state: PlanFilterState;
  onChange: (next: PlanFilterState) => void;
  /** Also offer the review status filter (the All items tab). */
  showStatus?: boolean;
}

export function PlanFilters({ state, onChange, showStatus = false }: Readonly<PlanFiltersProps>) {
  const t = getTranslations('weldstashReplenishment').filters;
  const suppliers = useWeldstashSuppliers({ limit: 100 });
  const warehouses = useWeldstashWarehouses({ limit: 100 });
  const patch = (partial: Partial<PlanFilterState>) => onChange({ ...state, ...partial });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchInput
        className="w-56"
        value={state.search}
        onChange={(e) => patch({ search: e.target.value })}
        placeholder={t.search}
        aria-label={t.search}
      />
      <FilterSelect
        value={state.supplierId}
        onChange={(supplierId) => patch({ supplierId })}
        allLabel={t.allSuppliers}
        ariaLabel={t.supplier}
        options={(suppliers.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
      />
      <FilterSelect
        value={state.warehouseId}
        onChange={(warehouseId) => patch({ warehouseId })}
        allLabel={t.allWarehouses}
        ariaLabel={t.warehouse}
        options={(warehouses.data?.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
      />
      <FilterSelect
        value={state.urgency}
        onChange={(urgency) => patch({ urgency: urgency as PlanUrgency | undefined })}
        allLabel={t.allUrgencies}
        ariaLabel={t.urgency}
        options={PLAN_URGENCIES.map((u) => ({ value: u, label: t.urgencies[u] }))}
      />
      <FilterSelect
        value={state.confidence}
        onChange={(confidence) => patch({ confidence: confidence as PlanConfidence | undefined })}
        allLabel={t.allConfidences}
        ariaLabel={t.confidence}
        options={PLAN_CONFIDENCES.map((c) => ({ value: c, label: t.confidences[c] }))}
      />
      {showStatus && (
        <FilterSelect
          value={state.status}
          onChange={(status) => patch({ status: status as PlanReviewStatus | undefined })}
          allLabel={t.allStatuses}
          ariaLabel={t.status}
          options={PLAN_REVIEW_STATUSES.map((s) => ({ value: s, label: t.statuses[s] }))}
        />
      )}
    </div>
  );
}
