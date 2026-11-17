/**
 * The header actions of a form: Preview and Publish / Publish changes / Reopen.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import type { DefinitionIssue } from '@weldsuite/forms-engine';
import { useI18n } from '@/lib/i18n/provider';
import { usePublishForm, useReopenForm } from '@/hooks/queries/use-weldforms-queries';
import { PreviewDialog } from '../components/preview-dialog';
import { PublishIssuesDialog } from '../components/publish-issues-dialog';
import { classifyPublishError } from '../lib/autosave';
import { blockIdForIssue } from '../lib/issues';
import { useEffectiveTheme } from '../lib/use-effective-theme';
import { useFormEditor } from './editor-context';

export function FormActions() {
  const { t } = useI18n();
  const router = useRouter();
  const editor = useFormEditor();
  const { form, canEdit } = editor;
  const tf = t.weldforms.actions;

  const publish = usePublishForm();
  const reopen = useReopenForm();
  const { tokens } = useEffectiveTheme(editor.draft.themeId);

  const [previewing, setPreviewing] = useState(false);
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
        {tf.preview}
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

      <PreviewDialog open={previewing} onOpenChange={setPreviewing} definition={editor.definition} theme={tokens} />
      <PublishIssuesDialog
        open={blocked !== null}
        onOpenChange={(open) => !open && setBlocked(null)}
        reason={blocked?.reason ?? 'issues'}
        issues={blocked?.issues ?? []}
        onGoTo={goToIssue}
      />
    </>
  );
}

