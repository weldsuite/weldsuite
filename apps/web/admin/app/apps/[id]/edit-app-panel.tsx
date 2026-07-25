'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { AppForm, type AppFormValues } from '@/components/app-form';
import { PageHeading } from '@/components/shell/admin-shell';
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
      <PageHeading
        title="Edit app"
        description={<span className="font-mono text-sm">{app.code}</span>}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowDelete(true)}
            disabled={isDeleting}
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete app
          </Button>
        }
      />

      <AppForm
        initial={entryToFormValues(app)}
        isEdit
        submitLabel="Save changes"
        onSubmit={handleSubmit}
        onCancel={() => router.push('/apps')}
        isSubmitting={isSaving}
        errorMessage={submitError}
      />

      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &quot;{app.name}&quot;?</DialogTitle>
            <DialogDescription>
              This permanently deletes the catalog entry and any attached screenshots. Workspaces
              that installed this app will keep their data, but the entry will disappear from the
              App Store.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={isDeleting} onClick={() => setShowDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={isDeleting} onClick={handleDelete}>
              {isDeleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
