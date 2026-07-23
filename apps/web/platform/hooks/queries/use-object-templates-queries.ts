import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  ObjectTemplate,
  CreateObjectTemplateInput,
  UpdateObjectTemplateInput,
  ObjectTemplateEntityType,
} from '@weldsuite/app-api-client/schemas/object-templates';

const objectTemplateKeys = {
  all: ['object-templates'] as const,
  byEntity: (entityType?: ObjectTemplateEntityType) =>
    entityType ? (['object-templates', entityType] as const) : (['object-templates'] as const),
  one: (id: string) => ['object-templates', 'one', id] as const,
};

export function useObjectTemplates(entityType?: ObjectTemplateEntityType) {
  const { objectTemplates } = useAppApi();
  return useQuery({
    queryKey: objectTemplateKeys.byEntity(entityType),
    queryFn: async () => {
      const res = await objectTemplates.list({ entityType });
      return res.data as ObjectTemplate[];
    },
  });
}

function useObjectTemplate(id: string, enabled = true) {
  const { objectTemplates } = useAppApi();
  return useQuery({
    queryKey: objectTemplateKeys.one(id),
    queryFn: async () => {
      const res = await objectTemplates.get(id);
      return res.data;
    },
    enabled: !!id && enabled,
  });
}

export function useCreateObjectTemplate() {
  const { objectTemplates } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateObjectTemplateInput) => objectTemplates.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: objectTemplateKeys.all }),
  });
}

export function useUpdateObjectTemplate() {
  const { objectTemplates } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateObjectTemplateInput }) =>
      objectTemplates.update(id, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: objectTemplateKeys.all });
      qc.invalidateQueries({ queryKey: objectTemplateKeys.one(vars.id) });
    },
  });
}

export function useDeleteObjectTemplate() {
  const { objectTemplates } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => objectTemplates.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: objectTemplateKeys.all }),
  });
}
