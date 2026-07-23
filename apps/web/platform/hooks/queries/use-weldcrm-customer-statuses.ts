import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { CUSTOMER_STATUS_OPTIONS } from '@/app/settings/weldcrm/customer-statuses/constants';
import type { CustomerStatus } from '@weldsuite/core-api-client/schemas/customer-statuses';
import type {
  CreateCustomerStatusInput,
  UpdateCustomerStatusInput,
} from '@weldsuite/app-api-client/schemas/customer-statuses';

interface DataResponse<T> {
  data: T;
}

const customerStatusKeys = {
  all: ['weldcrm', 'customer-statuses'] as const,
};

export function useCustomerStatusesQuery() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: customerStatusKeys.all,
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CustomerStatus[]>>('/customer-statuses');
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateCustomerStatusMutation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateCustomerStatusInput) => {
      const client = await getClient();
      return client.post<DataResponse<CustomerStatus>>('/customer-statuses', data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: customerStatusKeys.all }),
  });
}

export function useUpdateCustomerStatusMutation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateCustomerStatusInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<CustomerStatus>>(`/customer-statuses/${id}`, data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: customerStatusKeys.all }),
  });
}

export function useDeleteCustomerStatusMutation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/customer-statuses/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: customerStatusKeys.all }),
  });
}

export function useReorderCustomerStatusesMutation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const client = await getClient();
      return client.put<DataResponse<CustomerStatus[]>>('/customer-statuses/reorder', { ids });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: customerStatusKeys.all }),
  });
}

// Color token → Tailwind badge class mapping used across badge renders.
const COLOR_CLASS_MAP: Record<string, string> = {
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  gray: 'bg-gray-100 text-gray-800 dark:bg-background/30 dark:text-muted-foreground',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  zinc: 'bg-zinc-100 text-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-400',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  lime: 'bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-400',
  emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400',
  cyan: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-400',
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-400',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
  fuchsia: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-400',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-400',
  rose: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400',
};

// Swatch class used in the settings page color palette (bg only).
export const COLOR_SWATCH_MAP: Record<string, string> = {
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  gray: 'bg-gray-400',
  red: 'bg-red-500',
  zinc: 'bg-zinc-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  yellow: 'bg-yellow-500',
  lime: 'bg-lime-500',
  emerald: 'bg-emerald-500',
  teal: 'bg-teal-500',
  cyan: 'bg-cyan-500',
  sky: 'bg-sky-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  purple: 'bg-purple-500',
  fuchsia: 'bg-fuchsia-500',
  pink: 'bg-pink-500',
  rose: 'bg-rose-500',
};

export const COLOR_OPTIONS = Object.keys(COLOR_SWATCH_MAP);

// Per-color { color, bg } pair for the inline-edit single-select cell in the
// customers grid (matches the StatusStyle shape from @/components/entity-grid).
export const STATUS_STYLE_MAP: Record<string, { color: string; bg: string }> = {
  blue: { color: 'text-blue-700 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  green: { color: 'text-green-700 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-950' },
  gray: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  red: { color: 'text-red-700 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  zinc: { color: 'text-zinc-700 dark:text-zinc-400', bg: 'bg-zinc-50 dark:bg-zinc-950' },
  orange: { color: 'text-orange-700 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
  amber: { color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
  yellow: { color: 'text-yellow-700 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-950' },
  lime: { color: 'text-lime-700 dark:text-lime-400', bg: 'bg-lime-50 dark:bg-lime-950' },
  emerald: { color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  teal: { color: 'text-teal-700 dark:text-teal-400', bg: 'bg-teal-50 dark:bg-teal-950' },
  cyan: { color: 'text-cyan-700 dark:text-cyan-400', bg: 'bg-cyan-50 dark:bg-cyan-950' },
  sky: { color: 'text-sky-700 dark:text-sky-400', bg: 'bg-sky-50 dark:bg-sky-950' },
  indigo: { color: 'text-indigo-700 dark:text-indigo-400', bg: 'bg-indigo-50 dark:bg-indigo-950' },
  violet: { color: 'text-violet-700 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-950' },
  purple: { color: 'text-purple-700 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
  fuchsia: { color: 'text-fuchsia-700 dark:text-fuchsia-400', bg: 'bg-fuchsia-50 dark:bg-fuchsia-950' },
  pink: { color: 'text-pink-700 dark:text-pink-400', bg: 'bg-pink-50 dark:bg-pink-950' },
  rose: { color: 'text-rose-700 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-950' },
};

interface MergedStatusOption {
  value: string;
  label: string;
  color: string;
  badgeClass: string;
  isBuiltIn: boolean;
}

/** Returns built-ins (fixed order) + custom statuses (by sortOrder) as one array. */
function useMergedCustomerStatusOptions(): MergedStatusOption[] {
  const { data } = useCustomerStatusesQuery();
  const customStatuses = data?.data ?? [];

  const builtIns: MergedStatusOption[] = CUSTOMER_STATUS_OPTIONS.map((opt) => ({
    value: opt.value,
    label: opt.label,
    color: opt.color,
    badgeClass: COLOR_CLASS_MAP[opt.color] ?? COLOR_CLASS_MAP.gray,
    isBuiltIn: true,
  }));

  const customs: MergedStatusOption[] = [...customStatuses]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({
      value: s.slug,
      label: s.name,
      color: s.color,
      badgeClass: COLOR_CLASS_MAP[s.color] ?? COLOR_CLASS_MAP.gray,
      isBuiltIn: false,
    }));

  return [...builtIns, ...customs];
}

/**
 * Returns label + badgeClass for a status value.
 * Falls back gracefully for unknown / soft-deleted custom statuses.
 */
function useCustomerStatusDisplay(value: string): { label: string; badgeClass: string } {
  const options = useMergedCustomerStatusOptions();
  const match = options.find((o) => o.value === value);
  if (match) return { label: match.label, badgeClass: match.badgeClass };
  return { label: value, badgeClass: COLOR_CLASS_MAP.gray };
}
