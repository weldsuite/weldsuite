import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent } from '@/components/shell/admin-shell';
import type { EditAppPageData } from './data';
import { EditAppPanel } from './edit-app-panel';

export function EditAppPage({ app }: Readonly<EditAppPageData>) {
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
