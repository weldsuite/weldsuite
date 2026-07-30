import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
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