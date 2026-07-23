import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useRouter } from '@/lib/router';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';

/**
 * Shared page chrome for the workflow editor, used by both the WeldConnect
 * workflow editor and the WeldCRM sequence editor. Owns the unsaved-changes
 * guard (the navigation interceptor + confirm dialog) and the actions portal
 * target, so each page only supplies its own nav bar and the editor itself.
 *
 * Both `nav` and `editor` receive the same `actionsRef` — the nav renders it as
 * the portal target for the editor's Save/Test/Publish buttons, and the editor
 * portals into it via `actionsPortalRef`.
 */
interface WorkflowEditorShellRenderProps {
  /** Portal target for the editor's action buttons; render `<div ref={actionsRef} />` in the nav. */
  actionsRef: RefObject<HTMLDivElement | null>;
  /** Pass to the nav's `onBeforeNavigate` — returns false (and shows the guard) when there are unsaved changes. */
  onBeforeNavigate: (href: string) => boolean;
  /** Wire to the editor's `onDirtyChange`. */
  setDirty: (dirty: boolean) => void;
}

export interface WorkflowEditorShellProps {
  /** Render the nav bar (e.g. EditorWizardNav / SequenceWizardNav). */
  nav: (props: WorkflowEditorShellRenderProps) => ReactNode;
  /** Render the editor (WorkflowEditorClient or a wrapper). */
  editor: (props: WorkflowEditorShellRenderProps) => ReactNode;
}

export function WorkflowEditorShell({ nav, editor }: WorkflowEditorShellProps) {
  const t = useTranslations();
  const router = useRouter();
  const actionsRef = useRef<HTMLDivElement>(null);
  const [isDirty, setDirty] = useState(false);
  const [pendingNavHref, setPendingNavHref] = useState<string | null>(null);

  const onBeforeNavigate = useCallback(
    (href: string) => {
      if (isDirty) {
        setPendingNavHref(href);
        return false;
      }
      return true;
    },
    [isDirty],
  );

  const handleDiscardAndNavigate = () => {
    const href = pendingNavHref;
    setPendingNavHref(null);
    if (href) router.push(href);
  };

  const renderProps: WorkflowEditorShellRenderProps = { actionsRef, onBeforeNavigate, setDirty };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {nav(renderProps)}
      <div className="flex-1 overflow-hidden">{editor(renderProps)}</div>

      <AlertDialog open={!!pendingNavHref} onOpenChange={(open) => { if (!open) setPendingNavHref(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sweep.weldflow.editorShell.unsavedChangesTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('sweep.weldflow.editorShell.unsavedChangesDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              className="bg-background text-foreground border border-input hover:bg-destructive/10 hover:text-destructive hover:border-destructive/15"
              onClick={handleDiscardAndNavigate}
            >
              {t('sweep.weldflow.editorShell.discardChanges')}
            </AlertDialogAction>
            <AlertDialogCancel className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground border-primary">
              {t('sweep.weldflow.cancel')}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
