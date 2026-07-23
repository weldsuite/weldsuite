import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireAdmin } from '@/lib/auth';
import { NewAppForm } from './new-app-form';

export const dynamic = 'force-dynamic';

export default async function NewAppPage() {
  await requireAdmin();
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <Link
          href="/apps"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to App Catalog
        </Link>

        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New app</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Add a new entry to the App Catalog. It will not be visible in the App Store until you
            publish it.
          </p>
        </div>

        <NewAppForm />
      </div>
    </div>
  );
}
