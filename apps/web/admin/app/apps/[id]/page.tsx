import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireAdmin } from '@/lib/auth';
import { getAppById } from '@/lib/apps-data';
import { EditAppPanel } from './edit-app-panel';

export const dynamic = 'force-dynamic';

export default async function EditAppPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await props.params;
  const app = await getAppById(id);
  if (!app) notFound();

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

        <EditAppPanel app={app} />
      </div>
    </div>
  );
}
