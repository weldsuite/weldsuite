/**
 * WeldDesk SLA policy hooks, `/api/slas` (desk-api, served through app-api).
 * The policies are read by the SLA engine (`@weldsuite/db/lib/desk-sla`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateSlaInput,
  Sla,
  SlaBusinessHours,
  SlaCondition,
  SlaReminder,
  SlaTarget,
  UpdateSlaInput,
} from '@weldsuite/core-api-client/schemas/slas';
import { useAppApi } from '@/lib/api/use-app-api';

export type {
  CreateSlaInput,
  SlaBusinessHours as DeskSlaBusinessHours,
  SlaCondition as DeskSlaCondition,
  SlaReminder as DeskSlaReminder,
  SlaTarget as DeskSlaTarget,
  UpdateSlaInput as UpdateDeskSlaInput,
};

export type DeskSlaOperationalHours = 'business' | '24x7' | 'custom';

/** A policy as the settings page reads it: the JSON columns typed. */
export interface DeskSlaPolicy {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  /** The order policies are checked in: lowest first. */
  priority: number;
  conditions: SlaCondition[];
  firstResponseTime: SlaTarget[];
  updateTime: SlaTarget[];
  resolutionTime: SlaTarget[];
  reminders: SlaReminder[];
  operationalHours: DeskSlaOperationalHours;
  businessHours: SlaBusinessHours | null;
}

export const deskSlaKeys = {
  all: ['desk', 'sla-policies'] as const,
  list: () => [...deskSlaKeys.all, 'list'] as const,
};

const PAGE_SIZE = 100;
/** A workspace has a handful of policies; this only stops a runaway cursor. */
const MAX_PAGES = 5;

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toPolicy(row: Sla): DeskSlaPolicy {
  const hours = row.operationalHours;
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    isDefault: row.isDefault === true,
    priority: row.priority ?? 0,
    conditions: asList<SlaCondition>(row.conditions),
    firstResponseTime: asList<SlaTarget>(row.firstResponseTime),
    updateTime: asList<SlaTarget>(row.updateTime),
    resolutionTime: asList<SlaTarget>(row.resolutionTime),
    reminders: asList<SlaReminder>(row.reminders),
    operationalHours: hours === '24x7' || hours === 'custom' ? hours : 'business',
    businessHours: (row.businessHours as SlaBusinessHours | null | undefined) ?? null,
  };
}

/** Every policy, in the order the engine checks them (lowest `priority` first, then oldest). */
export function useDeskSlaPolicies() {
  const api = useAppApi();
  return useQuery({
    queryKey: deskSlaKeys.list(),
    queryFn: async (): Promise<DeskSlaPolicy[]> => {
      const rows: Sla[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await api.slas.list({ limit: PAGE_SIZE, cursor });
        rows.push(...(res.data ?? []));
        cursor = res.pagination?.hasMore ? (res.pagination.cursor ?? undefined) : undefined;
        if (!cursor) break;
      }
      return rows
        .map(toPolicy)
        .sort(
          (a, b) =>
            a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
    },
  });
}

export function useCreateDeskSla() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateSlaInput) => api.slas.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: deskSlaKeys.all }),
  });
}

export function useUpdateDeskSla() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateSlaInput & { id: string }) => api.slas.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: deskSlaKeys.all }),
  });
}

export function useDeleteDeskSla() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.slas.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: deskSlaKeys.all }),
  });
}
