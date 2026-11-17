/**
 * Annotations: the dialog that adds or edits one, and the dialog that lists a
 * project's annotations (and a report's own). Opened from a time chart
 * (clicking a date adds one there, clicking a marker lists them) and from the
 * builder's "Annotations" button.
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, MoreHorizontal, Plus, StickyNote } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import type { PanelAnnotationDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Label } from '@weldsuite/ui/components/label';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCreateWeldPanelAnnotation,
  useDeleteWeldPanelAnnotation,
  useUpdateWeldPanelAnnotation,
  useWeldPanelAnnotations,
} from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fromLocalInput, toLocalDateTimeInput } from '../lib/date-input';
import { formatDateTime } from '../lib/format';
import { useMembers } from './use-members';

interface AnnotationEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The report open next to the chart: the dialog can pin the annotation to it. */
  reportId?: string | null;
  /** Edit this one; left out: add a new one. */
  annotation?: PanelAnnotationDto | null;
  /** For a new one: when (ISO). Defaults to now. */
  defaultOccurredAt?: string;
}

interface AnnotationFormValues {
  label: string;
  description: string;
  occurredAt: string;
  scope: 'project' | 'report';
}

export function AnnotationEditDialog({ open, onOpenChange, projectId, reportId, annotation, defaultOccurredAt }: Readonly<AnnotationEditDialogProps>) {
  const { t } = useI18n();
  const ta = t.weldpanel.collab.annotations;
  const tc = t.weldpanel.analytics.common;
  const create = useCreateWeldPanelAnnotation();
  const update = useUpdateWeldPanelAnnotation();
  const schema = useMemo(
    () =>
      z.object({
        label: z.string().trim().min(1, ta.labelRequired).max(200),
        description: z.string().max(2000),
        occurredAt: z.string().refine((v) => fromLocalInput(v) !== null, ta.whenRequired),
        scope: z.enum(['project', 'report']),
      }),
    [ta.labelRequired, ta.whenRequired],
  );
  const form = useForm<AnnotationFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { label: '', description: '', occurredAt: '', scope: 'project' },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      label: annotation?.label ?? '',
      description: annotation?.description ?? '',
      occurredAt: toLocalDateTimeInput(annotation?.occurredAt ?? defaultOccurredAt ?? new Date().toISOString()),
      scope: annotation?.reportId ? 'report' : 'project',
    });
  }, [open, form, annotation, defaultOccurredAt]);

  // The report it is pinned to, or the one open here: "only this report" needs one of them.
  const pinnable = annotation?.reportId ?? reportId ?? null;
  const submitting = form.formState.isSubmitting;
  const submit = form.handleSubmit(async (values) => {
    const occurredAt = fromLocalInput(values.occurredAt);
    if (!occurredAt) return;
    const target = values.scope === 'report' ? pinnable : null;
    const description = values.description.trim() === '' ? null : values.description.trim();
    try {
      if (annotation) {
        await update.mutateAsync({ id: annotation.id, label: values.label.trim(), description, occurredAt, reportId: target });
        toast.success(ta.updated);
      } else {
        await create.mutateAsync({ projectId, label: values.label.trim(), description, occurredAt, reportId: target });
        toast.success(ta.created);
      }
      onOpenChange(false);
    } catch {
      toast.error(ta.failed);
    }
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{annotation ? ta.editTitle : ta.addTitle}</DialogTitle>
          <DialogDescription>{ta.listDescription}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} noValidate className="space-y-4">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ta.labelLabel}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={ta.labelPlaceholder} maxLength={200} autoComplete="off" disabled={submitting} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="occurredAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ta.whenLabel}</FormLabel>
                  <FormControl>
                    <Input {...field} type="datetime-local" disabled={submitting} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {ta.descriptionLabel} <span className="text-muted-foreground">({tc.optional})</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={2} maxLength={2000} disabled={submitting} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {pinnable && (
              <FormField
                control={form.control}
                name="scope"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ta.scopeLabel}</FormLabel>
                    <FormControl>
                      <RadioGroup value={field.value} onValueChange={field.onChange} className="gap-2" disabled={submitting}>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="project" id="weldpanel-annotation-scope-project" />
                          <Label htmlFor="weldpanel-annotation-scope-project" className="font-normal">
                            {ta.scopeProject}
                          </Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="report" id="weldpanel-annotation-scope-report" />
                          <Label htmlFor="weldpanel-annotation-scope-report" className="font-normal">
                            {ta.scopeReport}
                          </Label>
                        </div>
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                {tc.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                {annotation ? tc.save : tc.add}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

interface AnnotationsListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  reportId?: string | null;
  /** Only this period (ISO); left out: the most recent annotations of the project. */
  from?: string;
  to?: string;
}

function AnnotationRow({ annotation, canChange, onEdit, onDelete }: Readonly<{ annotation: PanelAnnotationDto; canChange: boolean; onEdit: () => void; onDelete: () => void }>) {
  const { t, language, format } = useI18n();
  const ta = t.weldpanel.collab.annotations;
  const tc = t.weldpanel.analytics.common;
  const { nameOf } = useMembers();
  return (
    <li className="flex items-start gap-3 py-3">
      <StickyNote className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 truncate text-sm font-medium">{annotation.label}</p>
          <SoftBadge tone="neutral">{annotation.reportId ? ta.thisReport : ta.projectWide}</SoftBadge>
        </div>
        {annotation.description && <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{annotation.description}</p>}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {format(ta.byLine, {
            date: formatDateTime(annotation.occurredAt, language),
            name: nameOf(annotation.createdByUserId, { you: tc.ownedByYou, fallback: t.weldpanel.observe.common.unknown }),
          })}
        </p>
      </div>
      {canChange && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={format(ta.actions, { label: annotation.label })}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>{tc.edit}</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
              {tc.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

export function AnnotationsListDialog({ open, onOpenChange, projectId, reportId, from, to }: Readonly<AnnotationsListDialogProps>) {
  const { t, format } = useI18n();
  const ta = t.weldpanel.collab.annotations;
  const tc = t.weldpanel.analytics.common;
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const canManage = useCan('panel_projects:manage');
  const { me } = useMembers(open);
  const params = useMemo(() => ({ projectId, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(reportId ? { reportId } : {}) }), [projectId, from, to, reportId]);
  const { data: annotations, isLoading, isError, refetch } = useWeldPanelAnnotations(params, open);
  const remove = useDeleteWeldPanelAnnotation();
  const [editing, setEditing] = useState<PanelAnnotationDto | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<PanelAnnotationDto | null>(null);
  // Newest first reads best in a list; the API answers in date order for the charts.
  const sorted = useMemo(() => [...(annotations ?? [])].reverse(), [annotations]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{ta.listTitle}</DialogTitle>
            <DialogDescription>{ta.listDescription}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto">
            {isLoading && (
              <div className="grid gap-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            )}
            {isError && (
              <InlineError>
                {ta.loadFailed}{' '}
                <button type="button" className="underline underline-offset-2" onClick={() => void refetch()}>
                  {t.weldpanel.retry}
                </button>
              </InlineError>
            )}
            {!isLoading && !isError && sorted.length === 0 && <EmptyText>{from ? ta.emptyRange : ta.empty}</EmptyText>}
            {sorted.length > 0 && (
              <ul className="divide-y">
                {sorted.map((annotation) => (
                  <AnnotationRow
                    key={annotation.id}
                    annotation={annotation}
                    canChange={canUpdate && (annotation.createdByUserId === me || canManage)}
                    onEdit={() => setEditing(annotation)}
                    onDelete={() => setDeleting(annotation)}
                  />
                ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            {canCreate && (
              <Button type="button" variant="outline" onClick={() => setAdding(true)}>
                <Plus />
                {ta.add}
              </Button>
            )}
            <Button type="button" onClick={() => onOpenChange(false)}>
              {t.common.actions.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AnnotationEditDialog open={adding} onOpenChange={setAdding} projectId={projectId} reportId={reportId} />
      <AnnotationEditDialog open={editing !== null} onOpenChange={(next) => !next && setEditing(null)} projectId={projectId} reportId={reportId} annotation={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={format(ta.deleteTitle, { label: deleting?.label ?? '' })}
        description={ta.deleteDescription}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(ta.deleted);
            setDeleting(null);
          } catch {
            toast.error(ta.deleteFailed);
          }
        }}
      />
    </>
  );
}
