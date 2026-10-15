import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateInvoiceTemplateInput,
  UpdateInvoiceTemplateInput,
} from '@weldsuite/books-domain/invoice-template/schema';
import { accountingApi } from '@/lib/api/domains/weldbooks';

// ============================================================================
// Query Keys
// ============================================================================

/**
 * Invoice templates (the WeldBooks invoice designer). Lists are keyed by
 * accounting entity: a template belongs to one entity and each has its own
 * default. Under `['accounting', 'invoice-templates']` so the realtime sync map
 * and `accountingKeys.all` invalidations reach them.
 */
export const invoiceTemplateKeys = {
  all: ['accounting', 'invoice-templates'] as const,
  lists: () => [...invoiceTemplateKeys.all, 'list'] as const,
  list: (entityId: string) => [...invoiceTemplateKeys.lists(), entityId] as const,
  details: () => [...invoiceTemplateKeys.all, 'detail'] as const,
  detail: (id: string) => [...invoiceTemplateKeys.details(), id] as const,
};

// ============================================================================
// Queries
// ============================================================================

/** The entity's templates, default first, then by name. */
export function useInvoiceTemplates(entityId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: invoiceTemplateKeys.list(entityId ?? ''),
    queryFn: async () => (await accountingApi.listInvoiceTemplates(entityId as string)).data ?? [],
    enabled: Boolean(entityId) && (options.enabled ?? true),
  });
}

export function useInvoiceTemplate(id: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: invoiceTemplateKeys.detail(id ?? ''),
    queryFn: async () => (await accountingApi.getInvoiceTemplate(id as string)).data,
    enabled: Boolean(id) && (options.enabled ?? true),
  });
}

// ============================================================================
// Mutations
// ============================================================================

/** Any write can move the default flag between templates, so every list is refreshed. */
function useInvalidateTemplateLists() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: invoiceTemplateKeys.lists() });
}

export function useCreateInvoiceTemplate() {
  const invalidateLists = useInvalidateTemplateLists();
  return useMutation({
    mutationFn: async (data: CreateInvoiceTemplateInput) => (await accountingApi.createInvoiceTemplate(data)).data,
    onSuccess: () => { invalidateLists(); },
  });
}

export function useUpdateInvoiceTemplate() {
  const qc = useQueryClient();
  const invalidateLists = useInvalidateTemplateLists();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateInvoiceTemplateInput }) =>
      (await accountingApi.updateInvoiceTemplate(id, data)).data,
    onSuccess: (template, { id }) => {
      qc.setQueryData(invoiceTemplateKeys.detail(id), template);
      invalidateLists();
    },
  });
}

export function useDeleteInvoiceTemplate() {
  const qc = useQueryClient();
  const invalidateLists = useInvalidateTemplateLists();
  return useMutation({
    mutationFn: (id: string) => accountingApi.deleteInvoiceTemplate(id),
    onSuccess: (_result, id) => {
      qc.removeQueries({ queryKey: invoiceTemplateKeys.detail(id) });
      invalidateLists();
    },
  });
}

export function useDuplicateInvoiceTemplate() {
  const invalidateLists = useInvalidateTemplateLists();
  return useMutation({
    mutationFn: async (id: string) => (await accountingApi.duplicateInvoiceTemplate(id)).data,
    onSuccess: () => { invalidateLists(); },
  });
}
