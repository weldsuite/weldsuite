/**
 * The builder shell of one form (`/weldforms/$formId/*`): header with the
 * inline title, status, a failed save, Preview and Publish, a tab bar that links
 * every tab of the form (Create, Logic, Design, Settings here; Integrations,
 * Share and Results are the module's second half), and the editor state the
 * tabs share.
 */

import type { ReactNode } from 'react';
import { useParams } from '@tanstack/react-router';
import { ChevronLeft, CircleAlert } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { isApiError } from '@weldsuite/api-client';
import { InlineTextEditor } from '@/components/shared/inline-text-editor';
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

/** Saving is silent; only a failed save shows, with a retry. */
function SaveIndicator({ state, onRetry }: Readonly<{ state: SaveState; onRetry: () => void }>) {
  const { t } = useI18n();
  if (state !== 'error') return null;
  return (
    <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 text-xs text-destructive hover:underline">
      <CircleAlert className="size-3.5" aria-hidden />
      {t.weldforms.editor.saveFailedRetry}
    </button>
  );
}

function Frame({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const editor = useFormEditor();
  const { form, draft, canEdit } = editor;
  const pathname = usePathname();

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The editor header WeldSign, WeldDocs and WeldSheets have: back, the title renamed in place, its badge. */}
      <header className="flex min-h-[53px] shrink-0 flex-wrap items-center gap-1 border-b px-3 py-2 md:px-4">
        <Button asChild variant="ghost" size="icon" className="size-[30px] shrink-0 text-muted-foreground" aria-label={t.weldforms.shell.backToForms} title={t.weldforms.shell.backToForms}>
          <Link href="/weldforms">
            <ChevronLeft className="!size-[18px]" />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="-ml-[3px] flex min-w-0 max-w-md">
            {canEdit ? (
              <InlineTextEditor
                value={draft.title || t.weldforms.untitled}
                onSave={(next) => {
                  if (next !== '') editor.setTitle(next.slice(0, 255));
                }}
                label={t.weldforms.shell.titleLabel}
                singleLine
                className="mx-0 text-[15px] font-medium leading-6 text-foreground focus:border-primary focus:ring-0"
              />
            ) : (
              <h1 className="truncate pl-[7px] text-[15px] font-medium leading-6 text-foreground">{draft.title || t.weldforms.untitled}</h1>
            )}
          </div>
          <FormStatusBadge status={form.status} hasUnpublishedChanges={form.hasUnpublishedChanges} />
          {canEdit && <SaveIndicator state={editor.saveState} onRetry={() => void editor.flush()} />}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <FormActions />
        </div>
      </header>
      <PageTabs tabs={tabs} activeTab={active} linkComponent={Link} innerClassName="px-3 pt-2 md:px-4" overflow="dropdown" />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

