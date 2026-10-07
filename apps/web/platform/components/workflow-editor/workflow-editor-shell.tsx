import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useBlocker } from '@tanstack/react-router';
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
 * guard (a router blocker + confirm dialog) and the actions portal target, so
 * each page only supplies its own nav bar and the editor itself.
 *
 * Both `nav` and `editor` receive the same `actionsRef` — the nav renders it as
 * the portal target for the editor's Save/Test/Publish buttons, and the editor
 * portals into it via `actionsPortalRef`.
 */
interface WorkflowEditorShellRenderProps {
  /** Portal target for the editor's action buttons; render `<div ref={actionsRef} />` in the nav. */
  actionsRef: RefObject<HTMLDivElement | null>;
  /**
   * Pass to the nav's `onBeforeNavigate`. Always allows the click: the guard
   * now sits on the router itself, so the tabs need no interception of their own.
   */
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

export function WorkflowEditorShell({ nav, editor }: Readonly<WorkflowEditorShellProps>) {
  const t = useTranslations();
  const actionsRef = useRef<HTMLDivElement>(null);
  const [isDirty, setDirty] = useState(false);

  // Every way out of the editor (its own tabs, the app sidebar, breadcrumbs,
  // the browser's back button, a programmatic push) goes through the router,
  // so one blocker covers them all; the tabs alone used to be guarded, and a
  // sidebar click silently dropped the edits. Switching between `?panel=`
  // views of the same page keeps the editor mounted and is not a leave. Tab
  // close / reload is handled by the editor's own `beforeunload` listener.
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => isDirty && current.pathname !== next.pathname,
    withResolver: true,
    enableBeforeUnload: false,
  });
  const isBlocked = blocker.status === 'blocked';

  const onBeforeNavigate = useCallback(() => true, []);

  const renderProps: WorkflowEditorShellRenderProps = { actionsRef, onBeforeNavigate, setDirty };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {nav(renderProps)}
      <div className="flex-1 overflow-hidden">{editor(renderProps)}</div>

      <AlertDialog open={isBlocked} onOpenChange={(open) => { if (!open) blocker.reset?.(); }}>
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
              onClick={() => blocker.proceed?.()}
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
