'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { AppForm, emptyAppForm, type AppFormValues } from '@/components/app-form';
import { createApp } from '@/actions/apps';

export function NewAppForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(values: AppFormValues) {
    setError(null);
    startTransition(async () => {
      const result = await createApp({
        ...values,
        overview: values.overview.trim() || null,
        releasedAt: values.releasedAt ? new Date(values.releasedAt).toISOString() : null,
        websiteUrl: values.websiteUrl.trim() || null,
        documentationUrl: values.documentationUrl.trim() || null,
        contactUrl: values.contactUrl.trim() || null,
      });
      if (result.ok) {
        toast.success(`Created "${result.data.name}"`);
        router.push(`/apps/${result.data.id}`);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <AppForm
      initial={emptyAppForm}
      submitLabel="Create app"
      onSubmit={handleSubmit}
      onCancel={() => router.push('/apps')}
      isSubmitting={isPending}
      errorMessage={error}
    />
  );
}
