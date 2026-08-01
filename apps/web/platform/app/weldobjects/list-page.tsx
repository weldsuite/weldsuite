'use client';

import * as React from 'react';
import { Plus, Box } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from '@/lib/router';
import { EntityGrid, type GridColumnDef } from '@/components/entity-grid';
import { customFieldsToGridColumns } from '@/components/custom-fields/to-grid-columns';
import { useCustomFields } from '@/hooks/use-custom-fields';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCustomObjectBySlug,
  useCustomObjectRecords,
  useCreateCustomObjectRecord,
  useUpdateCustomObjectRecord,
  useDeleteCustomObjectRecord,
  type CustomObjectRecord,
} from '@/hooks/queries/use-custom-objects-queries';
import { RecordFormDialog } from './record-form-dialog';

/** Records fetched per page. */
const PAGE_SIZE = 50;

/**
 * WeldObjects record list — generic over every custom object.
 *
 * The grid is the platform's existing `EntityGrid`; the columns come from the
 * object's `custom_field_definitions` via the already-written
 * `customFieldsToGridColumns`. That reuse is the point of storing values in the
 * shared EAV table: a custom object's list gets inline editing, the column
 * picker, per-user column persistence and CSV export without a line of
 * object-specific code.
 *
 * Column visibility persists under `grid_views.grid_name = co_<slug>`, so each
 * object keeps its own layout per user.
 */
export default function CustomObjectListPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t: i18n } = useI18n();
  const t = i18n.weldobjects;

  const slug = (params?.slug as string) ?? '';
  const search = searchParams?.get('search') ?? undefined;

  const { data: object, isLoading: objectLoading } = useCustomObjectBySlug(slug);
  const { data: fieldDefs } = useCustomFields(object?.entityKey, !!object);

  // Accumulated pages. The API returns an opaque cursor; without this the grid
  // only ever showed the first page and every record past it was unreachable.
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [loadedPages, setLoadedPages] = React.useState<CustomObjectRecord[]>([]);

  const {
    data: result,
    isLoading: recordsLoading,
    isFetching,
  } = useCustomObjectRecords(slug, { search, limit: PAGE_SIZE, cursor });

  // A new search (or a different object) invalidates everything accumulated so
  // far — otherwise the previous query's rows stay stacked under the new ones.
  React.useEffect(() => {
    setCursor(undefined);
    setLoadedPages([]);
  }, [search, slug]);

  React.useEffect(() => {
    if (!result) return;
    setLoadedPages((prev) => {
      // First page replaces; subsequent pages append, de-duped by id so a
      // refetch of an already-loaded page can't double rows.
      const base = cursor ? prev : [];
      const seen = new Set(base.map((r) => r.id));
      return [...base, ...result.data.filter((r) => !seen.has(r.id))];
    });
  }, [result, cursor]);

  const createRecord = useCreateCustomObjectRecord(slug);
  const updateRecord = useUpdateCustomObjectRecord(slug);
  const deleteRecord = useDeleteCustomObjectRecord(slug);

  const [createOpen, setCreateOpen] = React.useState(false);

  const records = loadedPages;
  const totalCount = result?.pagination.totalCount ?? 0;
  const hasMore = result?.pagination.hasMore ?? false;

  // The title column is built-in; everything else comes from the object's own
  // field definitions. `getCustomFields` points at `record.fields` rather than a
  // `customFields` blob — the mapper is agnostic about where the map lives.
  const columns = React.useMemo<GridColumnDef<CustomObjectRecord>[]>(() => {
    const titleColumn: GridColumnDef<CustomObjectRecord> = {
      id: 'title',
      name: object?.labelSingular ?? t.list.nameColumn,
      type: 'text',
      width: 260,
      icon: Box,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (record) => record.title ?? '',
    };

    const customColumns = customFieldsToGridColumns<CustomObjectRecord>(fieldDefs, {
      getCustomFields: (record) => record.fields,
      // The API takes `{ fields: { … } }`, not a `customFields` blob.
      buildPatch: (_record, next) => ({ fields: next }),
    }).map((column) => ({
      ...column,
      // Custom fields on a custom object ARE the record, so they're visible by
      // default — unlike custom fields bolted onto a built-in entity, where
      // hiding them preserves existing users' column sets.
      visible: true,
      sortable: true,
    }));

    return [titleColumn, ...customColumns];
  }, [fieldDefs, object?.labelSingular, t.list.nameColumn]);

  if (objectLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!object) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Box className="h-10 w-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t.list.notFoundTitle}</h2>
        <p className="text-sm text-muted-foreground">{t.list.notFoundBody}</p>
      </div>
    );
  }

  const hasFields = (fieldDefs?.length ?? 0) > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">{object.labelPlural}</h1>
          {object.description ? (
            <p className="text-sm text-muted-foreground">{object.description}</p>
          ) : null}
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={!hasFields}>
          <Plus className="mr-2 h-4 w-4" />
          {t.list.create.replace('{object}', object.labelSingular)}
        </Button>
      </div>

      {!hasFields ? (
        // An object with no fields can't hold anything meaningful, and the
        // create form would be empty. Point at the builder instead of showing
        // an empty grid that looks broken.
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Box className="h-10 w-10 text-muted-foreground" />
          <div>
            <h2 className="text-lg font-semibold">{t.list.noFieldsTitle}</h2>
            <p className="text-sm text-muted-foreground">
              {t.list.noFieldsBody.replace('{object}', object.labelSingular)}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => router.push(`/settings/custom-objects/${object.id}`)}
          >
            {t.list.addFields}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <EntityGrid<CustomObjectRecord>
            config={{
              entityName: object.labelSingular,
              entityNamePlural: object.labelPlural,
              // Per-object, per-user column layout.
              gridViewName: object.entityKey,
              columns,
              getEntityId: (record) => record.id,
              getEntityName: (record) => record.title ?? record.id,
              enableInlineEditing: true,
              enableRowSelection: true,
              enableExport: true,
            }}
            actions={{
              onUpdateEntity: async (id, updates) => {
                try {
                  await updateRecord.mutateAsync({
                    id,
                    fields: (updates.fields as Record<string, unknown>) ?? undefined,
                  });
                  return { success: true };
                } catch (err) {
                  const message = err instanceof Error ? err.message : t.errors.updateFailed;
                  toast.error(message);
                  return { success: false, error: message };
                }
              },
              onDeleteEntity: async (id) => {
                try {
                  await deleteRecord.mutateAsync(id);
                  return { success: true };
                } catch (err) {
                  const message = err instanceof Error ? err.message : t.errors.deleteFailed;
                  toast.error(message);
                  return { success: false, error: message };
                }
              },
              onRowClick: (record) => router.push(`/objects/${slug}/${record.id}`),
              onCreateEntity: () => setCreateOpen(true),
            }}
            entities={records}
            searchParams={{ search }}
            pagination={{
              page: 1,
              pageSize: PAGE_SIZE,
              totalCount,
              totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
              hasMore,
            }}
            onLoadMore={() => {
              if (hasMore && result?.pagination.cursor && !isFetching) {
                setCursor(result.pagination.cursor);
              }
            }}
            hasMore={hasMore}
            isFetchingMore={isFetching && !recordsLoading}
          />
        </div>
      )}

      <RecordFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        object={object}
        fields={fieldDefs ?? []}
        onSubmit={async (values) => {
          await createRecord.mutateAsync({ fields: values });
          toast.success(t.list.created.replace('{object}', object.labelSingular));
        }}
      />
    </div>
  );
}
