'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AppForm, type AppFormValues } from '@/components/app-form';
import type { AppCatalogEntry } from '@/lib/apps-data';
import { updateApp, deleteApp } from '@/actions/apps';

function entryToFormValues(app: AppCatalogEntry): AppFormValues {
  return {
    code: app.code,
    name: app.name,
    description: app.description,
    icon: app.icon,
    category: app.category,
    path: app.path,
    overview: app.overview ?? '',
    features: app.features ?? [],
    howItWorks: app.howItWorks ?? [],
    isActive: app.isActive,
    isPublished: app.isPublished,
    sortOrder: app.sortOrder,
    version: app.version ?? '1.0.0',
    provider: app.provider ?? 'WeldSuite',
    verified: app.verified ?? false,
    releasedAt: app.releasedAt ? app.releasedAt.slice(0, 10) : '',
    websiteUrl: app.websiteUrl ?? '',
    documentationUrl: app.documentationUrl ?? '',
    contactUrl: app.contactUrl ?? '',
  };
}

export function EditAppPanel({ app }: { app: AppCatalogEntry }) {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [isSaving, startSave] = useTransition();
  const [isDeleting, startDelete] = useTransition();

  function handleDelete() {
    startDelete(async () => {
      const result = await deleteApp(app.id);
      if (result.ok) {
        toast.success(`Deleted "${app.name}"`);
        router.push('/apps');
      } else {
        toast.error(result.error);
        setShowDelete(false);
      }
    });
  }

  function handleSubmit(values: AppFormValues) {
    setSubmitError(null);
    startSave(async () => {
      const result = await updateApp(app.id, {
        name: values.name,
        description: values.description,
        icon: values.icon,
        category: values.category,
        path: values.path,
        overview: values.overview.trim() || null,
        features: values.features,
        howItWorks: values.howItWorks,
        isActive: values.isActive,
        isPublished: values.isPublished,
        sortOrder: values.sortOrder,
        version: values.version,
        provider: values.provider,
        verified: values.verified,
        releasedAt: values.releasedAt ? new Date(values.releasedAt).toISOString() : null,
        websiteUrl: values.websiteUrl.trim() || null,
        documentationUrl: values.documentationUrl.trim() || null,
        contactUrl: values.contactUrl.trim() || null,
      });
      if (result.ok) {
        toast.success(`Updated "${result.data.name}"`);
        router.refresh();
      } else {
        setSubmitError(result.error);
      }
    });
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Edit app</h1>
          <p className="text-sm text-muted-foreground mt-1 font-mono">{app.code}</p>
        </div>
        <button
          type="button"
          onClick={() => setShowDelete(true)}
          disabled={isDeleting}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm border border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
          Delete app
        </button>
      </div>

      <AppForm
        initial={entryToFormValues(app)}
        isEdit
        submitLabel="Save changes"
        onSubmit={handleSubmit}
        onCancel={() => router.push('/apps')}
        isSubmitting={isSaving}
        errorMessage={submitError}
      />

      {showDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-popover rounded-lg shadow-xl border max-w-md w-full p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Delete &quot;{app.name}&quot;?</h2>
              <p className="text-sm text-muted-foreground mt-1">
                This permanently deletes the catalog entry and any attached screenshots. Workspaces
                that installed this app will keep their data, but the entry will disappear from the
                App Store.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowDelete(false)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-md text-sm hover:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-4 py-2 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
