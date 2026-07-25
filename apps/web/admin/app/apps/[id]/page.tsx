import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { requireAdmin } from '@/lib/auth';
import { getAppById } from '@/lib/apps-data';
import { PageBody, PageContent } from '@/components/shell/admin-shell';
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
    <PageContent>
      <PageBody width="narrow" className="space-y-4">
        <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
          <Link href="/apps">
            <ArrowLeft className="h-4 w-4" />
            Back to App Catalog
          </Link>
        </Button>

        <EditAppPanel app={app} />
      </PageBody>
    </PageContent>
  );
}
