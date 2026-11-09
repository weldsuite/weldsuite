/**
 * The header actions of a form: Preview, Publish / Publish changes / Reopen and
 * the menu (close, discard changes, duplicate, version history, delete).
 */

import { useState } from 'react';
import { Copy, Eye, History, Lock, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { DefinitionIssue } from '@weldsuite/forms-engine';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCloseForm,
  useDeleteForm,
  useDiscardFormChanges,
  useDuplicateForm,
  usePublishForm,
  useReopenForm,
} from '@/hooks/queries/use-weldforms-queries';
import { PreviewDialog } from '../components/preview-dialog';
import { PublishIssuesDialog } from '../components/publish-issues-dialog';
import { VersionsDialog } from '../components/versions-dialog';
import { classifyPublishError } from '../lib/autosave';
import { blockIdForIssue } from '../lib/issues';
import { useEffectiveTheme } from '../lib/use-effective-theme';
import { useFormEditor } from './editor-context';

type Confirm = 'close' | 'discard' | 'delete' | null;

export function FormActions() {
  const { t } = useI18n();
  const router = useRouter();
  const editor = useFormEditor();
  const { form, canEdit } = editor;
  const tf = t.weldforms.actions;

  const publish = usePublishForm();
  const close = useCloseForm();
  const reopen = useReopenForm();
  const discard = useDiscardFormChanges();
  const duplicate = useDuplicateForm();
  const remove = useDeleteForm();
  const { tokens } = useEffectiveTheme(editor.draft.themeId);

  const [previewing, setPreviewing] = useState(false);
  const [versions, setVersions] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [blocked, setBlocked] = useState<{ reason: 'issues' | 'no_questions'; issues: DefinitionIssue[] } | null>(null);

  const canPublish = form.permissions.publish && canEdit;

  async function onPublish() {
    // The engine's check first: the same rules the server runs.
    if (editor.issues.length > 0) {
      setBlocked({ reason: 'issues', issues: editor.issues });
      return;
    }
    const saved = await editor.flush();
    if (!saved) {
      toast.error(t.weldforms.editor.saveFailed);
      return;
    }
    try {
      const result = await publish.mutateAsync(form.id);
      editor.acceptRevision(result.data.form.revision);
      toast.success(form.status === 'published' ? t.weldforms.publish.changesPublished : t.weldforms.publish.published);
      if (result.data.form.moderation?.state === 'held') toast.warning(t.weldforms.publish.held);
    } catch (err) {
      const failure = classifyPublishError(err);
      if (failure.kind === 'no_questions') setBlocked({ reason: 'no_questions', issues: [] });
      else if (failure.kind === 'invalid') setBlocked({ reason: 'issues', issues: failure.issues.length > 0 ? failure.issues : editor.issues });
      else toast.error(`${t.weldforms.publish.failed}: ${failure.message}`);
    }
  }

  async function onReopen() {
    try {
      editor.acceptRevision((await reopen.mutateAsync(form.id)).data.revision);
      toast.success(tf.reopened);
    } catch {
      toast.error(tf.reopenFailed);
    }
  }

  async function onClose() {
    try {
      editor.acceptRevision((await close.mutateAsync(form.id)).data.revision);
      toast.success(tf.closed);
    } catch {
      toast.error(tf.closeFailed);
    } finally {
      setConfirm(null);
    }
  }

  async function onDiscard() {
    try {
      const result = await discard.mutateAsync(form.id);
      editor.adopt(result.data);
      toast.success(tf.discarded);
    } catch {
      toast.error(tf.discardFailed);
    } finally {
      setConfirm(null);
    }
  }

  async function onDuplicate() {
    try {
      const copy = await duplicate.mutateAsync({ id: form.id, title: `${editor.draft.title} ${tf.copySuffix}` });
      toast.success(tf.duplicated);
      router.push(`/weldforms/${copy.data.id}/edit`);
    } catch {
      toast.error(tf.duplicateFailed);
    }
  }

  async function onDelete() {
    try {
      await remove.mutateAsync(form.id);
      toast.success(tf.deleted);
      router.push('/weldforms');
    } catch {
      toast.error(tf.deleteFailed);
      setConfirm(null);
    }
  }

  function goToIssue(issue: DefinitionIssue) {
    const id = blockIdForIssue(editor.definition, issue);
    if (id) {
      editor.select({ kind: 'block', id });
      router.push(`/weldforms/${form.id}/edit`);
    }
  }

  let publishLabel = tf.publish;
  if (form.status === 'published') publishLabel = form.hasUnpublishedChanges ? tf.publishChanges : tf.published;

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setPreviewing(true)}>
        <Eye className="size-4" />
        <span className="hidden sm:inline">{tf.preview}</span>
      </Button>

      {form.status === 'closed' ? (
        <Button size="sm" onClick={() => void onReopen()} disabled={!canPublish || reopen.isPending}>
          {tf.reopen}
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => void onPublish()}
          disabled={!canPublish || publish.isPending || (form.status === 'published' && !form.hasUnpublishedChanges)}
        >
          {publish.isPending ? tf.publishing : publishLabel}
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t.common.actions.openMenu}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {form.status === 'published' && form.permissions.publish && (
            <DropdownMenuItem onSelect={() => setConfirm('close')}>
              <Lock className="size-4" />
              {tf.closeForm}
            </DropdownMenuItem>
          )}
          {form.status === 'published' && form.hasUnpublishedChanges && canEdit && (
            <DropdownMenuItem onSelect={() => setConfirm('discard')}>
              <RotateCcw className="size-4" />
              {tf.discardChanges}
            </DropdownMenuItem>
          )}
          {form.status !== 'draft' && (
            <DropdownMenuItem onSelect={() => setVersions(true)}>
              <History className="size-4" />
              {tf.versions}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void onDuplicate()}>
            <Copy className="size-4" />
            {tf.duplicate}
          </DropdownMenuItem>
          {form.permissions.delete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm('delete')}>
                <Trash2 className="size-4" />
                {t.common.actions.delete}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <PreviewDialog open={previewing} onOpenChange={setPreviewing} definition={editor.definition} theme={tokens} />
      <VersionsDialog formId={form.id} open={versions} onOpenChange={setVersions} />
      <PublishIssuesDialog
        open={blocked !== null}
        onOpenChange={(open) => !open && setBlocked(null)}
        reason={blocked?.reason ?? 'issues'}
        issues={blocked?.issues ?? []}
        onGoTo={goToIssue}
      />

      <ConfirmDialog
        open={confirm === 'close'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={tf.closeConfirmTitle}
        description={tf.closeConfirmDescription}
        confirmLabel={tf.closeForm}
        onConfirm={onClose}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={tf.discardConfirmTitle}
        description={tf.discardConfirmDescription}
        confirmLabel={tf.discardChanges}
        variant="destructive"
        onConfirm={onDiscard}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={tf.deleteConfirmTitle}
        description={tf.deleteConfirmDescription}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        onConfirm={onDelete}
      />
    </>
  );
}

