/**
 * WeldDesk's priority matrix (impact × urgency → priority),
 * `/api/helpdesk-settings/priority-matrix` (desk-api). The inbox reads the
 * same grid from `GET /api/desk/conversations/attributes`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { deskKeys, type DeskLevel, type DeskPriority, type DeskPriorityMatrix } from './use-desk-queries';

export const deskPriorityMatrixKeys = {
  all: ['desk', 'priority-matrix'] as const,
};

/** The ITIL default the server also falls back to. */
export const DEFAULT_DESK_PRIORITY_MATRIX: DeskPriorityMatrix['matrix'] = {
  low: { low: 'low', medium: 'low', high: 'medium' },
  medium: { low: 'low', medium: 'medium', high: 'high' },
  high: { low: 'medium', medium: 'high', high: 'urgent' },
};

/** The grid's priority for an impact and an urgency; null unless both are set. */
export function priorityFromMatrix(
  matrix: DeskPriorityMatrix['matrix'],
  impact: DeskLevel | null | undefined,
  urgency: DeskLevel | null | undefined,
): DeskPriority | null {
  if (!impact || !urgency) return null;
  return matrix[impact]?.[urgency] ?? null;
}

export function useDeskPriorityMatrix() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskPriorityMatrixKeys.all,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskPriorityMatrix }>('/helpdesk-settings/priority-matrix');
      return res.data;
    },
  });
}

export function useSaveDeskPriorityMatrix() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: DeskPriorityMatrix) => {
      const client = await getClient();
      const res = await client.put<{ data: DeskPriorityMatrix }>('/helpdesk-settings/priority-matrix', data);
      return res.data;
    },
    onSuccess: (saved) => {
      qc.setQueryData(deskPriorityMatrixKeys.all, saved);
      // The inbox's details panel reads the grid with the attribute options.
      void qc.invalidateQueries({ queryKey: deskKeys.attributeOptions() });
    },
  });
}
