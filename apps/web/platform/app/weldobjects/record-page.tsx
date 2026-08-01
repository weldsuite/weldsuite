'use client';

import * as React from 'react';
import { ArrowLeft, Box, Pencil, Trash2, ExternalLink, Unlink } from 'lucide-react';
import { useParams, useRouter, Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Badge } from '@weldsuite/ui/components/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useCustomFields } from '@/hooks/use-custom-fields';
import {
  useCustomObjectBySlug,
  useCustomObjectRecord,
  useUpdateCustomObjectRecord,
  useDeleteCustomObjectRecord,
  useRecordRelatedPanels,
  useDetachRelated,
} from '@/hooks/queries/use-custom-objects-queries';
import { RecordFormDialog } from './record-form-dialog';
import { groupFields } from './field-input';

/** Render one stored value for display. Mirrors the input coercions. */
function displayValue(fieldType: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>;

  switch (fieldType) {
    case 'boolean':
      return value ? '✓' : '—';
    case 'date':
      return typeof value === 'string' ? new Date(value).toLocaleDateString() : String(value);
    case 'multi_select':
      return Array.isArray(value) ? (
        <div className="flex flex-wrap gap-1">
          {value.map((v) => (
            <Badge key={String(v)} variant="secondary">
              {String(v)}
            </Badge>
          ))}
        </div>
      ) : (
        String(value)
      );
    case 'url': {
      // Render an anchor only for http(s). The stored value is arbitrary text —
      // records are writable through the external API and MCP tools, not just
      // the URL input — so `mailto:`, `data:` and protocol-relative `//evil`
      // can all reach this. Anything else renders as inert text.
      const raw = String(value);
      let safe: string | null = null;
      try {
        const parsed = new URL(raw);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') safe = parsed.href;
      } catch {
        safe = null;
      }
      if (!safe) return raw;
      return (
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          {raw}
          <ExternalLink className="h-3 w-3" />
        </a>
      );
    }
    case 'email':
      return (
        <a href={`mailto:${String(value)}`} className="text-primary hover:underline">
          {String(value)}
        </a>
      );
    case 'rating': {
      // `String.repeat` throws RangeError on a negative count, which would take
      // down the whole detail page. The star control only emits 1–5, but the
      // external API and MCP tools can write any number to a rating field.
      const filled = Math.min(5, Math.max(0, Math.round(Number(value) || 0)));
      return '★'.repeat(filled) + '☆'.repeat(5 - filled);
    }
    default:
      return String(value);
  }
}

/**
 * WeldObjects record detail.
 *
 * Field groups come from `custom_field_definitions.group` / `sortOrder`, which
 * are already stored and already editable in the field editor — so there is no
 * separate layout designer to maintain for v1.
 */
export default function CustomObjectRecordPage() {
  const params = useParams();
  const router = useRouter();
  const { t: i18n } = useI18n();
  const t = i18n.weldobjects;

  const slug = (params?.slug as string) ?? '';
  const recordId = (params?.recordId as string) ?? '';

  const { data: object, isLoading: objectLoading } = useCustomObjectBySlug(slug);
  const { data: fieldDefs } = useCustomFields(object?.entityKey, !!object);
  const { data: record, isLoading: recordLoading } = useCustomObjectRecord(slug, recordId);
  const { data: panels } = useRecordRelatedPanels(slug, recordId);

  const updateRecord = useUpdateCustomObjectRecord(slug);
  const deleteRecord = useDeleteCustomObjectRecord(slug);
  const detach = useDetachRelated(slug);

  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const grouped = React.useMemo(() => groupFields(fieldDefs ?? []), [fieldDefs]);

  if (objectLoading || recordLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!object || !record) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Box className="h-10 w-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t.detail.notFoundTitle}</h2>
        <Button variant="outline" onClick={() => router.push(`/objects/${slug}`)}>
          {t.detail.backToList.replace('{objects}', object?.labelPlural ?? '')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push(`/objects/${slug}`)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{record.title ?? record.id}</h1>
            <p className="text-sm text-muted-foreground">{object.labelSingular}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            {t.detail.edit}
          </Button>
          <Button variant="outline" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="mr-2 h-4 w-4" />
            {t.detail.delete}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {grouped.map((group) => (
            <Card key={group.group ?? '__ungrouped__'}>
              <CardHeader>
                <CardTitle className="text-base">{group.group ?? t.detail.details}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {group.fields.map((field) => (
                  <div key={field.id} className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">{field.name}</p>
                    <div className="text-sm">
                      {displayValue(field.fieldType, record.fields[field.slug])}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="space-y-6">
          {(panels ?? [])
            // A panel with no records and no way to add one is noise; keep
            // empty panels only so the user can see the relationship exists.
            .map((panel) => (
              <Card key={panel.linkId}>
                <CardHeader>
                  <CardTitle className="text-base">{panel.label}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {panel.records.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t.detail.noRelated}</p>
                  ) : (
                    panel.records.map((related) => (
                      <div
                        key={related.relationId}
                        className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                      >
                        <Link
                          href={related.href}
                          className="truncate text-sm text-primary hover:underline"
                        >
                          {related.title}
                        </Link>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t.detail.unlink}
                          onClick={async () => {
                            try {
                              await detach.mutateAsync({
                                recordId,
                                linkSlug: panel.linkSlug,
                                targetId: related.id,
                              });
                            } catch (err) {
                              toast.error(
                                err instanceof Error ? err.message : t.errors.unlinkFailed,
                              );
                            }
                          }}
                        >
                          <Unlink className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            ))}
        </div>
      </div>

      <RecordFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        object={object}
        fields={fieldDefs ?? []}
        initialValues={record.fields}
        onSubmit={async (values) => {
          await updateRecord.mutateAsync({ id: recordId, fields: values });
          toast.success(t.detail.saved);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t.detail.deleteTitle.replace('{object}', object.labelSingular)}
        description={t.detail.deleteBody}
        confirmLabel={t.detail.delete}
        variant="destructive"
        onConfirm={async () => {
          try {
            await deleteRecord.mutateAsync(recordId);
            toast.success(t.detail.deleted);
            router.push(`/objects/${slug}`);
          } catch (err) {
            // A `restrict` relationship blocks the delete — surface the API's
            // message, which names the relationships still pointing at it.
            toast.error(err instanceof Error ? err.message : t.errors.deleteFailed);
          }
        }}
      />
    </div>
  );
}
