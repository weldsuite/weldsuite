import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { usePermissions } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';
import { useDebounce } from '@/hooks/use-debounce';
import { useDeleteTemplate, useTemplate, useTemplates } from '@/hooks/queries/use-project-closing-queries';
import { apiMessage } from '@/app/weldflow/project/[projectId]/close/_lib/api-error';
import { CreateProjectForm } from './_components/create-project-form';
import { EditTemplateDialog } from './_components/edit-template-dialog';
import { SaveTemplateDialog } from './_components/save-template-dialog';
import { TemplateGallery } from './_components/template-gallery';
import { TemplatePreview } from './_components/template-preview';

/** Templates: pick one, see what it creates, and start a project from it. */
export default function TemplatesPage() {
  const { t, format } = useI18n();
  const copy = t.flowClosing.templates;
  const { can } = usePermissions();
  const canManage = can('project_templates:manage');
  const canCreate = can('projects:create');

  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 250);
  const list = useTemplates(debounced);
  const templates = list.data;
  const [pickedId, setPickedId] = useState<string | null>(null);
  // The picked template, or the first one while nothing (valid) is picked.
  const selected = templates?.find((template) => template.id === pickedId) ?? templates?.[0] ?? null;
  const detail = useTemplate(selected?.id ?? null);

  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = useDeleteTemplate();

  const confirmDelete = async () => {
    if (!selected) return;
    try {
      await remove.mutateAsync(selected.id);
      toast.success(copy.deleteConfirm.success);
      setPickedId(null);
      setDeleting(false);
    } catch (error) {
      toast.error(apiMessage(error, copy.deleteConfirm.failed));
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-4 px-0 pb-10">
      <div>
        <h1 className="text-xl font-semibold">{copy.title}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">{copy.description}</p>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-[1_1_16rem] md:max-w-[19rem]">
          <TemplateGallery
            templates={templates}
            isLoading={list.isLoading}
            error={list.isError ? list.error : null}
            onRetry={() => void list.refetch()}
            search={search}
            onSearchChange={setSearch}
            selectedId={selected?.id ?? null}
            onSelect={setPickedId}
            canManage={canManage}
            onSaveProject={() => setSaving(true)}
          />
        </div>
        <div className="min-w-0 flex-[999_1_30rem]">
          <TemplatePreview
            summary={selected}
            detail={detail.data}
            isLoading={detail.isLoading}
            isError={detail.isError}
            onRetry={() => void detail.refetch()}
            canManage={canManage}
            onEdit={() => setEditing(true)}
            onDelete={() => setDeleting(true)}
          />
        </div>
        <div className="min-w-0 flex-[1_1_20rem] xl:max-w-[24rem]">
          <CreateProjectForm template={detail.data ?? null} canCreate={canCreate} />
        </div>
      </div>

      <SaveTemplateDialog open={saving} onClose={() => setSaving(false)} onSaved={(template) => setPickedId(template.id)} />
      <EditTemplateDialog template={editing ? selected : null} onClose={() => setEditing(false)} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={selected ? format(copy.deleteConfirm.title, { name: selected.name }) : ''}
        description={copy.deleteConfirm.description}
        confirmLabel={copy.deleteConfirm.confirm}
        cancelLabel={t.flowClosing.shared.cancel}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </div>
  );
}
