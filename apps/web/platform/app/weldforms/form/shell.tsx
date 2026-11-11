/**
 * The builder shell of one form (`/weldforms/$formId/*`): header with the
 * inline title, status, save state, Preview and Publish, a tab bar that links
 * every tab of the form (Create, Logic, Design, Settings here; Integrations,
 * Share and Results are the module's second half), and the editor state the
 * tabs share.
 */

import { useState, type ReactNode } from 'react';
import { useParams } from '@tanstack/react-router';
import { ArrowLeft, Check, CircleAlert, Loader2, Redo2, Undo2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { isApiError } from '@weldsuite/api-client';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { Link, usePathname } from '@/lib/router';
import { useForm } from '@/hooks/queries/use-weldforms-queries';
import { FormStatusBadge } from '../components/status-badge';
import { FormActions } from './form-actions';
import { FormEditorProvider, useFormEditor, type SaveState } from './editor-context';

export const FORM_TABS = ['edit', 'logic', 'design', 'settings', 'integrations', 'share', 'results'] as const;
export type FormTab = (typeof FORM_TABS)[number];

export default function FormShell({ children }: Readonly<{ children: ReactNode }>) {
  const { formId = '' } = useParams({ strict: false });
  const { t } = useI18n();
  const { data: form, isLoading, error, refetch } = useForm(formId);

  if (isLoading) return <PageLoader />;
  if (error || !form) {
    const notFound = isApiError(error) && error.status === 404;
    return (
      <div className="p-6">
        {notFound ? (
          <EmptyState
            title={t.weldforms.shell.notFoundTitle}
            description={t.weldforms.shell.notFoundDescription}
            action={
              <Button asChild variant="outline">
                <Link href="/weldforms">{t.weldforms.shell.backToForms}</Link>
              </Button>
            }
          />
        ) : (
          <ErrorState message={t.weldforms.loadFailed} onRetry={() => void refetch()} retryLabel={t.common.actions.retry} />
        )}
      </div>
    );
  }

  return (
    <FormEditorProvider form={form}>
      <Frame>{children}</Frame>
    </FormEditorProvider>
  );
}

function SaveIndicator({ state, onRetry }: Readonly<{ state: SaveState; onRetry: () => void }>) {
  const { t } = useI18n();
  const te = t.weldforms.editor;
  if (state === 'error') {
    return (
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 text-xs text-destructive hover:underline">
        <CircleAlert className="size-3.5" aria-hidden />
        {te.saveFailedRetry}
      </button>
    );
  }
  const saving = state !== 'saved';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
      {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
      {saving ? te.saving : te.saved}
    </span>
  );
}

function Frame({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const editor = useFormEditor();
  const { form, draft, canEdit } = editor;
  const pathname = usePathname();
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  useBreadcrumbs(
    [
      { label: t.weldforms.breadcrumb.home, href: '/weldforms' },
      { label: draft.title || t.weldforms.untitled },
    ],
    { enabled: true },
  );

  const base = `/weldforms/${form.id}`;
  const active = FORM_TABS.find((tab) => pathname.startsWith(`${base}/${tab}`)) ?? 'edit';
  const tabs: PageTab[] = FORM_TABS.filter((tab) => {
    if (tab === 'results') return form.permissions.readResponses;
    if (tab === 'integrations') return form.permissions.edit;
    return true;
  }).map((tab) => ({ id: tab, label: t.weldforms.tabs[tab], href: `${base}/${tab}` }));

  const showUndo = active === 'edit' || active === 'logic' || active === 'design' || active === 'settings';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label={t.weldforms.shell.backToForms}>
          <Link href="/weldforms">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <Input
          value={titleDraft ?? draft.title}
          onChange={(event) => {
            setTitleDraft(event.target.value);
            if (event.target.value.trim() !== '') editor.setTitle(event.target.value);
          }}
          onBlur={() => setTitleDraft(null)}
          readOnly={!canEdit}
          maxLength={255}
          aria-label={t.weldforms.shell.titleLabel}
          placeholder={t.weldforms.untitled}
          className="h-8 min-w-40 max-w-sm flex-1 border-transparent bg-transparent text-base font-medium shadow-none hover:border-input focus-visible:border-ring"
        />
        <FormStatusBadge status={form.status} hasUnpublishedChanges={form.hasUnpublishedChanges} />
        {canEdit && <SaveIndicator state={editor.saveState} onRetry={() => void editor.flush()} />}
        <div className="ml-auto flex items-center gap-1.5">
          {canEdit && showUndo && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={editor.undo} disabled={!editor.canUndo} aria-label={t.weldforms.editor.undo}>
                    <Undo2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t.weldforms.editor.undo}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={editor.redo} disabled={!editor.canRedo} aria-label={t.weldforms.editor.redo}>
                    <Redo2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t.weldforms.editor.redo}</TooltipContent>
              </Tooltip>
            </>
          )}
          <FormActions />
        </div>
      </header>
      <PageTabs tabs={tabs} activeTab={active} linkComponent={Link} className="px-4" overflow="dropdown" />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

